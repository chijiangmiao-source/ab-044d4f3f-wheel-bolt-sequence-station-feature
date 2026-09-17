export function createRunner(suiteName) {
  const results = [];
  return {
    async test(name, fn) {
      try {
        await fn();
        results.push({ name, ok: true });
        console.log(`  ✓ ${name}`);
      } catch (err) {
        results.push({ name, ok: false, err });
        console.error(`  ✗ ${name}\n    ${err.message}`);
      }
    },
    summary() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`  [${suiteName}] ${results.length - failed}/${results.length} 通过\n`);
      return failed;
    },
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? '断言失败');
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg ?? '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

export async function assertRejects(fn, msg) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(msg ?? '预期操作被拒绝，但实际成功了');
}
