import { createApp } from './app.js';
import { pool } from './db.js';

const port = Number(process.env.PORT || 3000);

async function waitForDb(attempts = 30) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      console.log(`等待数据库就绪（${i}/${attempts}）…`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('数据库不可用，放弃启动');
}

await waitForDb();
const app = createApp();
app.listen(port, () => {
  console.log(`轮毂复核 API 已监听 :${port}`);
});
