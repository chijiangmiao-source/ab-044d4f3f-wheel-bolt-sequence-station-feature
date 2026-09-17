import express from 'express';

import { pool } from './db.js';
import {
  POSITIONS,
  TOTAL_STEPS,
  TORQUE_MIN,
  TORQUE_MAX,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  CANCEL_REASON_MIN_LENGTH,
  CANCEL_REASON_MAX_LENGTH,
  WORK_ORDER_CODE_MIN_LENGTH,
  WORK_ORDER_CODE_MAX_LENGTH,
} from './constants.js';
import {
  UNIT_CNM,
  UNIT_NM,
  INPUT_UNITS,
  DEFAULT_UNIT,
  NM_MAX_DECIMALS,
  readTorqueToken,
  convertNmToCnm,
} from './torque.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 业务错误：携带 HTTP 状态码、机器可读 code、中文原因及附加信息（如权威进度）。 */
class ApiError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * 规范化工单码：去除首尾空白。非法时抛 400 invalid_work_order_code，
 * message 为可直接展示的中文原因。
 */
function normalizeWorkOrderCode(raw) {
  if (typeof raw !== 'string') {
    throw new ApiError(400, 'invalid_work_order_code', '工单码必须为字符串');
  }
  const code = raw.trim();
  if (code.length < WORK_ORDER_CODE_MIN_LENGTH) {
    throw new ApiError(400, 'invalid_work_order_code', '工单码不能为空');
  }
  if (code.length > WORK_ORDER_CODE_MAX_LENGTH) {
    throw new ApiError(
      400,
      'invalid_work_order_code',
      `工单码长度不能超过 ${WORK_ORDER_CODE_MAX_LENGTH} 个字符`,
    );
  }
  return code;
}

function confirmationView(row) {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    sequence: row.sequence,
    position: row.position,
    // 标准扭矩（整数 cN·m）：现有进度与完成明细继续使用
    torque: row.torque,
    // 原始读数与录入单位：仅作记录，历史明细仍按 cN·m 展示
    torque_input: row.torque_input,
    torque_unit: row.torque_unit,
    idempotency_key: row.idempotency_key,
    confirmed_at: row.confirmed_at,
    // 会话明细只列有效记录（恒为 false）；幂等重放若命中已撤回的原事件，
    // 该字段为 true，客户端可据此知道该键对应的确认已被撤回。
    retracted: row.retraction_id != null,
  };
}

/**
 * 撤回审计视图：由撤回事件联表被撤回的原确认得到。
 * confirmations 只暴露未撤回记录，撤回痕迹通过该结构单独返回。
 */
function retractionView(row) {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    sequence: row.sequence,
    position: row.position,
    torque: row.torque,
    torque_input: row.torque_input,
    torque_unit: row.torque_unit,
    confirmation_id: Number(row.confirmation_id),
    idempotency_key: row.idempotency_key,
    confirmed_at: row.confirmed_at,
    retracted_at: row.retracted_at,
  };
}

/** 只计入未撤回（有效）确认；被撤回的事件保留在表中仅供审计。 */
const ACTIVE_CONFIRMATIONS_SQL =
  'SELECT * FROM confirmations WHERE session_id = $1 AND retraction_id IS NULL ORDER BY sequence';

/** 会话的全部撤回审计事件（按发生顺序）。 */
const RETRACTIONS_SQL = `
  SELECT r.id, r.session_id, r.confirmation_id, r.sequence, r.retracted_at,
         c.position, c.torque, c.torque_input, c.torque_unit,
         c.idempotency_key, c.confirmed_at
  FROM retractions r
  JOIN confirmations c ON c.id = r.confirmation_id
  WHERE r.session_id = $1
  ORDER BY r.id`;

/** 由会话行推导的权威进度。 */
function progressOf(session) {
  const finished = session.status !== 'in_progress';
  const progress = {
    status: session.status,
    confirmed_count: session.expected_sequence - 1,
    expected_sequence: finished ? null : session.expected_sequence,
    expected_position: finished ? null : POSITIONS[session.expected_sequence - 1],
  };
  // 终止信息仅在已终止会话上出现，进行中/已完成响应保持原格式不变
  if (session.status === 'cancelled') {
    progress.cancel_reason = session.cancel_reason;
    progress.cancelled_at = session.cancelled_at;
  }
  return progress;
}

function sessionView(session, confirmations, retractions = []) {
  return {
    session_id: session.id,
    work_order_code: session.work_order_code ?? null,
    created_at: session.created_at,
    positions: POSITIONS,
    torque_range: { min: TORQUE_MIN, max: TORQUE_MAX, unit: 'cN·m' },
    input_units: INPUT_UNITS,
    default_unit: DEFAULT_UNIT,
    nm_max_decimals: NM_MAX_DECIMALS,
    ...progressOf(session),
    confirmations: confirmations.map(confirmationView),
    // 撤回审计信息：只追加不改写，旧客户端不读取该字段也不受影响
    retractions: retractions.map(retractionView),
  };
}

/** 由会话行取出会话视图所需字段（含工单码）。 */
const SESSION_FIELDS =
  'id, status, expected_sequence, work_order_code, cancel_reason, cancelled_at, created_at';

/**
 * 在事务内按工单码读取或创建会话：已绑定则返回原会话（200），
 * 未绑定则创建并绑定（201）。
 *
 * 并发首次打开由唯一约束保证只会产生一行：INSERT 使用
 * ON CONFLICT DO NOTHING，冲突者等待赢家提交后得到 0 行，再行锁读取该会话。
 */
async function openWorkOrderSession(client, code) {
  const inserted = await client.query(
    `INSERT INTO sessions (work_order_code) VALUES ($1)
     ON CONFLICT (work_order_code) DO NOTHING
     RETURNING ${SESSION_FIELDS}`,
    [code],
  );
  if (inserted.rowCount > 0) {
    return { created: true, session: inserted.rows[0] };
  }
  // 唯一约束冲突（含并发赢家刚提交的行）：行锁读取已绑定会话
  const existing = await client.query(
    `SELECT ${SESSION_FIELDS} FROM sessions WHERE work_order_code = $1 FOR UPDATE`,
    [code],
  );
  if (existing.rowCount === 0) {
    // 理论不可达：冲突必然来自已存在的工单码行
    throw new Error('工单码会话在冲突后消失');
  }
  return { created: false, session: existing.rows[0] };
}

/**
 * 解析确认请求中的读数与单位，精确换算为整数 cN·m。
 * 单位缺省视为 cN·m（旧格式客户端语义不变）；N·m 读数最多两位小数。
 * torque 接受 JSON 数字或十进制文本字符串（页面按录入原文发送以保真，如 42.00）。
 * @returns {{cnm:number, inputText:string, unit:string}}
 */
function parseTorque(body, rawBody) {
  const unit = body.unit === undefined ? DEFAULT_UNIT : body.unit;
  if (typeof unit !== 'string' || !INPUT_UNITS.includes(unit)) {
    throw new ApiError(
      400,
      'invalid_body',
      `unit 必须为单位之一：${INPUT_UNITS.join('、')}；不传则按 cN·m 处理`,
    );
  }

  // 数字取请求体原文（避免浮点），字符串取其文本；两种来源都用 BigInt 精确处理
  const tokenInfo = readTorqueToken(rawBody);
  let token;
  let source;
  if (tokenInfo && tokenInfo.kind === 'number') {
    token = tokenInfo.token;
    source = 'number';
  } else if (typeof body.torque === 'string') {
    token = body.torque.trim();
    source = 'string';
  } else {
    throw new ApiError(
      400,
      'invalid_body',
      unit === UNIT_CNM
        ? 'torque 必须为整数（单位 cN·m）'
        : `torque 必须为数字（单位 N·m，最多 ${NM_MAX_DECIMALS} 位小数）`,
    );
  }

  if (unit === UNIT_CNM) {
    // 旧语义：读数必须为整数（cN·m），不允许有效小数；4500.00 等纯零小数视为整数 4500
    const m = /^-?(?:0|[1-9]\d*)(?:\.0+)?$/.exec(token);
    if (!m) {
      throw new ApiError(400, 'invalid_body', 'torque 必须为整数（单位 cN·m）');
    }
    const cnm = Number(token.replace(/\.\d+$/, ''));
    if (!Number.isSafeInteger(cnm)) {
      throw new ApiError(400, 'invalid_body', 'torque 必须为整数（单位 cN·m）');
    }
    return { cnm, inputText: String(cnm), unit };
  }

  const result = convertNmToCnm(token);
  if (!result.ok) {
    if (result.reason === 'precision') {
      throw new ApiError(
        422,
        'torque_precision_exceeded',
        `N·m 读数 ${token} 超过 ${NM_MAX_DECIMALS} 位小数，无法精确换算为整数 cN·m，未推进`,
      );
    }
    // 文本不是合法十进制 → 请求体非法；合法数字但数值过大 → 无法精确换算
    if (source === 'string' && !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) {
      throw new ApiError(
        400,
        'invalid_body',
        `N·m 读数 ${token} 不是合法的十进制数字`,
      );
    }
    throw new ApiError(
      422,
      'torque_unconvertible',
      `N·m 读数 ${token} 无法精确换算为整数 cN·m，未推进`,
    );
  }
  // 原始读数保真：普通十进制文本原样保存；科学计数法规范化为普通十进制
  const inputText = /[eE]/.test(token)
    ? formatNmFromCnm(result.cnm, decimalScaleOf(token))
    : token;
  return { cnm: result.cnm, inputText, unit };
}

/** JSON 数字记号（已通过换算校验）在十进制下的小数位数。 */
function decimalScaleOf(token) {
  const m = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  const frac = m[1] ?? '';
  const exp = m[2] === undefined ? 0 : Number(m[2]);
  return Math.max(0, frac.length - exp);
}

/** 由整数 cN·m 反推普通十进制 N·m 文本（scale ∈ 0..2），不使用浮点。 */
function formatNmFromCnm(cnm, scale) {
  const sign = cnm < 0 ? '-' : '';
  const digits = String(Math.abs(cnm)).padStart(3, '0');
  if (scale === 0) return sign + digits.slice(0, -2);
  const cut = digits.length - 2;
  return `${sign}${digits.slice(0, cut)}.${digits.slice(cut, cut + scale)}`;
}

export function createApp() {
  const app = express();
  // 捕获请求体原文：N·m 读数需按十进制文本精确换算，不能用解析后的浮点值
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

  // 允许跨源访问（页面默认经 web 容器同源代理 /api，此为兜底）
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // 开始新会话：固定 A1 → B2 → A3 → B1 → A2 → B3
  app.post('/api/sessions', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `INSERT INTO sessions DEFAULT VALUES
         RETURNING id, status, expected_sequence, created_at`,
      );
      res.status(201).json(sessionView(rows[0], []));
    } catch (err) {
      next(err);
    }
  });

  // 按工单码打开复核：已绑定则在同一事务内返回该会话，尚未绑定时才创建。
  // 两个终端并发打开同一码只会得到同一会话（ON CONFLICT DO NOTHING + 行锁改读）。
  app.post('/api/work-orders/:code/session', async (req, res, next) => {
    let code;
    try {
      code = normalizeWorkOrderCode(req.params.code ?? '');
    } catch (err) {
      return next(err);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { created, session } = await openWorkOrderSession(client, code);
      const c = await client.query(ACTIVE_CONFIRMATIONS_SQL, [session.id]);
      const r = await client.query(RETRACTIONS_SQL, [session.id]);
      await client.query('COMMIT');
      res.status(created ? 201 : 200).json(sessionView(session, c.rows, r.rows));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  // 读取权威进度（页面刷新后以此为准）
  app.get('/api/sessions/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const s = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
      if (s.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const c = await pool.query(ACTIVE_CONFIRMATIONS_SQL, [id]);
      const r = await pool.query(RETRACTIONS_SQL, [id]);
      res.json(sessionView(s.rows[0], c.rows, r.rows));
    } catch (err) {
      next(err);
    }
  });

  // 带原因终止复核（拆下返修/装夹错误）。在会话行锁事务内把进行中会话转为已终止；
  // 重复终止幂等返回现有结果；已完成会话不可终止。终止与确认并发时先取得行锁者生效。
  app.post('/api/sessions/:id/cancel', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const reason = (req.body ?? {}).reason;
      // 按字符（Unicode 码点）计数，与数据库 char_length 一致
      const reasonLength = typeof reason === 'string' ? [...reason.trim()].length : 0;
      if (
        typeof reason !== 'string' ||
        reasonLength < CANCEL_REASON_MIN_LENGTH ||
        reasonLength > CANCEL_REASON_MAX_LENGTH
      ) {
        throw new ApiError(
          400,
          'invalid_body',
          `终止原因必须为 ${CANCEL_REASON_MIN_LENGTH}–${CANCEL_REASON_MAX_LENGTH} 字的字符串`,
        );
      }

      await client.query('BEGIN');
      const sres = await client.query(
        'SELECT * FROM sessions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (sres.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const session = sres.rows[0];

      // 重复终止：不改动任何数据，返回现有终止结果（幂等）
      if (session.status === 'cancelled') {
        await client.query('COMMIT');
        return res.json({ cancelled: true, replayed: true, progress: progressOf(session) });
      }
      // 已完成会话不可终止
      if (session.status === 'completed') {
        throw new ApiError(
          409,
          'session_completed',
          '会话已完成，不可终止',
          { progress: progressOf(session) },
        );
      }

      const upd = await client.query(
        `UPDATE sessions
         SET status = 'cancelled', cancel_reason = $1, cancelled_at = now(), updated_at = now()
         WHERE id = $2 RETURNING *`,
        [reason.trim(), id],
      );
      await client.query('COMMIT');
      res.json({ cancelled: true, replayed: false, progress: progressOf(upd.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  // 撤回上一步：为当前最后一条「有效」确认追加不可变撤回事件并回退期待序号，
  // 允许同一序号随后以新读数重新确认。与确认/终止一样在会话行锁事务内执行，
  // 并发撤回由行锁串行化；客户端在二次确认时携带其所见最后确认的编号，
  // 竞争失败者会发现该记录已被撤回，收到明确原因而不会多撤回一颗。
  app.post('/api/sessions/:id/confirmations/last/retract', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      // 可选的乐观并发标记：页面二次确认时所见的最后一条有效确认编号
      const targetId = (req.body ?? {}).confirmation_id;
      if (targetId !== undefined && !Number.isInteger(targetId)) {
        throw new ApiError(400, 'invalid_body', 'confirmation_id 必须为整数编号');
      }

      await client.query('BEGIN');
      const sres = await client.query(
        'SELECT * FROM sessions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (sres.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const session = sres.rows[0];

      // 终态会话不可撤回：页面只在进行中展示入口，此处为服务端权威判定
      if (session.status === 'completed') {
        throw new ApiError(
          409,
          'session_completed',
          '会话已完成，不可撤回',
          { progress: progressOf(session) },
        );
      }
      if (session.status === 'cancelled') {
        throw new ApiError(
          409,
          'session_cancelled',
          '会话已终止复核，不可撤回',
          { progress: progressOf(session) },
        );
      }

      // 当前最后一条有效确认（行锁锁定，与并发确认/撤回串行）
      const lastRes = await client.query(
        `SELECT * FROM confirmations
         WHERE session_id = $1 AND retraction_id IS NULL
         ORDER BY sequence DESC
         LIMIT 1
         FOR UPDATE`,
        [id],
      );
      if (lastRes.rowCount === 0) {
        throw new ApiError(
          409,
          'nothing_to_retract',
          '暂无可撤回的确认记录',
          { progress: progressOf(session) },
        );
      }
      const last = lastRes.rows[0];
      const lastId = Number(last.id);

      if (targetId !== undefined) {
        if (targetId !== lastId) {
          // 客户端指定的目标不是当前最后一条：查明其状态以返回明确原因
          const t = await client.query(
            'SELECT * FROM confirmations WHERE id = $1 AND session_id = $2',
            [targetId, id],
          );
          if (t.rowCount === 0) {
            throw new ApiError(
              400,
              'invalid_body',
              '指定的确认记录不存在',
              { progress: progressOf(session) },
            );
          }
          if (t.rows[0].retraction_id !== null) {
            // 并发竞争落败：另一个撤回请求已先把同一步撤回
            throw new ApiError(
              409,
              'already_retracted',
              '上一步确认已被撤回（可能由并发操作完成），请以最新权威进度为准',
              { progress: progressOf(session) },
            );
          }
          throw new ApiError(
            409,
            'retraction_target_stale',
            '指定的确认不是当前最后一步，请刷新进度后重试',
            { progress: progressOf(session) },
          );
        }
      }

      // 1) 追加不可变撤回事件
      const rIns = await client.query(
        `INSERT INTO retractions (session_id, confirmation_id, sequence)
         VALUES ($1, $2, $3) RETURNING *`,
        [id, last.id, last.sequence],
      );
      // 2) 为原确认一次性打撤回标记（触发器保证业务字段不变、只允许一次）
      await client.query(
        `UPDATE confirmations
         SET retraction_id = $1, retracted_at = $2
         WHERE id = $3`,
        [rIns.rows[0].id, rIns.rows[0].retracted_at, last.id],
      );
      // 3) 回退期待序号到被撤回的那一步（状态保持 in_progress；
      //    完成态会话已在前面拒绝，因此 sequence 不可能为 6）
      const upd = await client.query(
        `UPDATE sessions
         SET expected_sequence = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [last.sequence, id],
      );
      await client.query('COMMIT');

      const retraction = retractionView({
        id: rIns.rows[0].id,
        session_id: id,
        confirmation_id: lastId,
        sequence: rIns.rows[0].sequence,
        retracted_at: rIns.rows[0].retracted_at,
        position: last.position,
        torque: last.torque,
        torque_input: last.torque_input,
        torque_unit: last.torque_unit,
        idempotency_key: last.idempotency_key,
        confirmed_at: last.confirmed_at,
      });
      res.json({ retracted: true, retraction, progress: progressOf(upd.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  // 提交一次复核确认。校验顺序：幂等 → 序号（迟到/越序）→ 位置 → 扭矩。
  // 任何失败都不推进进度、不消耗幂等键。
  app.post('/api/sessions/:id/confirmations', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const body = req.body ?? {};
      const { session_id, sequence, position, idempotency_key } = body;

      if (session_id !== id) {
        throw new ApiError(400, 'invalid_body', '会话编号与请求路径不一致');
      }
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw new ApiError(400, 'invalid_body', 'sequence 必须为从 1 开始的整数序号');
      }
      if (typeof position !== 'string' || !POSITIONS.includes(position)) {
        throw new ApiError(
          400,
          'invalid_body',
          `position 必须为位置码之一：${POSITIONS.join('、')}`,
        );
      }
      if (
        typeof idempotency_key !== 'string' ||
        idempotency_key.length === 0 ||
        idempotency_key.length > IDEMPOTENCY_KEY_MAX_LENGTH
      ) {
        throw new ApiError(
          400,
          'invalid_body',
          `idempotency_key 必须为 1–${IDEMPOTENCY_KEY_MAX_LENGTH} 字符的字符串`,
        );
      }
      // 先精确换算为整数 cN·m，之后顺序、范围、幂等判定一律使用标准值。
      // 单位缺省按 cN·m 处理，保持旧格式客户端语义。
      const { cnm: torque, inputText: torqueInput, unit } = parseTorque(body, req.rawBody);

      await client.query('BEGIN');
      // 会话行锁：同一会话的提交串行化，配合唯一约束兜底并发重试
      const sres = await client.query(
        'SELECT * FROM sessions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (sres.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const session = sres.rows[0];
      const progress = progressOf(session);

      // 会话已终止：任何提交（含旧客户端迟到的自动重试）一律拒绝且不写事件，
      // 并随错误返回最新权威进度。须在幂等查询之前判定。
      if (session.status === 'cancelled') {
        throw new ApiError(
          409,
          'session_cancelled',
          '会话已终止复核，不再接受确认提交',
          { progress },
        );
      }

      // 1) 幂等键优先：已落库的确认事件决定重试语义
      const eres = await client.query(
        'SELECT * FROM confirmations WHERE session_id = $1 AND idempotency_key = $2',
        [id, idempotency_key],
      );
      if (eres.rowCount > 0) {
        const existing = eres.rows[0];
        const identical =
          existing.sequence === sequence &&
          existing.position === position &&
          existing.torque === torque;
        if (!identical) {
          throw new ApiError(
            409,
            'idempotency_conflict',
            '幂等键已被使用且载荷不一致，判定为冲突，未推进',
            { existing: confirmationView(existing), progress },
          );
        }
        await client.query('COMMIT');
        return res.status(200).json({
          replayed: true,
          confirmation: confirmationView(existing),
          progress,
        });
      }

      // 2) 序号检查：较小为迟到，较大为越序
      const expected = session.expected_sequence;
      if (sequence < expected) {
        throw new ApiError(
          409,
          'late_sequence',
          `序号 ${sequence} 已被确认过，属于迟到响应，未推进`,
          { progress },
        );
      }
      if (sequence > expected) {
        throw new ApiError(
          409,
          'out_of_order_sequence',
          `序号 ${sequence} 越过当前期待序号 ${expected}，属于越序，未推进`,
          { progress },
        );
      }

      // 3) 位置码必须与当前期待步骤对应
      const requiredPosition = POSITIONS[sequence - 1];
      if (position !== requiredPosition) {
        throw new ApiError(
          422,
          'position_mismatch',
          `位置码 ${position} 与第 ${sequence} 步要求的位置 ${requiredPosition} 不符，未推进`,
          { progress },
        );
      }

      // 4) 扭矩须在合格范围内（含边界），判定一律使用换算后的标准 cN·m
      if (torque < TORQUE_MIN || torque > TORQUE_MAX) {
        const reading = `${torqueInput} ${unit}`;
        throw new ApiError(
          422,
          'torque_out_of_range',
          `扭矩 ${reading}（${torque} cN·m）超出合格范围 ${TORQUE_MIN}–${TORQUE_MAX} cN·m，未推进`,
          { progress },
        );
      }

      const ins = await client.query(
        `INSERT INTO confirmations
           (session_id, sequence, position, torque, torque_input, torque_unit, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, sequence, position, torque, torqueInput, unit, idempotency_key],
      );
      const newStatus = sequence === TOTAL_STEPS ? 'completed' : 'in_progress';
      const upd = await client.query(
        `UPDATE sessions
         SET expected_sequence = $1, status = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [sequence + 1, newStatus, id],
      );
      await client.query('COMMIT');
      res.status(201).json({
        replayed: false,
        confirmation: confirmationView(ins.rows[0]),
        progress: progressOf(upd.rows[0]),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
  });

  // 统一错误出口：业务错误按码返回，其余为 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message }, ...(err.extra ?? {}) });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res
        .status(400)
        .json({ error: { code: 'invalid_body', message: '请求体不是合法 JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: '服务器内部错误' } });
  });

  return app;
}
