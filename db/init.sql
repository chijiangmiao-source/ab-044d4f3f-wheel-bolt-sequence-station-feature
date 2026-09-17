-- 轮毂复核工位：会话与不可变确认事件
-- 该脚本由 postgres 容器在空数据卷首次启动时执行（docker-entrypoint-initdb.d）。

CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- in_progress 进行中；completed 六步全部完成；cancelled 操作工带原因终止（拆下返修/装夹错误）
  status            TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  -- 下一个期待的序号（从 1 开始）；六步全部确认后为 7，仅服务端可推进
  expected_sequence INTEGER NOT NULL DEFAULT 1
                    CHECK (expected_sequence BETWEEN 1 AND 7),
  -- 可选工单码：非空值全表唯一（NULL 互不冲突，历史无码会话无需补值）。
  -- 同一工单码的并发首次打开由该唯一约束兜底，只会绑定一个会话。
  work_order_code   TEXT,
  -- 终止原因与终止时间：仅 status = 'cancelled' 时非空，长度 2–100 字
  cancel_reason     TEXT,
  cancelled_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'cancelled'
      AND char_length(cancel_reason) BETWEEN 2 AND 100
      AND cancelled_at IS NOT NULL)
    OR
    (status <> 'cancelled' AND cancel_reason IS NULL AND cancelled_at IS NULL)
  ),
  CONSTRAINT sessions_work_order_code_uniq UNIQUE (work_order_code)
);

CREATE TABLE confirmations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions (id),
  sequence        INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  position        TEXT NOT NULL CHECK (position IN ('A1', 'B2', 'A3', 'B1', 'A2', 'B3')),
  -- 标准扭矩：换算后的整数 cN·m，既有顺序/范围/幂等判定与历史展示均以此为准
  torque          INTEGER NOT NULL CHECK (torque BETWEEN 4200 AND 4800),
  -- 原始读数与录入单位：操作工实际录入的值（N·m 保留至多两位小数），仅作记录；
  -- 统一存为普通十进制文本以保真（如 42.00），标准字段 torque 才用于业务判定
  torque_input    TEXT NOT NULL CHECK (torque_input ~ '^[0-9]+(\.[0-9]+)?$'),
  torque_unit     TEXT NOT NULL CHECK (torque_unit IN ('cN·m', 'N·m')),
  idempotency_key TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一会话内：每个序号至多一条确认；每个幂等键至多绑定一条确认
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

-- 确认事件不可变：数据库层拒绝任何 UPDATE / DELETE
CREATE OR REPLACE FUNCTION confirmations_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'confirmations 为不可变事件表，禁止 %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER confirmations_no_update
  BEFORE UPDATE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();

CREATE TRIGGER confirmations_no_delete
  BEFORE DELETE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();
