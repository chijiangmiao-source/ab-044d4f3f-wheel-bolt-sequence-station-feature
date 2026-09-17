'use strict';

/*
 * 轮毂复核工位页面逻辑。
 *
 * 进入方式：
 * - 按工单码「打开复核」：POST /api/work-orders/{code}/session，
 *   已绑定则接续原会话，未绑定则从第一颗开始新建；刷新、换浏览器、换触屏后
 *   都以服务端返回的权威进度为准。
 * - 旧的「开始无码新会话」：POST /api/sessions，协议保持不变。
 *
 * 重试语义（与 README 一致）：
 * - 每次“用户提交意图”生成一个幂等键；网络异常导致的自动重试复用同一键，
 *   服务端据此去重：同键同载荷返回原确认，同键不同载荷判定冲突。
 * - 任何确定性拒绝（迟到/越序/位置不符/扭矩越界等）都不重试，
 *   展示拒绝原因并重新拉取服务端权威进度对齐页面。
 * - 页面刷新后从服务端重新读取进度；完成判定只以服务端状态为准。
 */

const SESSION_KEY = 'hub_review.session_id';
const WORK_ORDER_KEY = 'hub_review.work_order_code';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 6; // 首次 + 5 次自动重试（同一幂等键）

const UNIT_CNM = 'cN·m';
const UNIT_NM = 'N·m';
// 工位默认录入单位保持 cN·m；操作工可切换到 N·m（最多两位小数）
const DEFAULT_UNIT = UNIT_CNM;
// 各单位的输入约束（N·m 为 cN·m 合格范围除以 100）
const UNIT_RULES = {
  [UNIT_CNM]: {
    label: '扭矩（cN·m，合格范围 4200–4800，含边界）',
    step: '1', min: '4200', max: '4800', placeholder: '例如 4500',
  },
  [UNIT_NM]: {
    label: '扭矩（N·m，合格范围 42.00–48.00，含边界，最多两位小数）',
    step: '0.01', min: '42.00', max: '48.00', placeholder: '例如 45.00',
  },
};

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: localStorage.getItem(SESSION_KEY),
  workOrderCode: localStorage.getItem(WORK_ORDER_KEY),
  view: null, // 服务端权威进度
  busy: false, // 是否有提交在途（含自动重试）
  cancelFormOpen: false, // 是否打开了终止原因填写面板
  cancelling: false, // 终止请求是否在途
  retractFormOpen: false, // 是否打开了撤回二次确认面板
  retracting: false, // 撤回请求是否在途
  opening: false, // 是否有「打开复核 / 开始会话」请求在途
  unit: DEFAULT_UNIT,
};

// 「打开其他工单」时暂存的本地现场：新工单打开失败则恢复原会话
let suspended = null;

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // 非安全上下文（如内网 http）下的退化实现
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showNotice(msg) {
  $('notice').textContent = msg || '';
}

function showError(msg) {
  $('error').textContent = msg || '';
}

function clearMessages() {
  showNotice('');
  showError('');
}

async function fetchJson(path, options) {
  const res = await fetch(`/api${path}`, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 进入一个会话视图：记录会话与工单码并渲染。 */
function adoptSession(body, notice) {
  suspended = null;
  state.sessionId = body.session_id;
  state.workOrderCode = body.work_order_code ?? null;
  state.view = body;
  state.cancelFormOpen = false;
  state.retractFormOpen = false;
  localStorage.setItem(SESSION_KEY, state.sessionId);
  if (state.workOrderCode) {
    localStorage.setItem(WORK_ORDER_KEY, state.workOrderCode);
  } else {
    localStorage.removeItem(WORK_ORDER_KEY);
  }
  state.unit = DEFAULT_UNIT;
  $('torque-input').value = '';
  renderUnitControls();
  if (notice) showNotice(notice);
}

/** 回到进入区：暂存本地现场但不清服务端会话；新工单打开失败可恢复，输同一码也可接续。 */
function backToEntry(notice) {
  if (state.view) {
    suspended = {
      sessionId: state.sessionId,
      workOrderCode: state.workOrderCode,
      view: state.view,
    };
    state.sessionId = null;
    state.workOrderCode = null;
    state.view = null;
    state.cancelFormOpen = false;
    state.retractFormOpen = false;
    $('torque-input').value = '';
    $('workorder-input').value = '';
  }
  clearMessages();
  if (notice) showNotice(notice);
  render();
}

/** 新工单打开失败时恢复「打开其他工单」前暂存的本地会话现场。 */
function restoreSuspended(reason) {
  if (!suspended) return false;
  Object.assign(state, {
    sessionId: suspended.sessionId,
    workOrderCode: suspended.workOrderCode,
    view: suspended.view,
  });
  suspended = null;
  showError(`${reason}，已保持在原来的复核会话`);
  return true;
}

/** 从服务端重新读取权威进度并渲染。 */
async function refresh() {
  if (!state.sessionId) {
    state.view = null;
    render();
    return;
  }
  try {
    const { status, body } = await fetchJson(`/sessions/${state.sessionId}`);
    if (status === 404) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(WORK_ORDER_KEY);
      state.sessionId = null;
      state.workOrderCode = null;
      state.view = null;
      showNotice('原会话已不存在，请按工单码打开或开始新会话');
    } else if (status === 200) {
      state.view = body;
    } else {
      showError('读取进度失败，请稍后点击「刷新进度」');
    }
  } catch {
    showError('无法连接服务器，页面进度可能不是最新');
  }
  render();
}

/** 切换录入单位：cN·m 为工位默认，N·m 限两位小数。 */
function switchUnit(unit) {
  if (!UNIT_RULES[unit] || state.busy || unit === state.unit) return;
  state.unit = unit;
  $('torque-input').value = '';
  clearMessages();
  renderUnitControls();
}

function renderUnitControls() {
  const rule = UNIT_RULES[state.unit];
  const input = $('torque-input');
  $('torque-label').textContent = rule.label;
  input.step = rule.step;
  input.min = rule.min;
  input.max = rule.max;
  input.placeholder = rule.placeholder;
  document.querySelectorAll('input[name="unit"]').forEach((radio) => {
    radio.checked = radio.value === state.unit;
    radio.disabled = state.busy;
  });
}

/** 按当前单位校验输入；N·m 只接受最多两位小数。通过时返回录入原文以保真发送。 */
function parseReading(raw) {
  if (raw === '') return { ok: false, message: '请输入扭矩值' };
  if (state.unit === UNIT_CNM) {
    if (!/^\d+$/.test(raw)) {
      return { ok: false, message: 'cN·m 读数必须为整数（例如 4500）' };
    }
    if (!Number.isSafeInteger(Number(raw))) {
      return { ok: false, message: 'cN·m 读数超出可处理范围' };
    }
    return { ok: true, value: raw };
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    return { ok: false, message: 'N·m 读数最多保留两位小数（例如 45.00）' };
  }
  return { ok: true, value: raw };
}

/** 按工单码打开复核：已绑定接续，未绑定从第一颗新建。失败时不覆盖本地已有会话。 */
async function openByWorkOrder() {
  if (state.opening) return;
  clearMessages();
  const code = $('workorder-input').value.trim();
  if (code === '') {
    // 非法工单码：停留在进入区并显示原因
    showError('工单码不能为空');
    render();
    return;
  }

  state.opening = true;
  render();
  try {
    let status;
    let body;
    try {
      ({ status, body } = await fetchJson(
        `/work-orders/${encodeURIComponent(code)}/session`,
        { method: 'POST' },
      ));
    } catch {
      // 查询或创建暂时失败：保留本地已有会话，不覆盖
      if (restoreSuspended('打开复核失败（网络异常），请稍后重试')) {
        await refresh(); // 以服务端权威进度对齐恢复后的会话
      } else {
        showError('打开复核失败（网络异常），请稍后重试');
        if (state.view) showNotice('仍显示本地会话的最近进度，请点击「刷新进度」对齐');
      }
      return;
    }
    if (status === 200) {
      suspended = null;
      adoptSession(body, `已按工单码 ${code} 接续已有复核会话`);
    } else if (status === 201) {
      suspended = null;
      adoptSession(body, `已按工单码 ${code} 创建复核会话，请从第一颗螺栓开始`);
    } else if (status === 400 && body && body.error && body.error.code === 'invalid_work_order_code') {
      // 工单码非法：停留在进入区并显示原因（不恢复现场，方便改码后重试）
      showError(`工单码无效：${body.error.message}`);
    } else {
      // 其他暂时失败：不覆盖本地已有会话
      const reason = (body && body.error && body.error.message) || `HTTP ${status}`;
      if (restoreSuspended(`打开复核暂时失败：${reason}`)) {
        await refresh();
      } else {
        showError(`打开复核暂时失败：${reason}；本地当前会话未被改动`);
      }
    }
  } finally {
    state.opening = false;
    render();
  }
}

async function startSession() {
  if (state.opening) return;
  clearMessages();
  state.opening = true;
  render();
  try {
    const { status, body } = await fetchJson('/sessions', { method: 'POST' });
    if (status !== 201) {
      showError('创建会话失败，请重试');
    } else {
      adoptSession(body, '新会话已开始，请按顺序复核六颗螺栓');
    }
  } catch {
    showError('创建会话失败，请重试');
  } finally {
    state.opening = false;
    render();
  }
}

/** 提交当前螺栓的复核确认；网络异常时以同一幂等键自动重试。 */
async function submitConfirmation() {
  if (state.busy || !state.view || state.view.status !== 'in_progress') return;

  const raw = $('torque-input').value.trim();
  const parsed = parseReading(raw);
  if (!parsed.ok) {
    showError(parsed.message);
    return;
  }

  clearMessages();
  // 一次提交意图 = 一个幂等键；自动重试不得更换
  const attempt = {
    session_id: state.sessionId,
    sequence: state.view.expected_sequence,
    position: state.view.expected_position,
    torque: parsed.value,
    unit: state.unit,
    idempotency_key: uuid(),
  };

  state.busy = true;
  render();
  try {
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      try {
        const res = await fetch(`/api/sessions/${state.sessionId}/confirmations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await res.json().catch(() => null);
        if (res.ok) {
          await refresh();
          $('torque-input').value = '';
          showNotice(
            body && body.replayed
              ? `第 ${attempt.sequence} 步已确认（网络重试，服务端去重）`
              : `第 ${attempt.sequence} 步确认成功`,
          );
          return;
        }
        // 确定性拒绝：不重试，展示原因并以权威进度对齐
        const message = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        showError(`第 ${attempt.sequence} 步被拒绝：${message}`);
        await refresh();
        return;
      } catch {
        if (i === MAX_ATTEMPTS) {
          showError('网络异常，多次重试仍失败；请检查网络后重新提交');
          await refresh(); // 之前的尝试可能已落库，以服务端为准
          return;
        }
        const delay = Math.min(500 * 2 ** (i - 1), 4000);
        showNotice(`网络异常，${delay / 1000}s 后自动重试（第 ${i} 次）…`);
        await sleep(delay);
      }
    }
  } finally {
    state.busy = false;
    render();
  }
}

/** 打开/关闭终止原因填写面板。 */
function setCancelForm(open) {
  state.cancelFormOpen = open;
  if (open) {
    $('cancel-reason').value = '';
    showError('');
  }
  render();
  if (open) $('cancel-reason').focus();
}

function cancelReasonLength() {
  return [...$('cancel-reason').value.trim()].length;
}

/** 带原因终止复核；成功后展示终止时间与原因，扭矩提交随之关闭。 */
async function cancelSession() {
  if (state.cancelling || !state.view || state.view.status !== 'in_progress') return;
  const reason = $('cancel-reason').value.trim();
  const len = [...reason].length;
  if (len < 2 || len > 100) {
    showError('终止原因须为 2–100 字');
    return;
  }

  clearMessages();
  state.cancelling = true;
  render();
  try {
    const { status, body } = await fetchJson(`/sessions/${state.sessionId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (status === 200) {
      state.cancelFormOpen = false;
      await refresh();
      showNotice(body && body.replayed ? '该会话此前已终止' : '会话已终止复核');
    } else {
      const message = (body && body.error && body.error.message) || `HTTP ${status}`;
      showError(`终止失败：${message}`);
      // 确定性失败（如已完成/已终止）不重试，以服务端权威进度对齐
      await refresh();
    }
  } catch {
    showError('网络异常，终止请求未送达，请点击「刷新进度」后重试');
  } finally {
    state.cancelling = false;
    render();
  }
}

/** 打开/关闭撤回上一步二次确认面板。 */
function setRetractForm(open) {
  state.retractFormOpen = open;
  if (open) {
    showError('');
    const last = lastConfirmation();
    if (last) {
      $('retract-summary').textContent =
        `将撤回第 ${last.sequence} 步（${last.position}）已提交的读数 ${last.torque} cN·m。`;
    }
  }
  render();
}

/** 当前最后一条有效确认（未撤回）；无确认时返回 null。 */
function lastConfirmation() {
  const list = state.view && Array.isArray(state.view.confirmations) ? state.view.confirmations : [];
  return list.length > 0 ? list[list.length - 1] : null;
}

/** 撤回当前最后一条有效确认；成功后以服务端权威进度回到该颗，原入口可立即重新确认。 */
async function retractLast() {
  if (state.retracting || !state.view || state.view.status !== 'in_progress') return;
  const last = lastConfirmation();
  if (!last) return;

  clearMessages();
  state.retracting = true;
  render();
  try {
    // 携带发起撤回时看到的最后确认序号作为乐观令牌：并发撤回只有一个请求生效
    const { status, body } = await fetchJson(
      `/sessions/${state.sessionId}/confirmations/last/retract`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: state.sessionId, sequence: last.sequence }),
      },
    );
    if (status === 200) {
      state.retractFormOpen = false;
      // 直接采用服务端返回的权威进度、有效确认与审计列表（无需再次拉取）；
      // 不清空当前输入，随后仍从原确认入口提交新读数
      state.view = {
        ...state.view,
        status: body.progress.status,
        confirmed_count: body.progress.confirmed_count,
        expected_sequence: body.progress.expected_sequence,
        expected_position: body.progress.expected_position,
        confirmations: body.confirmations,
        retractions: body.retractions,
      };
      showNotice(`已撤回第 ${body.retraction.sequence} 步，请重新录入正确读数并确认`);
      // 聚焦并选中输入框内旧读数，便于直接覆盖录入；不强制清空
      $('torque-input').focus();
      $('torque-input').select();
    } else {
      // 无可撤回记录 / 已完成 / 并发请求已先撤回等：展示明确原因，
      // 保留最新权威进度，且不清除当前输入
      const message = (body && body.error && body.error.message) || `HTTP ${status}`;
      showError(`撤回失败：${message}`);
      state.retractFormOpen = false;
      await refresh();
    }
  } catch {
    showError('网络异常，撤回请求未送达，请点击「刷新进度」确认当前状态后重试');
  } finally {
    state.retracting = false;
    render();
  }
}

function render() {
  const view = state.view;
  $('session-id').textContent = state.sessionId ? state.sessionId.slice(0, 8) : '—';
  $('session-id').title = state.sessionId || '';
  $('workorder-code').textContent = state.workOrderCode || '—';
  $('workorder-code').title = state.workOrderCode || '';

  // 进入区只在没有会话视图时显示；进入会话后整个复核链路复用原有展示
  $('entry-panel').hidden = Boolean(view);
  $('btn-switch').hidden = !view;

  const list = $('bolt-list');
  list.textContent = '';
  if (view) {
    view.positions.forEach((pos, i) => {
      const li = document.createElement('li');
      const confirmed = view.confirmations[i];
      const cls = confirmed ? 'done' : i === view.confirmed_count && view.status === 'in_progress' ? 'current' : 'pending';
      li.className = cls;
      const posSpan = document.createElement('span');
      posSpan.className = 'pos';
      posSpan.textContent = pos;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = confirmed
        ? `✓ ${confirmed.torque} cN·m`
        : cls === 'current'
          ? '待复核'
          : `第 ${i + 1} 步`;
      li.append(posSpan, meta);
      list.appendChild(li);
    });
    $('progress-text').textContent = `已确认 ${view.confirmed_count} / 6`;
  } else {
    $('progress-text').textContent = '';
  }

  const inProgress = Boolean(view) && view.status === 'in_progress';
  const hasConfirmation = Boolean(view) && Array.isArray(view.confirmations) && view.confirmations.length > 0;
  $('work-panel').hidden = !inProgress || state.cancelFormOpen || state.retractFormOpen;
  if (inProgress) {
    $('current-position').textContent = view.expected_position;
    $('current-seq').textContent = String(view.expected_sequence);
  }

  // 撤回上一步：仅进行中且已有至少一条有效确认时可用；已完成时不显示
  $('btn-retract-open').hidden = !(inProgress && hasConfirmation);
  $('retract-panel').hidden = !inProgress || !state.retractFormOpen;

  // 终止原因填写面板仅在进行中会话上可打开
  $('cancel-panel').hidden = !inProgress || !state.cancelFormOpen;
  if (!state.cancelFormOpen) {
    $('cancel-reason').value = '';
    $('cancel-reason-hint').textContent = '';
  }

  const cancelled = Boolean(view) && view.status === 'cancelled';
  $('cancelled-banner').hidden = !cancelled;
  if (cancelled) {
    $('cancelled-at').textContent = new Date(view.cancelled_at).toLocaleString('zh-CN', { hour12: false });
    $('cancelled-reason').textContent = view.cancel_reason;
  }

  const completed = Boolean(view) && view.status === 'completed';
  $('done-banner').hidden = !completed;
  if (completed) {
    const tbody = $('confirm-table').querySelector('tbody');
    tbody.textContent = '';
    for (const c of view.confirmations) {
      const tr = document.createElement('tr');
      for (const text of [
        c.sequence,
        c.position,
        c.torque,
        new Date(c.confirmed_at).toLocaleString('zh-CN', { hour12: false }),
        `${c.idempotency_key.slice(0, 8)}…`,
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // 撤回审计痕迹：进行中/已完成/已终止视图都展示，刷新后仍在
  const retractions = view && Array.isArray(view.retractions) ? view.retractions : [];
  $('retractions-panel').hidden = retractions.length === 0;
  if (retractions.length > 0) {
    const tbody = $('retractions-table').querySelector('tbody');
    tbody.textContent = '';
    for (const r of retractions) {
      const tr = document.createElement('tr');
      for (const text of [
        r.sequence,
        r.position,
        `${r.torque} cN·m`,
        new Date(r.retracted_at).toLocaleString('zh-CN', { hour12: false }),
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  $('btn-submit').disabled = state.busy || !inProgress;
  $('torque-input').disabled = state.busy || !inProgress;
  $('btn-retract-open').disabled =
    state.busy || state.retracting || state.cancelling || state.opening || !inProgress || !hasConfirmation;
  $('btn-retract-confirm').disabled = state.retracting;
  $('btn-retract-back').disabled = state.retracting;
  $('btn-cancel-open').disabled =
    state.busy || state.cancelling || state.retracting || state.opening || !inProgress;
  $('btn-refresh').disabled = state.busy || state.cancelling || state.retracting || state.opening;
  $('btn-cancel-confirm').disabled = state.cancelling;
  $('btn-cancel-back').disabled = state.cancelling;
  $('btn-switch').disabled =
    state.busy || state.cancelling || state.retracting || state.opening;
  $('btn-open').disabled = state.busy || state.opening;
  $('btn-new').disabled = state.busy || state.opening;
  $('workorder-input').disabled = state.busy || state.opening;
  document.querySelectorAll('input[name="unit"]').forEach((radio) => {
    radio.disabled =
      state.busy || state.cancelling || state.retracting || state.opening || !inProgress;
  });
}

/** 启动时恢复：优先按本地工单码向服务端打开权威会话；无码则按旧方式读取会话。 */
async function restore() {
  if (state.workOrderCode) {
    state.opening = true;
    render();
    try {
      let status;
      let body;
      try {
        ({ status, body } = await fetchJson(
          `/work-orders/${encodeURIComponent(state.workOrderCode)}/session`,
          { method: 'POST' },
        ));
      } catch {
        // 暂时打不开：若本地还有会话编号，退回按编号读取，不丢失现场
        if (state.sessionId) {
          showError('按工单码接续失败（网络异常），已尝试读取本地会话进度');
          await refresh();
        } else {
          showError('无法连接服务器，暂时无法按工单码接续，请稍后重试');
          render();
        }
        return;
      }
      if (status === 200 || status === 201) {
        adoptSession(body);
      } else if (status === 400 && body && body.error && body.error.code === 'invalid_work_order_code') {
        // 本地保存的码已不合法：停留在进入区
        localStorage.removeItem(WORK_ORDER_KEY);
        state.workOrderCode = null;
        showError(`本地保存的工单码无效：${body.error.message}，请重新输入`);
      } else if (state.sessionId) {
        const reason = (body && body.error && body.error.message) || `HTTP ${status}`;
        showError(`按工单码接续暂时失败：${reason}，已尝试读取本地会话进度`);
        await refresh();
      } else {
        showError('按工单码接续暂时失败，请稍后重试');
      }
    } finally {
      state.opening = false;
      render();
    }
    return;
  }
  await refresh();
}

window.addEventListener('DOMContentLoaded', () => {
  $('btn-open').addEventListener('click', openByWorkOrder);
  $('btn-new').addEventListener('click', startSession);
  $('btn-switch').addEventListener('click', () => backToEntry('请输入新的轮毂工单码'));
  $('btn-refresh').addEventListener('click', refresh);
  $('btn-submit').addEventListener('click', submitConfirmation);
  $('workorder-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openByWorkOrder();
  });
  document.querySelectorAll('input[name="unit"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) switchUnit(radio.value);
    });
  });
  $('torque-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitConfirmation();
  });
  $('btn-cancel-open').addEventListener('click', () => setCancelForm(true));
  $('btn-cancel-back').addEventListener('click', () => setCancelForm(false));
  $('btn-cancel-confirm').addEventListener('click', cancelSession);
  $('btn-retract-open').addEventListener('click', () => setRetractForm(true));
  $('btn-retract-back').addEventListener('click', () => setRetractForm(false));
  $('btn-retract-confirm').addEventListener('click', retractLast);
  $('cancel-reason').addEventListener('input', () => {
    const len = cancelReasonLength();
    $('cancel-reason-hint').textContent =
      len === 0 ? '' : `${len} / 100 字（需 2–100 字）`;
  });
  renderUnitControls();
  restore();
});
