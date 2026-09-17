// 复核顺序固定：每个新会话都按此顺序复核六颗螺栓
export const POSITIONS = Object.freeze(['A1', 'B2', 'A3', 'B1', 'A2', 'B3']);
export const TOTAL_STEPS = POSITIONS.length;

// 合格扭矩范围（含边界），单位 cN·m
export const TORQUE_MIN = 4200;
export const TORQUE_MAX = 4800;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

// 终止复核原因长度（按字符计），2–100 字
export const CANCEL_REASON_MIN_LENGTH = 2;
export const CANCEL_REASON_MAX_LENGTH = 100;

// 工单码长度（去除首尾空白后计），扫码/手输共用
export const WORK_ORDER_CODE_MIN_LENGTH = 1;
export const WORK_ORDER_CODE_MAX_LENGTH = 64;
