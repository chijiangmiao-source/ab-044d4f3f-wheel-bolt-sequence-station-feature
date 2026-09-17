import { chromium } from 'playwright';

import { assert, assertEqual } from './helpers.js';

const POSITIONS = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

let woSeq = 0;
const newCode = (tag) => `WO-${tag}-${process.pid}-${Date.now()}-${(woSeq += 1)}`;

/** 页面测试：用真实 Chromium 驱动工位页面。 */
export async function runBrowser(webBase, apiBase, t) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // 每个用例使用独立 BrowserContext：localStorage 互不影响，
  // 等价于另一台触屏 / 清理过浏览器的终端。
  async function freshPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(`${webBase}/`);
    return page;
  }

  async function closePage(page) {
    await page.context().close();
  }

  // 旧客户端流程：无请求体创建（开始无码新会话）
  async function newSessionPage() {
    const page = await freshPage();
    await page.waitForSelector('#entry-panel:not([hidden])');
    await page.click('#btn-new');
    await page.waitForSelector('#work-panel:not([hidden])');
    return page;
  }

  // 工单码进入：输入或扫码后点击「打开复核」
  async function openByWorkOrder(code) {
    const page = await freshPage();
    await page.waitForSelector('#entry-panel:not([hidden])');
    await page.fill('#workorder-input', code);
    await page.click('#btn-open');
    return page;
  }

  async function confirmCurrent(page, torque, unit) {
    if (unit) {
      await page.check(`input[name="unit"][value="${unit}"]`);
    }
    await page.fill('#torque-input', String(torque));
    await page.click('#btn-submit');
  }

  async function currentPosition(page) {
    return (await page.textContent('#current-position')).trim();
  }

  async function serverState(page) {
    const sessionId = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
    assert(sessionId, '页面应已保存会话编号');
    const r = await fetch(`${apiBase}/api/sessions/${sessionId}`);
    assertEqual(r.status, 200, '读取会话状态码');
    return r.json();
  }

  try {
    await t.test('新工单首次打开：从第一颗螺栓开始并显示工单码', async () => {
      const code = newCode('first');
      const page = await openByWorkOrder(code);
      await page.waitForSelector('#work-panel:not([hidden])');
      assertEqual(await currentPosition(page), 'A1', '应从 A1 开始');
      const shown = await page.textContent('#workorder-code');
      assert(shown.includes(code), `顶栏应显示工单码 ${code}`);
      assertEqual(await page.locator('#bolt-list li.done').count(), 0, '没有已确认螺栓');
      const st = await serverState(page);
      assertEqual(st.work_order_code, code, '服务端会话应绑定该工单码');
      assertEqual(st.status, 'in_progress', '服务端为进行中');
      await closePage(page);
    });

    await t.test('完成两步后在另一浏览器输入同一工单码：接续第三颗', async () => {
      const code = newCode('resume');

      // 终端一：打开工单，完成前两颗
      const p1 = await openByWorkOrder(code);
      await p1.waitForSelector('#work-panel:not([hidden])');
      await confirmCurrent(p1, 4500);
      await p1.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await confirmCurrent(p1, 4600);
      await p1.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );

      // 终端二：独立浏览器上下文（等同换触屏/清理浏览器），手输同一工单码
      const p2 = await freshPage();
      await p2.waitForSelector('#entry-panel:not([hidden])');
      await p2.fill('#workorder-input', code);
      await p2.click('#btn-open');
      await p2.waitForSelector('#work-panel:not([hidden])');
      assertEqual(await currentPosition(p2), 'A3', '另一浏览器应接续到第三颗 A3');
      assertEqual(await p2.locator('#bolt-list li.done').count(), 2, '应显示两颗已完成');
      assert(p2 !== p1, '两个终端为独立页面');

      const id1 = await p1.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      const id2 = await p2.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      assertEqual(id2, id1, '两个终端进入的是同一个服务端会话');

      // 终端二直接在第三颗继续，六步全部完成
      for (let i = 2; i < 6; i += 1) {
        await p2.waitForFunction(
          (pos) => document.getElementById('current-position').textContent.trim() === pos,
          POSITIONS[i],
        );
        await confirmCurrent(p2, 4500);
      }
      await p2.waitForSelector('#done-banner:not([hidden])');

      // 终端一刷新后同样读到服务端权威完成态
      await p1.reload();
      await p1.waitForSelector('#done-banner:not([hidden])');
      const st = await serverState(p2);
      assertEqual(st.status, 'completed', '服务端为完成态');
      assertEqual(st.confirmations.length, 6, '六颗螺栓全部确认');

      await closePage(p1);
      await closePage(p2);
    });

    await t.test('一个终端终止工单后，另一终端按同一码恢复终止信息并保持提交关闭', async () => {
      const code = newCode('cancelled-resume');
      const reason = '跨终端恢复终止工单';
      const p1 = await openByWorkOrder(code);
      await p1.waitForSelector('#work-panel:not([hidden])');
      await p1.click('#btn-cancel-open');
      await p1.waitForSelector('#cancel-panel:not([hidden])');
      await p1.fill('#cancel-reason', reason);
      await p1.click('#btn-cancel-confirm');
      await p1.waitForSelector('#cancelled-banner:not([hidden])');
      const sid1 = await p1.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      await closePage(p1);

      const p2 = await openByWorkOrder(code);
      await p2.waitForSelector('#cancelled-banner:not([hidden])');
      const sid2 = await p2.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      assertEqual(sid2, sid1, '另一终端恢复同一服务端会话');
      const banner = await p2.textContent('#cancelled-banner');
      assert(banner.includes(reason), '另一终端展示原终止原因');
      assert(/\d{4}\/\d{1,2}\/\d{1,2}/.test(banner), '另一终端展示终止时间');
      assert(await p2.isHidden('#work-panel'), '终止态不显示扭矩提交面板');
      const st = await serverState(p2);
      assertEqual(st.work_order_code, code, '工单码保持不变');
      assertEqual(st.status, 'cancelled', '服务端保持终止态');
      await closePage(p2);
    });

    await t.test('两个终端并发首次打开同一工单码：只得到同一会话', async () => {
      const code = newCode('race');
      const [p1, p2] = await Promise.all([freshPage(), freshPage()]);
      await Promise.all([
        p1.waitForSelector('#entry-panel:not([hidden])'),
        p2.waitForSelector('#entry-panel:not([hidden])'),
      ]);
      await p1.fill('#workorder-input', code);
      await p2.fill('#workorder-input', code);
      // 同时点击，制造并发首次打开
      await Promise.all([p1.click('#btn-open'), p2.click('#btn-open')]);
      await Promise.all([
        p1.waitForSelector('#work-panel:not([hidden])'),
        p2.waitForSelector('#work-panel:not([hidden])'),
      ]);
      const id1 = await p1.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      const id2 = await p2.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      assertEqual(id1, id2, '并发打开必须得到同一个会话');
      assertEqual(await currentPosition(p1), 'A1', '终端一在第一颗');
      assertEqual(await currentPosition(p2), 'A1', '终端二在第一颗');
      const st = await serverState(p1);
      assertEqual(st.confirmations.length, 0, '新会话没有确认记录');
      await closePage(p1);
      await closePage(p2);
    });

    await t.test('工单码非法时停留在进入区并显示原因', async () => {
      const page = await freshPage();
      await page.waitForSelector('#entry-panel:not([hidden])');

      await page.fill('#workorder-input', '   ');
      await page.click('#btn-open');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('工单码'));
      assert(await page.isVisible('#entry-panel'), '仍停留在进入区');
      assert(await page.isHidden('#work-panel'), '不应出现复核面板');

      // 超长码由服务端拒绝（>64 字符）
      await page.fill('#workorder-input', 'X'.repeat(65));
      await page.click('#btn-open');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('工单码'));
      assert(await page.isVisible('#entry-panel'), '超长码后仍停留进入区');
      await closePage(page);
    });

    await t.test('打开其他工单暂时失败：不覆盖本地已有会话并自动回到原进度', async () => {
      const code = newCode('keep');
      const page = await openByWorkOrder(code);
      await page.waitForSelector('#work-panel:not([hidden])');
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const sidBefore = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');

      // 回到进入区尝试打开另一个工单，但该请求网络失败
      await page.click('#btn-switch');
      await page.waitForSelector('#entry-panel:not([hidden])');
      await page.route('**/api/work-orders/*/session', (route) => route.abort());
      await page.fill('#workorder-input', newCode('unreachable'));
      await page.click('#btn-open');
      await page.waitForSelector('#work-panel:not([hidden])');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('原来的复核会话'));
      assertEqual(await currentPosition(page), 'B2', '失败后仍停在原会话的第二颗');
      const sidAfter = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      assertEqual(sidAfter, sidBefore, '本地会话编号未被覆盖');
      const st = await serverState(page);
      assertEqual(st.work_order_code, code, '仍是原工单码会话');

      // 解除拦截后，输入原工单码仍可接续
      await page.unroute('**/api/work-orders/*/session');
      await page.click('#btn-switch');
      await page.waitForSelector('#entry-panel:not([hidden])');
      await page.fill('#workorder-input', code);
      await page.click('#btn-open');
      await page.waitForSelector('#work-panel:not([hidden])');
      assertEqual(await currentPosition(page), 'B2', '重新打开原工单码接续到 B2');
      await closePage(page);
    });

    await t.test('页面依次完成六颗螺栓并显示「轮毂复核完成」（无码旧流程）', async () => {
      const page = await newSessionPage();
      assertEqual((await page.textContent('#workorder-code')).trim(), '—', '无码会话不显示工单码');
      for (let i = 0; i < 6; i += 1) {
        assertEqual(await currentPosition(page), POSITIONS[i], `第 ${i + 1} 步应复核 ${POSITIONS[i]}`);
        await confirmCurrent(page, 4500);
        if (i < 5) {
          await page.waitForFunction(
            (pos) => document.getElementById('current-position').textContent.trim() === pos,
            POSITIONS[i + 1],
          );
        }
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      const banner = await page.textContent('#done-banner');
      assert(banner.includes('轮毂复核完成'), '应显示完成横幅');
      assertEqual(await page.locator('#confirm-table tbody tr').count(), 6, '应列出六条确认');
      const st = await serverState(page);
      assertEqual(st.status, 'completed', '服务端状态应为完成');
      assertEqual(st.work_order_code, null, '旧流程会话无工单码');
      await closePage(page);
    });

    await t.test('越界扭矩被页面拒绝：显示原因并停留在当前螺栓', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 5000);
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('拒绝'));
      const err = await page.textContent('#error');
      assert(err.includes('4800'), '拒绝原因应说明合格范围');
      assertEqual(await currentPosition(page), 'A1', '仍停留在 A1');
      await confirmCurrent(page, 4199);
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('拒绝'));
      assertEqual(await currentPosition(page), 'A1', '再次拒绝后仍停留在 A1');
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 0, '服务端无确认记录');
      await closePage(page);
    });

    await t.test('N·m 边界读数 42.00 / 48.00 可完成步骤，历史按 cN·m 展示', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, '42.00', 'N·m');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const first = await page.textContent('#bolt-list li.done .meta');
      assert(first.includes('4200 cN·m'), `已完成步骤应按 cN·m 展示，实际：${first}`);
      await confirmCurrent(page, '48.00', 'N·m');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      // 其余步骤回到工位默认 cN·m
      for (let i = 2; i < 6; i += 1) {
        await page.check('input[name="unit"][value="cN·m"]');
        await page.fill('#torque-input', String([4500, 4600, 4400, 4700][i - 2]));
        await page.click('#btn-submit');
        if (i < 5) {
          await page.waitForFunction(
            (pos) => document.getElementById('current-position').textContent.trim() === pos,
            POSITIONS[i + 1],
          );
        }
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      const rows = page.locator('#confirm-table tbody tr');
      assertEqual(await rows.count(), 6, '应列出六条确认');
      assertEqual((await rows.nth(0).locator('td').nth(2).textContent()).trim(), '4200', '第 1 步明细为标准值 4200 cN·m');
      assertEqual((await rows.nth(1).locator('td').nth(2).textContent()).trim(), '4800', '第 2 步明细为标准值 4800 cN·m');
      const st = await serverState(page);
      assertEqual(st.status, 'completed', '服务端状态应为完成');
      assertEqual(st.confirmations[0].torque_input, '42.00', '事件保存原始读数 42.00');
      assertEqual(st.confirmations[0].torque_unit, 'N·m', '事件保存原始单位 N·m');
      assertEqual(st.confirmations[0].torque, 4200, '标准字段为 4200 cN·m');
      await closePage(page);
    });

    await t.test('N·m 读数 41.99 被拒绝并停留在当前螺栓，超过两位小数当场提示', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, '41.99', 'N·m');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('拒绝'));
      const err = await page.textContent('#error');
      assert(err.includes('4199'), `拒绝原因应给出换算后的 cN·m 值，实际：${err}`);
      assertEqual(await currentPosition(page), 'A1', '仍停留在 A1');
      const st0 = await serverState(page);
      assertEqual(st0.confirmations.length, 0, '拒绝不写事件');
      // 精度超限：页面在提交前拦截，不产生请求
      await page.fill('#torque-input', '45.123');
      await page.click('#btn-submit');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('两位小数'));
      assertEqual(await currentPosition(page), 'A1', '精度提示后仍停留在 A1');
      const st1 = await serverState(page);
      assertEqual(st1.confirmations.length, 0, '精度超限不写事件');
      // 修正为合格 N·m 后可继续
      await confirmCurrent(page, '45.00', 'N·m');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await closePage(page);
    });

    await t.test('刷新页面后从服务端恢复权威进度', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await confirmCurrent(page, 4600);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      await page.reload();
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      assertEqual(await page.locator('#bolt-list li.done').count(), 2, '应有两颗已确认');
      await closePage(page);
    });

    await t.test('网络中断时页面以同一幂等键自动重试，服务端不重复记录', async () => {
      const page = await newSessionPage();
      let aborted = 0;
      await page.route('**/api/sessions/*/confirmations', async (route) => {
        if (aborted < 2) {
          aborted += 1;
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
        null,
        { timeout: 30000 },
      );
      assertEqual(aborted, 2, '应发生了两次网络中断重试');
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 1, '重试不产生重复确认');
      await closePage(page);
    });

    await t.test('响应缓慢时触屏连点只记录一次确认', async () => {
      const page = await newSessionPage();
      await page.route('**/api/sessions/*/confirmations', async (route) => {
        await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      await page.fill('#torque-input', '4500');
      await page.click('#btn-submit');
      await page.click('#btn-submit', { force: true }).catch(() => {});
      const st1 = await serverState(page);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 1, '连点只落库一次');
      assert(st1.confirmations.length <= 1, '提交中不应出现重复记录');
      await closePage(page);
    });

    await t.test('完成后刷新仍显示完成状态，且不再出现提交表单', async () => {
      const page = await newSessionPage();
      for (let i = 0; i < 6; i += 1) {
        await page.waitForFunction(
          (pos) => document.getElementById('current-position').textContent.trim() === pos,
          POSITIONS[i],
        );
        await confirmCurrent(page, 4500);
        if (i < 5) {
          await page.waitForFunction(
            (pos) => document.getElementById('current-position').textContent.trim() === pos,
            POSITIONS[i + 1],
          );
        }
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      await page.reload();
      await page.waitForSelector('#done-banner:not([hidden])');
      assert(await page.isHidden('#work-panel'), '完成后不应再显示提交表单');
      await closePage(page);
    });

    await t.test('完成两步后页面终止复核：展示原因与时间、关闭扭矩提交、刷新后保持', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await confirmCurrent(page, 4600);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );

      // 打开终止面板；少于 2 字应被页面拦下，不发请求也不离开当前步
      await page.click('#btn-cancel-open');
      await page.waitForSelector('#cancel-panel:not([hidden])');
      await page.fill('#cancel-reason', '返');
      await page.click('#btn-cancel-confirm');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('2–100'));
      assert(await page.isVisible('#cancel-panel'), '原因过短时留在终止面板');

      // 填写合规原因并确认
      const reason = '装夹错误，拆下返修';
      await page.fill('#cancel-reason', reason);
      await page.click('#btn-cancel-confirm');
      await page.waitForSelector('#cancelled-banner:not([hidden])');
      const banner = await page.textContent('#cancelled-banner');
      assert(banner.includes(reason), '横幅应展示终止原因');
      assert(/\d{4}\/\d{1,2}\/\d{1,2}/.test(banner), '横幅应展示终止时间');
      assert(await page.isHidden('#work-panel'), '扭矩提交面板应关闭');
      assert(await page.isHidden('#btn-submit'), '确认按钮不可用');
      assert(await page.isHidden('#cancel-panel'), '终止填写面板应关闭');

      // 已确认的两步仍标记完成
      assertEqual(await page.locator('#bolt-list li.done').count(), 2, '已完成的两步仍保留');

      // 刷新后原因与终止态保持
      await page.reload();
      await page.waitForSelector('#cancelled-banner:not([hidden])');
      const banner2 = await page.textContent('#cancelled-banner');
      assert(banner2.includes(reason), '刷新后原因保持');
      assert(await page.isHidden('#work-panel'), '刷新后扭矩提交仍关闭');

      // 终止后再提交确认不推进（直连 API 验证页面所见即服务端权威态）
      const sid = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
      const blocked = await fetch(`${apiBase}/api/sessions/${sid}/confirmations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sid,
          sequence: 3,
          position: 'A3',
          torque: 4500,
          idempotency_key: `browser-after-cancel-${Date.now()}`,
        }),
      });
      assertEqual(blocked.status, 409, '终止后确认应被拒绝');
      assertEqual((await blocked.json()).error.code, 'session_cancelled', '错误码为 session_cancelled');
      const st = await serverState(page);
      assertEqual(st.status, 'cancelled', '服务端保持已终止');
      assertEqual(st.confirmations.length, 2, '确认不推进、不写事件');
      await page.close();
    });

    await t.test('完成两步后撤回第二步、以新扭矩重做后完成；刷新只见有效记录并保留审计痕迹', async () => {
      const page = await newSessionPage();
      // 尚无任何确认时，撤回入口不显示
      assert(await page.isHidden('#btn-retract-open'), '零确认时不应出现撤回入口');
      // 第 1 步正常，第 2 步抄错为 4600
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      assert(await page.isVisible('#btn-retract-open'), '已有确认后应出现「撤回上一步」');
      await confirmCurrent(page, 4600);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );

      // 撤回入口仅在已有确认且未完成时出现
      assert(await page.isVisible('#btn-retract-open'), '已确认后应出现「撤回上一步」');

      // 二次确认：先弹确认面板，详情指明将撤回的步骤与读数
      await page.click('#btn-retract-open');
      await page.waitForSelector('#retract-panel:not([hidden])');
      const detail = await page.textContent('#retract-detail');
      assert(detail.includes('第 2 步'), `面板应说明撤回第 2 步，实际：${detail}`);
      assert(detail.includes('B2'), `面板应说明位置 B2，实际：${detail}`);
      assert(detail.includes('4600'), `面板应说明原读数 4600，实际：${detail}`);
      // 「返回继续复核」不撤回
      await page.click('#btn-retract-back');
      await page.waitForSelector('#retract-panel', { state: 'hidden' });
      let st0 = await serverState(page);
      assertEqual(st0.confirmations.length, 2, '返回后不撤回任何记录');

      // 真正二次确认撤回
      await page.click('#btn-retract-open');
      await page.waitForSelector('#retract-panel:not([hidden])');
      await page.click('#btn-retract-confirm');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const notice = await page.textContent('#notice');
      assert(notice.includes('撤回'), `应提示已撤回，实际：${notice}`);
      assertEqual(await page.locator('#bolt-list li.done').count(), 1, '撤回后只剩一颗已确认');
      assert(await page.isVisible('#work-panel'), '回到原扭矩确认入口');
      // 进行中也能看到审计痕迹
      assert(await page.isVisible('#retractions-panel'), '进行中应显示撤回审计区');
      const auditMid = await page.textContent('#retractions-table');
      assert(auditMid.includes('4600'), `审计应保留原读数 4600，实际：${auditMid}`);

      // 仍从原确认入口以新读数重做第二步
      await confirmCurrent(page, 4700);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      // 完成剩余步骤
      for (let i = 2; i < 6; i += 1) {
        await page.waitForFunction(
          (pos) => document.getElementById('current-position').textContent.trim() === pos,
          POSITIONS[i],
        );
        await confirmCurrent(page, 4500);
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      assert(await page.isHidden('#btn-retract-open'), '完成后撤回入口消失');
      const rows = page.locator('#confirm-table tbody tr');
      assertEqual(await rows.count(), 6, '完成表列出六条有效确认');
      assertEqual(
        (await rows.nth(1).locator('td').nth(2).textContent()).trim(),
        '4700',
        '第 2 步显示重做后的 4700',
      );
      const bodyText = await page.textContent('#done-banner');
      assert(!bodyText.includes('4600'), '完成明细不应出现被撤回的 4600');

      // 刷新后：有效记录为重做后的，审计痕迹仍在
      await page.reload();
      await page.waitForSelector('#done-banner:not([hidden])');
      await page.waitForSelector('#retractions-panel:not([hidden])');
      const auditRows = page.locator('#retractions-table tbody tr');
      assertEqual(await auditRows.count(), 1, '保留一条撤回审计');
      const audit = await page.textContent('#retractions-table');
      assert(audit.includes('4600'), '审计保留原读数 4600');
      assert(audit.includes('B2'), '审计保留位置 B2');
      const st = await serverState(page);
      assertEqual(st.status, 'completed', '服务端为完成态');
      assertEqual(st.confirmations.length, 6, '服务端六条有效确认');
      assertEqual(st.confirmations[1].torque, 4700, '服务端第 2 步为重做值');
      assert(!st.confirmations.some((c) => c.torque === 4600), '服务端不返回被撤回记录');
      assertEqual(st.retractions.length, 1, '服务端返回一条撤回审计');
      assertEqual(st.retractions[0].torque, 4600, '服务端审计保留原读数');
      await closePage(page);
    });

    await t.test('撤回失败时保留最新权威进度且不清除当前输入', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const sid = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');

      // 在输入框里先填好准备重做/录入的读数，失败后不得被清空
      await page.fill('#torque-input', '4555');

      // 另一请求（如并发操作）先把唯一的确认撤回，页面随后撤回已无可撤回记录
      const got = await fetch(`${apiBase}/api/sessions/${sid}`);
      const before = await got.json();
      const r = await fetch(`${apiBase}/api/sessions/${sid}/confirmations/last/retract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation_id: before.confirmations[0].id }),
      });
      assertEqual(r.status, 200, '并发撤回先行成功');

      await page.click('#btn-retract-open');
      await page.waitForSelector('#retract-panel:not([hidden])');
      await page.click('#btn-retract-confirm');
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('撤回失败'));
      const err = await page.textContent('#error');
      assert(
        err.includes('暂无可撤回') || err.includes('已被撤回'),
        `应给出明确原因，实际：${err}`,
      );
      // 页面以最新权威进度对齐：回到 A1
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A1',
      );
      assertEqual(await page.locator('#bolt-list li.done').count(), 0, '权威进度无有效确认');
      assertEqual(
        await page.inputValue('#torque-input'),
        '4555',
        '失败后当前输入不被清除',
      );
      const st = await serverState(page);
      assertEqual(st.expected_sequence, 1, '服务端期待序号为 1');
      assertEqual(st.confirmations.length, 0, '服务端无有效确认');
      assertEqual(st.retractions.length, 1, '先行撤回的审计仍保留');
      await closePage(page);
    });

    await t.test('可连续撤回两颗并逐颗重做，撤回面板在进行中可用、完成后消失', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await confirmCurrent(page, 4600);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      await confirmCurrent(page, 4700);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B1',
      );

      // 撤回第 3 步
      await page.click('#btn-retract-open');
      await page.waitForSelector('#retract-panel:not([hidden])');
      await page.click('#btn-retract-confirm');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      // 再撤回第 2 步
      await page.click('#btn-retract-open');
      await page.click('#btn-retract-confirm');
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      assertEqual(await page.locator('#bolt-list li.done').count(), 1, '连撤两颗后剩一颗');
      assertEqual(await page.locator('#retractions-table tbody tr').count(), 2, '两条审计');

      // 逐颗重做并完成整轮
      await confirmCurrent(page, 4200);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      await confirmCurrent(page, 4800);
      for (let i = 3; i < 6; i += 1) {
        await page.waitForFunction(
          (pos) => document.getElementById('current-position').textContent.trim() === pos,
          POSITIONS[i],
        );
        await confirmCurrent(page, 4500);
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      await page.waitForSelector('#retractions-panel:not([hidden])');
      assertEqual(await page.locator('#retractions-table tbody tr').count(), 2, '完成后两条审计保留');
      const st = await serverState(page);
      assertEqual(st.status, 'completed', '连续撤回重做后完成');
      assertEqual(st.confirmations[1].torque, 4200, '第 2 步为重做值');
      assertEqual(st.confirmations[2].torque, 4800, '第 3 步为重做值');
      await closePage(page);
    });

    await t.test('旧客户端只使用原三个接口：新建会话后按原六步完成', async () => {
      // 模拟没有终止功能的旧客户端：只用 POST /sessions、GET /sessions/:id、
      // POST /confirmations，且按原载荷/原字段解析响应，全程不调用 /cancel。
      const page = await browser.newPage();
      page.setDefaultTimeout(20000);
      await page.goto(`${webBase}/`);
      const result = await page.evaluate(async (positions) => {
        const out = { steps: [] };
        const created = await fetch('/api/sessions', { method: 'POST' });
        if (created.status !== 201) { out.error = `create ${created.status}`; return out; }
        const s = await created.json();
        out.initialSeq = s.expected_sequence;
        out.initialPos = s.expected_position;
        for (let i = 0; i < 6; i += 1) {
          const r = await fetch(`/api/sessions/${s.session_id}/confirmations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              session_id: s.session_id,
              sequence: i + 1,
              position: positions[i],
              torque: 4500,
              idempotency_key: `legacy-${i}-${Date.now()}-${Math.random()}`,
            }),
          });
          const body = await r.json();
          out.steps.push({ status: r.status, replayed: body.replayed, seq: body.confirmation?.sequence });
          if (r.status !== 201 || body.replayed !== false) { out.error = `step ${i + 1} bad`; return out; }
        }
        const final = await fetch(`/api/sessions/${s.session_id}`);
        out.finalStatus = final.status;
        const fj = await final.json();
        out.status = fj.status;
        out.events = fj.confirmations.length;
        return out;
      }, POSITIONS);
      assertEqual(result.error, undefined, `旧客户端流程不应出错：${result.error ?? ''}`);
      assertEqual(result.initialSeq, 1, '初始期待序号仍为 1');
      assertEqual(result.initialPos, 'A1', '初始期待位置仍为 A1');
      assertEqual(result.steps.length, 6, '六步均提交');
      assertEqual(result.finalStatus, 200, '查询接口仍为 200');
      assertEqual(result.status, 'completed', '旧客户端可正常完成六步');
      assertEqual(result.events, 6, '六条确认事件');
      await page.close();
    });
  } finally {
    await browser.close();
  }
}
