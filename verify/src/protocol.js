import pg from 'pg';

import { assert, assertEqual, assertRejects } from './helpers.js';

const POSITIONS = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

let keySeq = 0;
const key = (tag) => `proto-${tag}-${process.pid}-${Date.now()}-${(keySeq += 1)}`;

async function createSession(base) {
  const r = await fetch(`${base}/api/sessions`, { method: 'POST' });
  assertEqual(r.status, 201, '创建会话状态码');
  return r.json();
}

async function getSession(base, id) {
  const r = await fetch(`${base}/api/sessions/${id}`);
  assertEqual(r.status, 200, '读取会话状态码');
  return r.json();
}

let woSeq = 0;
const woCode = (tag) => `WO-${tag}-${process.pid}-${Date.now()}-${(woSeq += 1)}`;

async function openWorkOrder(base, code) {
  const r = await fetch(
    `${base}/api/work-orders/${encodeURIComponent(code)}/session`,
    { method: 'POST' },
  );
  return { status: r.status, body: await r.json() };
}

async function postConf(base, sid, payload) {
  const r = await fetch(`${base}/api/sessions/${sid}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid, ...payload }),
  });
  return { status: r.status, body: await r.json() };
}

async function postCancel(base, sid, reason) {
  const r = await fetch(`${base}/api/sessions/${sid}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return { status: r.status, body: await r.json() };
}

async function postRetract(base, sid, confirmationId) {
  const r = await fetch(`${base}/api/sessions/${sid}/confirmations/last/retract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      confirmationId === undefined ? {} : { confirmation_id: confirmationId },
    ),
  });
  return { status: r.status, body: await r.json() };
}

/** 以原始 JSON 文本提交（用于保真发送 42.00 等读数）。 */
async function postConfRaw(base, sid, rawPayload) {
  const r = await fetch(`${base}/api/sessions/${sid}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: `{"session_id":${JSON.stringify(sid)},${rawPayload}}`,
  });
  return { status: r.status, body: await r.json() };
}

async function confirmSteps(base, sid, n) {
  for (let i = 0; i < n; i += 1) {
    const r = await postConf(base, sid, {
      sequence: i + 1,
      position: POSITIONS[i],
      torque: 4500,
      idempotency_key: key(`step${i + 1}`),
    });
    assertEqual(r.status, 201, `第 ${i + 1} 步状态码`);
  }
}

/** 确认从 fromSeq 到第 6 步的剩余步骤（用于撤回重做后续完成整轮）。 */
async function confirmStepsFrom(base, sid, fromSeq) {
  for (let seq = fromSeq; seq <= POSITIONS.length; seq += 1) {
    const r = await postConf(base, sid, {
      sequence: seq,
      position: POSITIONS[seq - 1],
      torque: 4500,
      idempotency_key: key(`from${fromSeq}-step${seq}`),
    });
    assertEqual(r.status, 201, `第 ${seq} 步状态码`);
  }
}

/** 协议测试：直接针对 API 的 HTTP 语义。 */
export async function runProtocol(base, t) {
  await t.test('健康检查返回 200', async () => {
    const r = await fetch(`${base}/healthz`);
    assertEqual(r.status, 200);
  });

  await t.test('新会话固定顺序 A1→B2→A3→B1→A2→B3，边界扭矩 4200/4800 均合格', async () => {
    const s = await createSession(base);
    assertEqual(s.expected_sequence, 1, '初始期待序号');
    assertEqual(s.expected_position, 'A1', '初始期待位置');
    assertEqual(JSON.stringify(s.positions), JSON.stringify(POSITIONS), '固定复核顺序');
    const torques = [4200, 4800, 4200, 4800, 4500, 4600];
    for (let i = 0; i < 6; i += 1) {
      const r = await postConf(base, s.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: torques[i],
        idempotency_key: key('happy'),
      });
      assertEqual(r.status, 201, `第 ${i + 1} 步状态码`);
      assertEqual(r.body.replayed, false, `第 ${i + 1} 步非重放`);
      assertEqual(r.body.confirmation.sequence, i + 1, `第 ${i + 1} 步序号`);
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '六步后完成');
    assertEqual(st.confirmations.length, 6, '六条确认事件');
    assertEqual(st.expected_sequence, null, '完成后无期待序号');
  });

  await t.test('同一幂等键+完全相同载荷重试：返回原确认且不推进', async () => {
    const s = await createSession(base);
    const payload = { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('replay') };
    const r1 = await postConf(base, s.session_id, payload);
    assertEqual(r1.status, 201);
    const r2 = await postConf(base, s.session_id, payload);
    assertEqual(r2.status, 200, '重试应返回 200');
    assertEqual(r2.body.replayed, true, '应标记为重放');
    assertEqual(r2.body.confirmation.id, r1.body.confirmation.id, '应返回原确认事件');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '只记录一次');
    assertEqual(st.expected_sequence, 2, '推进到第 2 步后不重复推进');
  });

  await t.test('同一幂等键+不同载荷：返回 409 冲突且不推进', async () => {
    const s = await createSession(base);
    const k = key('conflict');
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: k });
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4600, idempotency_key: k });
    assertEqual(r.status, 409, '冲突状态码');
    assertEqual(r.body.error.code, 'idempotency_conflict', '冲突错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '冲突不产生新记录');
    assertEqual(st.expected_sequence, 2, '冲突不推进');
  });

  await t.test('N·m 边界读数 42.00 / 48.00 精确换算后合格，原始读数与单位随事件保存', async () => {
    const s = await createSession(base);
    // 以原始 JSON 文本发送，保真两位小数尾零
    const r1 = await postConfRaw(
      base,
      s.session_id,
      '"sequence":1,"position":"A1","torque":42.00,"unit":"N·m","idempotency_key":' + JSON.stringify(key('nm42')),
    );
    assertEqual(r1.status, 201, '42.00 N·m 边界应合格');
    assertEqual(r1.body.confirmation.torque, 4200, '标准字段应为整数 4200 cN·m');
    assertEqual(r1.body.confirmation.torque_input, '42.00', '原始读数应保真为 42.00');
    assertEqual(r1.body.confirmation.torque_unit, 'N·m', '原始单位应为 N·m');
    const r2 = await postConfRaw(
      base,
      s.session_id,
      '"sequence":2,"position":"B2","torque":48.00,"unit":"N·m","idempotency_key":' + JSON.stringify(key('nm48')),
    );
    assertEqual(r2.status, 201, '48.00 N·m 边界应合格');
    assertEqual(r2.body.confirmation.torque, 4800, '标准字段应为整数 4800 cN·m');
    assertEqual(r2.body.confirmation.torque_input, '48.00', '原始读数应保真为 48.00');
    const st = await getSession(base, s.session_id);
    assertEqual(st.expected_sequence, 3, '两个边界步骤正常推进');
    assertEqual(st.confirmations[0].torque, 4200, '历史明细仍按 cN·m 展示');
  });

  await t.test('N·m 读数 41.99 换算为 4199 cN·m：越界拒绝、不写事件、不推进', async () => {
    const s = await createSession(base);
    const r = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: '41.99', unit: 'N·m', idempotency_key: key('nm4199'),
    });
    assertEqual(r.status, 422, '越界状态码');
    assertEqual(r.body.error.code, 'torque_out_of_range', '扭矩错误码');
    assert(r.body.error.message.includes('4199'), '原因应给出换算后的 cN·m 值');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '拒绝不产生事件');
    assertEqual(st.expected_sequence, 1, '拒绝不推进序号');
  });

  await t.test('N·m 精度超限（45.123）与无法精确换算（超大数）：422 且不推进', async () => {
    const s = await createSession(base);
    const precision = await postConfRaw(
      base,
      s.session_id,
      '"sequence":1,"position":"A1","torque":45.123,"unit":"N·m","idempotency_key":' + JSON.stringify(key('prec')),
    );
    assertEqual(precision.status, 422, '精度超限状态码');
    assertEqual(precision.body.error.code, 'torque_precision_exceeded', '精度错误码');
    const huge = await postConfRaw(
      base,
      s.session_id,
      '"sequence":1,"position":"A1","torque":1e30,"unit":"N·m","idempotency_key":' + JSON.stringify(key('huge')),
    );
    assertEqual(huge.status, 422, '无法换算状态码');
    assertEqual(huge.body.error.code, 'torque_unconvertible', '换算错误码');
    const badUnit = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 45, unit: 'kgf·m', idempotency_key: key('badunit'),
    });
    assertEqual(badUnit.status, 400, '未知单位状态码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '均不产生事件');
    assertEqual(st.expected_sequence, 1, '均不推进');
  });

  await t.test('同一幂等键用 45 N·m 与 4500 cN·m 重试：只产生一条确认', async () => {
    const s = await createSession(base);
    const k = key('sameintent');
    const r1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 45, unit: 'N·m', idempotency_key: k,
    });
    assertEqual(r1.status, 201, '首次 45 N·m 成功');
    assertEqual(r1.body.confirmation.torque, 4500, '换算为 4500 cN·m');
    // 同键、同一步骤，旧格式整数 cN·m 重试
    const r2 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: k,
    });
    assertEqual(r2.status, 200, '重试应返回 200');
    assertEqual(r2.body.replayed, true, '应标记为重放');
    assertEqual(r2.body.confirmation.id, r1.body.confirmation.id, '应返回原确认事件');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '只落库一条确认');
    assertEqual(st.confirmations[0].torque_unit, 'N·m', '原确认保留首次录入单位');
    assertEqual(st.expected_sequence, 2, '只推进一次');
  });

  await t.test('旧格式客户端（整数 torque、不传 unit）完成完整六步流程', async () => {
    const s = await createSession(base);
    const torques = [4500, 4600, 4200, 4800, 4500, 4700];
    for (let i = 0; i < 6; i += 1) {
      const r = await postConf(base, s.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: torques[i],
        idempotency_key: key('legacy'),
      });
      assertEqual(r.status, 201, `旧格式第 ${i + 1} 步状态码`);
      assertEqual(r.body.confirmation.torque, torques[i], `第 ${i + 1} 步标准扭矩`);
      assertEqual(r.body.confirmation.torque_unit, 'cN·m', `第 ${i + 1} 步缺省单位应为 cN·m`);
      assertEqual(r.body.confirmation.torque_input, String(torques[i]), `第 ${i + 1} 步原始读数`);
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '旧格式六步后完成');
    assertEqual(st.confirmations.length, 6, '六条确认事件');
  });

  await t.test('较小序号视为迟到：409 且不推进', async () => {
    const s = await createSession(base);
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('late0') });
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('late1') });
    assertEqual(r.status, 409);
    assertEqual(r.body.error.code, 'late_sequence', '迟到错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '迟到不产生新记录');
    assertEqual(st.expected_sequence, 2, '迟到不推进');
  });

  await t.test('较大序号视为越序：409 且不推进', async () => {
    const s = await createSession(base);
    const r = await postConf(base, s.session_id, { sequence: 3, position: 'A3', torque: 4500, idempotency_key: key('ooo') });
    assertEqual(r.status, 409);
    assertEqual(r.body.error.code, 'out_of_order_sequence', '越序错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '越序不产生记录');
    assertEqual(st.expected_sequence, 1, '越序不推进');
  });

  await t.test('位置码与当前期待步骤不符：422 且不推进', async () => {
    const s = await createSession(base);
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'B2', torque: 4500, idempotency_key: key('pos') });
    assertEqual(r.status, 422);
    assertEqual(r.body.error.code, 'position_mismatch', '位置错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '位置不符不产生记录');
  });

  await t.test('扭矩越界（4199/4801）与非整数：拒绝且不推进', async () => {
    const s = await createSession(base);
    for (const torque of [4199, 4801]) {
      const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque, idempotency_key: key('range') });
      assertEqual(r.status, 422, `扭矩 ${torque} 状态码`);
      assertEqual(r.body.error.code, 'torque_out_of_range', '扭矩错误码');
    }
    const frac = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500.5, idempotency_key: key('frac') });
    assertEqual(frac.status, 400, '非整数扭矩状态码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '非法扭矩不产生记录');
    assertEqual(st.expected_sequence, 1, '非法扭矩不推进');
  });

  await t.test('未知会话：读取与提交均返回 404', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const g = await fetch(`${base}/api/sessions/${id}`);
    assertEqual(g.status, 404);
    const r = await postConf(base, id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('404') });
    assertEqual(r.status, 404);
  });

  await t.test('缺少必填字段或会话编号与路径不一致：400', async () => {
    const s = await createSession(base);
    const missing = await fetch(`${base}/api/sessions/${s.session_id}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: s.session_id, sequence: 1, position: 'A1' }),
    });
    assertEqual(missing.status, 400, '缺字段状态码');
    const mismatched = await fetch(`${base}/api/sessions/${s.session_id}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: '00000000-0000-0000-0000-000000000000',
        sequence: 1,
        position: 'A1',
        torque: 4500,
        idempotency_key: key('mismatch'),
      }),
    });
    assertEqual(mismatched.status, 400, '会话编号不一致状态码');
  });

  await t.test('并发相同请求（触屏连点）：只记录一次确认', async () => {
    const s = await createSession(base);
    const payload = { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('race') };
    const [a, b] = await Promise.all([
      postConf(base, s.session_id, payload),
      postConf(base, s.session_id, payload),
    ]);
    const codes = [a.status, b.status].sort();
    assertEqual(JSON.stringify(codes), JSON.stringify([200, 201]), '并发应为一个 201 一个 200');
    assertEqual(a.body.confirmation.id, b.body.confirmation.id, '并发返回同一确认事件');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '并发只落库一次');
  });

  await t.test('确认事件不可变：数据库层拒绝 UPDATE/DELETE', async () => {
    const s = await createSession(base);
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('immut') });
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      await assertRejects(
        () => client.query('UPDATE confirmations SET torque = 4999'),
        'UPDATE 应被触发器拒绝',
      );
      await assertRejects(
        () => client.query('DELETE FROM confirmations'),
        'DELETE 应被触发器拒绝',
      );
    } finally {
      await client.end();
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations[0].torque, 4500, '原始扭矩未被篡改');
  });

  await t.test('完成两步后终止：返回终止时间与原因，刷新后保持，事件只增不改', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 2);
    const r = await postCancel(base, s.session_id, '轮毂拆下返修');
    assertEqual(r.status, 200, '终止状态码');
    assertEqual(r.body.cancelled, true, '标记已终止');
    assertEqual(r.body.replayed, false, '首次终止非重放');
    assertEqual(r.body.progress.status, 'cancelled', '进度状态为已终止');
    assertEqual(r.body.progress.cancel_reason, '轮毂拆下返修', '进度携带原因');
    assertEqual(r.body.progress.expected_sequence, null, '终止后无期待序号');
    assert(Boolean(r.body.progress.cancelled_at), '进度携带终止时间');
    // 刷新（GET）后原因与时间仍在，已有确认事件原样保留
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'cancelled', '刷新后仍为已终止');
    assertEqual(st.cancel_reason, '轮毂拆下返修', '刷新后原因保持');
    assert(Boolean(st.cancelled_at), '刷新后终止时间保持');
    assertEqual(st.confirmations.length, 2, '已有两条确认事件保留');
    assertEqual(st.confirmations[1].sequence, 2, '第二条事件序号不变');
  });

  await t.test('终止后再提交确认：409 session_cancelled 且不写事件', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 2);
    await postCancel(base, s.session_id, '装夹错误');
    const r = await postConf(base, s.session_id, {
      sequence: 3,
      position: 'A3',
      torque: 4500,
      idempotency_key: key('after-cancel'),
    });
    assertEqual(r.status, 409, '终止后确认状态码');
    assertEqual(r.body.error.code, 'session_cancelled', '终止拒绝错误码');
    assertEqual(r.body.progress.status, 'cancelled', '错误附带最新权威进度');
    assertEqual(r.body.progress.confirmed_count, 2, '权威进度未推进');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 2, '不写入新事件');
    // 同一幂等键再试仍是 session_cancelled（终止判定优先于幂等），仍不写事件
    const r2 = await postConf(base, s.session_id, {
      sequence: 3,
      position: 'A3',
      torque: 4500,
      idempotency_key: key('after-cancel'),
    });
    assertEqual(r2.status, 409, '重复提交仍被拒绝');
    assertEqual(r2.body.error.code, 'session_cancelled', '重复提交错误码');
    const st2 = await getSession(base, s.session_id);
    assertEqual(st2.confirmations.length, 2, '重复提交仍不写事件');
  });

  await t.test('重复终止：幂等返回现有结果（原因与时间不变）', async () => {
    const s = await createSession(base);
    await postCancel(base, s.session_id, '装夹错误，需重新装夹');
    const before = await getSession(base, s.session_id);
    const r = await postCancel(base, s.session_id, '另一个不同的原因');
    assertEqual(r.status, 200, '重复终止状态码');
    assertEqual(r.body.replayed, true, '重复终止标记为重放');
    assertEqual(r.body.progress.cancel_reason, '装夹错误，需重新装夹', '返回现有原因');
    const after = await getSession(base, s.session_id);
    assertEqual(after.cancel_reason, '装夹错误，需重新装夹', '原因不被覆盖');
    assertEqual(after.cancelled_at, before.cancelled_at, '终止时间不被覆盖');
  });

  await t.test('已完成会话不可终止：409 session_completed 且不改变完成态', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 6);
    const r = await postCancel(base, s.session_id, '完成后不应被终止');
    assertEqual(r.status, 409, '已完成终止状态码');
    assertEqual(r.body.error.code, 'session_completed', '已完成错误码');
    assertEqual(r.body.progress.status, 'completed', '附带完成态进度');
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '仍为完成态');
    assertEqual(st.confirmations.length, 6, '确认事件不受影响');
  });

  await t.test('终止原因长度边界与非法请求体：2 与 100 字通过，1、101 字及非字符串 400', async () => {
    const s1 = await createSession(base);
    assertEqual((await postCancel(base, s1.session_id, 'a')).status, 400, '1 字拒绝');
    assertEqual((await postCancel(base, s1.session_id, 'a'.repeat(101))).status, 400, '101 字拒绝');
    assertEqual((await postCancel(base, s1.session_id, {})).status, 400, '非字符串拒绝');
    // 被 400 拒绝的会话未终止，仍可正常复核
    const conf = await postConf(base, s1.session_id, {
      sequence: 1,
      position: 'A1',
      torque: 4500,
      idempotency_key: key('after-bad-cancel'),
    });
    assertEqual(conf.status, 201, '原因非法不影响后续确认');

    const s2 = await createSession(base);
    const r2 = await postCancel(base, s2.session_id, '返修');
    assertEqual(r2.status, 200, '2 字通过');
    const s3 = await createSession(base);
    const r100 = await postCancel(base, s3.session_id, '原'.repeat(100));
    assertEqual(r100.status, 200, '100 字通过');
    assertEqual([...r100.body.progress.cancel_reason].length, 100, '原因长度为 100');
    // 前后空白被裁剪后按 2 字计
    const s4 = await createSession(base);
    const rTrim = await postCancel(base, s4.session_id, '  返修  ');
    assertEqual(rTrim.status, 200, '两端空白裁剪后达 2 字通过');
    assertEqual(rTrim.body.progress.cancel_reason, '返修', '保存裁剪后的原因');
  });

  await t.test('未知会话终止返回 404', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const r = await postCancel(base, id, '不存在的会话');
    assertEqual(r.status, 404);
    assertEqual(r.body.error.code, 'session_not_found');
  });

  await t.test('最后一步确认与终止并发：只形成一个终态，后到者收到权威进度', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 5);
    const [conf, canc] = await Promise.all([
      postConf(base, s.session_id, {
        sequence: 6,
        position: 'B3',
        torque: 4500,
        idempotency_key: key('last-race'),
      }),
      postCancel(base, s.session_id, '最后一步并发终止'),
    ]);
    const st = await getSession(base, s.session_id);
    assert(
      st.status === 'completed' || st.status === 'cancelled',
      `终态只能是完成或已终止，实际：${st.status}`,
    );
    if (st.status === 'completed') {
      // 确认先取得行锁：六步落库，终止被拒
      assertEqual(conf.status, 201, '先到确认成功');
      assertEqual(canc.status, 409, '后到终止被拒');
      assertEqual(canc.body.error.code, 'session_completed', '后到终止错误码');
      assertEqual(canc.body.progress.status, 'completed', '后到终止收到完成态进度');
      assertEqual(st.confirmations.length, 6, '完成态六条确认');
    } else {
      // 终止先取得行锁：确认被拒，事件仍只有前五条
      assertEqual(canc.status, 200, '先到终止成功');
      assertEqual(conf.status, 409, '后到确认被拒');
      assertEqual(conf.body.error.code, 'session_cancelled', '后到确认错误码');
      assertEqual(conf.body.progress.status, 'cancelled', '后到确认收到已终止进度');
      assertEqual(st.confirmations.length, 5, '终止态保持五条确认');
    }
  });
  await t.test('工单码：首次打开从第一颗开始，重复打开返回同一会话（含首尾空白归一化）', async () => {
    const code = woCode('first');
    const r1 = await openWorkOrder(base, code);
    assertEqual(r1.status, 201, '首次打开应为 201');
    assertEqual(r1.body.work_order_code, code, '回显工单码');
    assertEqual(r1.body.expected_sequence, 1, '新工单从第一颗开始');
    assertEqual(r1.body.expected_position, 'A1', '新工单初始位置为 A1');
    assertEqual(r1.body.confirmed_count, 0, '新工单无确认记录');

    const r2 = await openWorkOrder(base, code);
    assertEqual(r2.status, 200, '再次打开应为 200');
    assertEqual(r2.body.session_id, r1.body.session_id, '应返回已绑定的同一会话');
    assertEqual(r2.body.work_order_code, code, '工单码保持不变');

    // 接口按去除首尾空白后的值保存与查找：带空白的同码仍命中同一会话
    const r3 = await openWorkOrder(base, `  ${code}  `);
    assertEqual(r3.status, 200, '带首尾空白打开应为 200');
    assertEqual(r3.body.session_id, r1.body.session_id, '空白归一化后应命中同一会话');
  });

  await t.test('工单码：完成两步后再次打开，接续到第三颗且带有权威进度', async () => {
    const code = woCode('resume');
    const opened = await openWorkOrder(base, code);
    assertEqual(opened.status, 201);
    const sid = opened.body.session_id;
    for (const [seq, pos, torque] of [[1, 'A1', 4500], [2, 'B2', 4600]]) {
      const r = await postConf(base, sid, {
        sequence: seq, position: pos, torque, idempotency_key: key(`wo-resume-${seq}`),
      });
      assertEqual(r.status, 201, `第 ${seq} 步应成功`);
    }
    const again = await openWorkOrder(base, code);
    assertEqual(again.status, 200);
    assertEqual(again.body.session_id, sid, '仍为同一会话');
    assertEqual(again.body.confirmed_count, 2, '已确认两颗');
    assertEqual(again.body.expected_sequence, 3, '接续第三颗');
    assertEqual(again.body.expected_position, 'A3', '第三颗位置为 A3');
    assertEqual(again.body.confirmations.length, 2, '返回两条历史确认');
  });

  await t.test('工单码会话终止后再次打开：恢复同一终止态、原因与时间', async () => {
    const code = woCode('cancelled-resume');
    const opened = await openWorkOrder(base, code);
    const sid = opened.body.session_id;
    await confirmSteps(base, sid, 2);
    const cancelled = await postCancel(base, sid, '跨终端终止后恢复');
    assertEqual(cancelled.status, 200, '终止应成功');

    const again = await openWorkOrder(base, code);
    assertEqual(again.status, 200, '再次打开应复用现有会话');
    assertEqual(again.body.session_id, sid, '恢复同一会话');
    assertEqual(again.body.status, 'cancelled', '恢复终止态');
    assertEqual(again.body.cancel_reason, '跨终端终止后恢复', '恢复终止原因');
    assert(Boolean(again.body.cancelled_at), '恢复终止时间');
    assertEqual(again.body.confirmed_count, 2, '保留终止前进度');
    assertEqual(again.body.expected_sequence, null, '终止态不再期待下一步');
  });

  await t.test('工单码：并发首次打开同一码只产生一个会话', async () => {
    const code = woCode('race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => openWorkOrder(base, code)),
    );
    const created = results.filter((r) => r.status === 201);
    const reused = results.filter((r) => r.status === 200);
    assertEqual(created.length, 1, '只有一个请求创建会话');
    assertEqual(reused.length, 7, '其余请求复用该会话');
    const ids = new Set(results.map((r) => r.body.session_id));
    assertEqual(ids.size, 1, '所有响应必须是同一个会话编号');
    assertEqual([...ids][0], created[0].body.session_id, '复用的正是被创建的会话');

    // 数据库层兜底：该工单码只绑定一行会话
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM sessions WHERE work_order_code = $1',
        [code],
      );
      assertEqual(rows[0].n, 1, '数据库中该工单码只有一个会话');
    } finally {
      await client.end();
    }
  });

  await t.test('工单码：空白码与超长码返回 400 invalid_work_order_code 且不创建会话', async () => {
    const blank = await openWorkOrder(base, '   ');
    assertEqual(blank.status, 400, '纯空白码状态码');
    assertEqual(blank.body.error.code, 'invalid_work_order_code', '空白码错误码');
    const tooLong = await openWorkOrder(base, 'X'.repeat(65));
    assertEqual(tooLong.status, 400, '超长码状态码');
    assertEqual(tooLong.body.error.code, 'invalid_work_order_code', '超长码错误码');

    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      // 非法调用不应产生工单码为空或超长的行（历史无码行 work_order_code 为 NULL，不受影响）
      const { rows: bad } = await client.query(
        `SELECT count(*)::int AS n FROM sessions
         WHERE work_order_code IS NOT NULL
           AND (length(work_order_code) = 0 OR length(work_order_code) > 64)`,
      );
      assertEqual(bad[0].n, 0, '不存在非法工单码会话');
    } finally {
      await client.end();
    }
  });

  await t.test('旧客户端：无请求体创建、按编号读取与六步确认协议继续可用', async () => {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST' });
    assertEqual(r.status, 201, '旧创建接口仍为 201');
    const s = await r.json();
    assertEqual(s.work_order_code, null, '旧会话无工单码');
    const got = await getSession(base, s.session_id);
    assertEqual(got.expected_sequence, 1, '按编号读取初始进度');
    for (let i = 0; i < 6; i += 1) {
      const c = await postConf(base, s.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: 4500,
        idempotency_key: key(`legacy-${i}`),
      });
      assertEqual(c.status, 201, `旧协议第 ${i + 1} 步状态码`);
    }
    const done = await getSession(base, s.session_id);
    assertEqual(done.status, 'completed', '旧会话六步后完成');
  });

  await t.test('撤回审计字段为新增字段：新会话返回空数组且不改变原有响应字段', async () => {
    const s = await createSession(base);
    assert(Array.isArray(s.retractions), '会话视图应包含 retractions 数组');
    assertEqual(s.retractions.length, 0, '新会话无撤回记录');
    assertEqual(s.expected_sequence, 1, '原有字段保持不变');
    assertEqual(s.confirmations.length, 0, '原有确认列表保持不变');
  });

  await t.test('完成两步后撤回第二步、以新扭矩重做后可完成；刷新只见有效记录并保留审计', async () => {
    const s = await createSession(base);
    const c1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('retract-1'),
    });
    assertEqual(c1.status, 201, '第 1 步成功');
    const c2 = await postConf(base, s.session_id, {
      sequence: 2, position: 'B2', torque: 4600, idempotency_key: key('retract-2-wrong'),
    });
    assertEqual(c2.status, 201, '第 2 步以错误扭矩 4600 落库');

    // 撤回第二步
    const r = await postRetract(base, s.session_id, c2.body.confirmation.id);
    assertEqual(r.status, 200, '撤回状态码');
    assertEqual(r.body.retracted, true, '返回撤回标记');
    assertEqual(r.body.retraction.sequence, 2, '撤回事件序号为 2');
    assertEqual(r.body.retraction.position, 'B2', '撤回事件位置为 B2');
    assertEqual(r.body.retraction.torque, 4600, '撤回事件保留原错误读数');
    assertEqual(r.body.retraction.confirmation_id, c2.body.confirmation.id, '撤回事件指向原确认');
    assert(Boolean(r.body.retraction.retracted_at), '撤回事件携带撤回时间');
    assertEqual(r.body.progress.status, 'in_progress', '撤回后仍为进行中');
    assertEqual(r.body.progress.expected_sequence, 2, '权威进度回到第 2 颗');
    assertEqual(r.body.progress.expected_position, 'B2', '权威进度位置回到 B2');
    assertEqual(r.body.progress.confirmed_count, 1, '有效确认计数回退为 1');

    // 撤回后立即以新扭矩（新的提交意图/新幂等键）重做第二步
    const redo = await postConf(base, s.session_id, {
      sequence: 2, position: 'B2', torque: 4700, idempotency_key: key('retract-2-fixed'),
    });
    assertEqual(redo.status, 201, '同序号以新扭矩重新确认成功');
    assertEqual(redo.body.confirmation.torque, 4700, '重做记录为新扭矩');
    assertEqual(redo.body.progress.expected_sequence, 3, '重做后推进到第 3 步');

    // 完成剩余四步
    for (const [seq, pos] of [[3, 'A3'], [4, 'B1'], [5, 'A2'], [6, 'B3']]) {
      const x = await postConf(base, s.session_id, {
        sequence: seq, position: pos, torque: 4500, idempotency_key: key(`retract-rest-${seq}`),
      });
      assertEqual(x.status, 201, `重做后第 ${seq} 步成功`);
    }

    // 刷新：只显示重做后的有效记录，审计痕迹保留
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '撤回重做后整轮可完成');
    assertEqual(st.confirmations.length, 6, '有效确认恰好六条');
    assertEqual(st.confirmations[1].sequence, 2, '第 2 条有效记录序号为 2');
    assertEqual(st.confirmations[1].torque, 4700, '第 2 条显示重做后的扭矩 4700');
    assert(
      !st.confirmations.some((c) => c.torque === 4600),
      '被撤回的原读数 4600 不再计入 confirmations',
    );
    assertEqual(st.retractions.length, 1, '返回一条撤回审计');
    assertEqual(st.retractions[0].torque, 4600, '审计保留被撤回的原读数 4600');
    assertEqual(st.retractions[0].sequence, 2, '审计序号为 2');
    assertEqual(st.retractions[0].position, 'B2', '审计位置为 B2');
    assert(Boolean(st.retractions[0].confirmed_at), '审计保留原确认时间');
    assert(Boolean(st.retractions[0].retracted_at), '审计保留撤回时间');
    assertEqual(
      st.retractions[0].confirmation_id,
      c2.body.confirmation.id,
      '审计指向被撤回的原确认',
    );
  });

  await t.test('没有可撤回记录：409 nothing_to_retract 且进度不变', async () => {
    const s = await createSession(base);
    const r = await postRetract(base, s.session_id);
    assertEqual(r.status, 409, '零确认撤回状态码');
    assertEqual(r.body.error.code, 'nothing_to_retract', '无可撤回错误码');
    assertEqual(r.body.progress.expected_sequence, 1, '错误附带权威进度');
    const st = await getSession(base, s.session_id);
    assertEqual(st.expected_sequence, 1, '期待序号不变');
    assertEqual(st.confirmations.length, 0, '无确认记录');
    assertEqual(st.retractions.length, 0, '无撤回记录');

    // 撤回一颗后再把同序号撤回一次（无目标参数）也应明确拒绝
    const c1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('retract-empty-1'),
    });
    const ok = await postRetract(base, s.session_id, c1.body.confirmation.id);
    assertEqual(ok.status, 200, '撤回唯一确认成功');
    const again = await postRetract(base, s.session_id);
    assertEqual(again.status, 409, '再次撤回状态码');
    assertEqual(again.body.error.code, 'nothing_to_retract', '已无可撤回记录');
  });

  await t.test('已完成会话不可撤回：409 session_completed 且完成态不变', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 6);
    const done = await getSession(base, s.session_id);
    const r = await postRetract(base, s.session_id, done.confirmations[5].id);
    assertEqual(r.status, 409, '完成态撤回状态码');
    assertEqual(r.body.error.code, 'session_completed', '完成态错误码');
    assertEqual(r.body.progress.status, 'completed', '附带完成态进度');
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '仍为完成态');
    assertEqual(st.confirmations.length, 6, '六条有效确认不变');
    assertEqual(st.retractions.length, 0, '不产生撤回事件');
  });

  await t.test('已终止会话不可撤回：409 session_cancelled', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 2);
    await postCancel(base, s.session_id, '装夹错误');
    const st0 = await getSession(base, s.session_id);
    const r = await postRetract(base, s.session_id, st0.confirmations[1].id);
    assertEqual(r.status, 409, '终止态撤回状态码');
    assertEqual(r.body.error.code, 'session_cancelled', '终止态错误码');
    assertEqual(r.body.progress.status, 'cancelled', '附带终止态进度');
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'cancelled', '仍为终止态');
    assertEqual(st.retractions.length, 0, '不产生撤回事件');
  });

  await t.test('两个撤回请求竞争：只成功一次，另一请求收到明确原因且进度只回退一次', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 2);
    const st0 = await getSession(base, s.session_id);
    const target = st0.confirmations[1].id;
    const results = await Promise.all([
      postRetract(base, s.session_id, target),
      postRetract(base, s.session_id, target),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assertEqual(
      JSON.stringify(statuses),
      JSON.stringify([200, 409]),
      '竞争结果应为一个 200 一个 409',
    );
    const ok = results.find((r) => r.status === 200);
    const lost = results.find((r) => r.status === 409);
    assertEqual(ok.body.retraction.confirmation_id, target, '成功者撤回目标确认');
    assertEqual(lost.body.error.code, 'already_retracted', '竞争落败错误码');
    assertEqual(lost.body.progress.expected_sequence, 2, '落败者收到回退后的权威进度');

    const st = await getSession(base, s.session_id);
    assertEqual(st.retractions.length, 1, '只追加一条撤回事件');
    assertEqual(st.expected_sequence, 2, '期待序号只回退一次');
    assertEqual(st.confirmations.length, 1, '只剩第一条有效确认');
    assertEqual(st.confirmations[0].sequence, 1, '剩余有效确认为第 1 步');
  });

  await t.test('可连续撤回多颗并逐颗重做，历史中同序号存在多条记录但任一时刻只有一条有效', async () => {
    const s = await createSession(base);
    const c1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('multi-r1'),
    });
    const c2 = await postConf(base, s.session_id, {
      sequence: 2, position: 'B2', torque: 4600, idempotency_key: key('multi-r2'),
    });
    const c3 = await postConf(base, s.session_id, {
      sequence: 3, position: 'A3', torque: 4700, idempotency_key: key('multi-r3'),
    });
    const r3 = await postRetract(base, s.session_id, c3.body.confirmation.id);
    assertEqual(r3.status, 200, '撤回第 3 步');
    assertEqual(r3.body.progress.expected_sequence, 3, '回到第 3 步');
    const r2 = await postRetract(base, s.session_id, c2.body.confirmation.id);
    assertEqual(r2.status, 200, '再撤回第 2 步');
    assertEqual(r2.body.progress.expected_sequence, 2, '回到第 2 步');

    const mid = await getSession(base, s.session_id);
    assertEqual(mid.confirmations.length, 1, '只剩一条有效确认');
    assertEqual(mid.retractions.length, 2, '两条撤回审计');

    await postConf(base, s.session_id, {
      sequence: 2, position: 'B2', torque: 4200, idempotency_key: key('multi-r2-fix'),
    });
    await postConf(base, s.session_id, {
      sequence: 3, position: 'A3', torque: 4800, idempotency_key: key('multi-r3-fix'),
    });
    await confirmStepsFrom(base, s.session_id, 4);

    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '连续撤回重做后完成');
    assertEqual(st.confirmations.length, 6, '六条有效记录');
    assertEqual(st.confirmations[1].torque, 4200, '第 2 步为重做值');
    assertEqual(st.confirmations[2].torque, 4800, '第 3 步为重做值');
    assertEqual(st.retractions.length, 2, '两条审计痕迹保留');

    // 数据库层：序号 2、3 在历史上各有两条记录（一条已撤回、一条有效），
    // 有效集合中每个序号仍只有一条。
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      const { rows: history } = await client.query(
        `SELECT sequence,
                count(*)::int AS total,
                count(*) FILTER (WHERE retraction_id IS NULL)::int AS active
         FROM confirmations WHERE session_id = $1
         GROUP BY sequence HAVING count(*) > 1
         ORDER BY sequence`,
        [s.session_id],
      );
      assertEqual(history.length, 2, '序号 2、3 各有历史重确认记录');
      assert(history.every((row) => row.active === 1), '每个重确认序号只有一条有效记录');
      const { rows: dupes } = await client.query(
        `SELECT sequence, count(*)::int AS n FROM confirmations
         WHERE session_id = $1 AND retraction_id IS NULL
         GROUP BY sequence HAVING count(*) > 1`,
        [s.session_id],
      );
      assertEqual(dupes.length, 0, '不存在同一序号两条有效记录');
    } finally {
      await client.end();
    }
  });

  await t.test('撤回后幂等键语义不变：旧键重放返回已撤回的原事件、不推进；新键才允许重做', async () => {
    const s = await createSession(base);
    const oldKey = key('retract-idem');
    const c1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4600, idempotency_key: oldKey,
    });
    assertEqual(c1.status, 201);
    const r = await postRetract(base, s.session_id, c1.body.confirmation.id);
    assertEqual(r.status, 200, '撤回成功');

    // 同一幂等键 + 完全相同载荷重放：仍返回原确认事件（标记已撤回），不重新落库、不推进
    const replay = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4600, idempotency_key: oldKey,
    });
    assertEqual(replay.status, 200, '旧键重放状态码');
    assertEqual(replay.body.replayed, true, '标记为重放');
    assertEqual(replay.body.confirmation.id, c1.body.confirmation.id, '返回原确认事件');
    assertEqual(replay.body.confirmation.retracted, true, '原确认标记为已撤回');
    assertEqual(replay.body.progress.expected_sequence, 1, '重放不推进');

    // 同一幂等键 + 不同载荷仍判冲突
    const conflict = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4700, idempotency_key: oldKey,
    });
    assertEqual(conflict.status, 409, '旧键不同载荷冲突');
    assertEqual(conflict.body.error.code, 'idempotency_conflict', '冲突错误码');

    // 新的提交意图（新幂等键）+ 正确读数才能重做
    const redo = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('retract-idem-fix'),
    });
    assertEqual(redo.status, 201, '新键重做成功');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations[0].torque, 4500, '有效记录为新读数');
    assertEqual(st.retractions.length, 1, '审计保留');
  });

  await t.test('撤回目标不是当前最后一步：409 retraction_target_stale 且不撤回', async () => {
    const s = await createSession(base);
    const c1 = await postConf(base, s.session_id, {
      sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('stale-1'),
    });
    await postConf(base, s.session_id, {
      sequence: 2, position: 'B2', torque: 4500, idempotency_key: key('stale-2'),
    });
    const r = await postRetract(base, s.session_id, c1.body.confirmation.id);
    assertEqual(r.status, 409, '非最后一步状态码');
    assertEqual(r.body.error.code, 'retraction_target_stale', '目标过期错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 2, '不撤回任何记录');
    assertEqual(st.retractions.length, 0, '不产生撤回事件');
  });

  await t.test('撤回事件只增不改：数据库层拒绝撤回事件的 UPDATE/DELETE 及确认字段篡改', async () => {
    const s = await createSession(base);
    await confirmSteps(base, s.session_id, 2);
    const st0 = await getSession(base, s.session_id);
    await postRetract(base, s.session_id, st0.confirmations[1].id);

    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      await assertRejects(
        () => client.query('UPDATE retractions SET sequence = 6'),
        '撤回事件 UPDATE 应被拒绝',
      );
      await assertRejects(
        () => client.query('DELETE FROM retractions'),
        '撤回事件 DELETE 应被拒绝',
      );
      await assertRejects(
        () => client.query('UPDATE confirmations SET torque = 4999 WHERE retraction_id IS NOT NULL'),
        '篡改被撤回确认的扭矩应被拒绝',
      );
      await assertRejects(
        () => client.query(`
          UPDATE confirmations SET retraction_id = 999999, retracted_at = now()
          WHERE retraction_id IS NULL`),
        '伪造撤回标记应被拒绝',
      );
    } finally {
      await client.end();
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.retractions.length, 1, '撤回事件仍在');
    assertEqual(st.confirmations[0].torque, 4500, '确认记录未被篡改');
  });

  await t.test('未知会话撤回返回 404', async () => {
    const r = await postRetract(base, '00000000-0000-0000-0000-000000000000', 1);
    assertEqual(r.status, 404);
    assertEqual(r.body.error.code, 'session_not_found');
  });
}
