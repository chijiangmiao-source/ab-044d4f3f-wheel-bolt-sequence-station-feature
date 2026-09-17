/*
 * 录入单位与精确扭矩换算。
 *
 * 现场部分数显扳手只显示 N·m，允许操作工直接录入 N·m（最多两位小数）。
 * 服务端在任何业务判定之前，先把读数精确换算为整数 cN·m（1 N·m = 100 cN·m），
 * 之后顺序、范围、幂等判定全部沿用既有整数逻辑。
 *
 * 换算不能用浮点：41.99 * 100 在 JS 中为 4198.9999…。因此直接对 JSON 数字
 * 的原文（十进制字符串）用 BigInt 精确处理，能够可靠识别：
 * - 小数位超过两位（精度超限，如 45.123）；
 * - 数值超出安全整数范围（无法精确换算）。
 */

export const UNIT_CNM = 'cN·m';
export const UNIT_NM = 'N·m';
export const INPUT_UNITS = Object.freeze([UNIT_CNM, UNIT_NM]);
export const DEFAULT_UNIT = UNIT_CNM;
export const NM_MAX_DECIMALS = 2;

const NUMBER_TOKEN_RE =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const JSON_WS = /[\t\n\r ]/;
const DECIMAL_RE = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * 读取请求体中 torque 字段的原始 JSON 记号。扫描时正确跳过字符串字面量，
 * 因此 idempotency_key 等字段值里出现 "torque" 文本不会被误认；
 * 重复键取最后一个，与 JSON.parse 的覆盖语义一致。
 * @returns {{kind:'number', token:string}|{kind:'string'}|null}
 */
export function readTorqueToken(rawBody) {
  const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : null;
  if (!text) return null;

  let found = null;
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '"') {
      i += 1;
      continue;
    }
    // 跳过一个 JSON 字符串字面量（处理转义）
    const strStart = i;
    i += 1;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') break;
      i += 1;
    }
    const strEnd = i + 1; // 含闭合引号
    if (text.slice(strStart, strEnd) === '"torque"') {
      let j = strEnd;
      while (j < text.length && JSON_WS.test(text[j])) j += 1;
      if (text[j] === ':') {
        j += 1;
        while (j < text.length && JSON_WS.test(text[j])) j += 1;
        if (text[j] === '"') {
          found = { kind: 'string' };
        } else {
          const m = NUMBER_TOKEN_RE.exec(text.slice(j));
          found = m ? { kind: 'number', token: m[0] } : { kind: 'other' };
        }
      }
    }
    i = strEnd;
  }
  return found;
}

/**
 * 把 N·m 读数的十进制文本精确换算为整数 cN·m。
 * @param {string} token JSON 数字原文，如 "45"、"42.00"、"4.45e1"
 * @returns {{ok:true, cnm:number}|{ok:false, reason:'precision'|'unconvertible'}}
 *   precision：归一化后小数位超过两位；unconvertible：记号非法或结果超出安全整数
 */
export function convertNmToCnm(token) {
  const m = DECIMAL_RE.exec(token);
  if (!m) return { ok: false, reason: 'unconvertible' };

  const negative = m[1] === '-';
  const frac = m[3] ?? '';
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  const coeffDigits = (m[2] + frac).replace(/^0+(?=.)/, '');
  let coeff = coeffDigits === '' ? 0n : BigInt(coeffDigits);
  if (negative) coeff = -coeff;

  // 读数 = coeff / 10^scale（已计入指数）
  let scale = frac.length - exp;
  if (coeff === 0n) {
    scale = 0;
  } else if (scale > 0) {
    // 去掉末尾多余的 0：45.100 与 45.1 等价
    while (scale > 0 && coeff % 10n === 0n) {
      coeff /= 10n;
      scale -= 1;
    }
  }

  if (scale > NM_MAX_DECIMALS) {
    return { ok: false, reason: 'precision' };
  }

  // scale ≤ 2，乘以 100 必得整数。power 过大（如 1e30）必然超出安全整数，
  // 直接拒绝，避免对超大指数做 BigInt 幂运算。
  const power = NM_MAX_DECIMALS - scale;
  if (power > 16) {
    return { ok: false, reason: 'unconvertible' };
  }
  const scaled = coeff * 10n ** BigInt(power);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER) || scaled < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { ok: false, reason: 'unconvertible' };
  }
  return { ok: true, cnm: Number(scaled) };
}
