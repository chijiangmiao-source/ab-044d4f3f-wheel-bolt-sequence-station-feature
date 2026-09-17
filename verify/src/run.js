import { createRunner } from './helpers.js';
import { runProtocol } from './protocol.js';
import { runBrowser } from './browser.js';

const API_BASE = process.env.API_BASE || 'http://api:3000';
const WEB_BASE = process.env.WEB_BASE || 'http://web';

async function waitFor(url, name, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        console.log(`[verify] ${name} 就绪（${url}）`);
        return;
      }
    } catch {
      // 尚未就绪，继续等待
    }
    if (Date.now() > deadline) throw new Error(`等待 ${name} 就绪超时（${url}）`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

await waitFor(`${API_BASE}/healthz`, 'api');
await waitFor(`${WEB_BASE}/`, 'web');

let failed = 0;

console.log('\n== 协议测试（API） ==');
const t1 = createRunner('protocol');
await runProtocol(API_BASE, t1);
failed += t1.summary();

console.log('== 页面测试（真实浏览器） ==');
const t2 = createRunner('browser');
await runBrowser(WEB_BASE, API_BASE, t2);
failed += t2.summary();

if (failed > 0) {
  console.error(`[verify] 共 ${failed} 项未通过`);
  process.exit(1);
}
console.log('[verify] 全部验收用例通过');
