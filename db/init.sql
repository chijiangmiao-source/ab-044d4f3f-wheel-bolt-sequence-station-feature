-- 轮毂复核工位：会话、不可变确认事件与不可变撤回事件
-- 该脚本由 postgres 容器在空数据卷首次启动时执行（docker-entrypoint-initdb.d）。

CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- in_progress 进行中；completed 六步全部完成；cancelled 操作工带原因终止（拆下返修/装夹错误）
  status            TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed', 'cancelled')),
  -- 下一个期待的序号（从 1 开始）；六步全部确认后为 7，仅服务端可推进。
  -- 撤回最后一步时在事务内回退（如 3 → 2），允许同一序号随后重新确认。
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
  -- 撤回不是删除/改写事件，而是在 retractions 追加一条不可变记录并在此打标。
  -- 被撤回的确认原样保留用于审计；只有未撤回（两列均为 NULL）的记录计入 confirmations。
  retraction_id   BIGINT,
  retracted_at    TIMESTAMPTZ,
  CHECK (
    (retraction_id IS NOT NULL AND retracted_at IS NOT NULL)
    OR
    (retraction_id IS NULL AND retracted_at IS NULL)
  )
);

-- 不可变撤回事件：每次「撤回上一步」追加一行，绝不修改或删除。
-- 一条撤回恰好对应一条被撤回的确认（confirmation_id 全表唯一）；
-- 同一条确认因此不可能被撤回两次，并发撤回竞争时只有一个事务能插入成功。
CREATE TABLE retractions (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions (id),
  confirmation_id BIGINT NOT NULL UNIQUE REFERENCES confirmations (id),
  -- 撤回发生时该确认在会话中的序号（冗余留档，等于 confirmations.sequence）
  sequence        INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  retracted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE confirmations
  ADD CONSTRAINT confirmations_retraction_fk
  FOREIGN KEY (retraction_id) REFERENCES retractions (id);

-- 有效记录（未撤回）的部分唯一约束：
-- 同一序号任一时刻最多一条有效确认；撤回后该序号允许以新读数重新确认。
CREATE UNIQUE INDEX confirmations_active_sequence_uniq
  ON confirmations (session_id, sequence)
  WHERE retraction_id IS NULL;

-- 幂等键唯一约束覆盖全部历史记录（含已撤回）：同一键永远只绑定一条确认，
-- 既有幂等键语义（同键同载荷重放原确认、不同载荷冲突）继续成立，
-- 撤回后重新确认是一次新的提交意图，必须携带新幂等键。
CREATE UNIQUE INDEX confirmations_idempotency_key_uniq
  ON confirmations (session_id, idempotency_key);

-- 审计查询用：按会话列出撤回事件
CREATE INDEX retractions_session_idx ON retractions (session_id, id);

-- 确认事件不可变：数据库层拒绝任何 UPDATE / DELETE。
-- 唯一例外是撤回事务内对有效行一次性写入撤回标记，且只能写一次、
-- 必须指向确指本行的撤回事件，任何业务字段都不得变化。
CREATE OR REPLACE FUNCTION confirmations_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.retraction_id IS NOT NULL
       OR NEW.retraction_id IS NULL
       OR OLD.id <> NEW.id
       OR OLD.session_id <> NEW.session_id
       OR OLD.sequence <> NEW.sequence
       OR OLD.position <> NEW.position
       OR OLD.torque <> NEW.torque
       OR OLD.torque_input <> NEW.torque_input
       OR OLD.torque_unit <> NEW.torque_unit
       OR OLD.idempotency_key <> NEW.idempotency_key
       OR OLD.confirmed_at <> NEW.confirmed_at
       OR NEW.retracted_at IS NULL
    THEN
      RAISE EXCEPTION 'confirmations 为不可变事件表，禁止 %（撤回只能追加标记且仅一次）', TG_OP;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM retractions r
      WHERE r.id = NEW.retraction_id
        AND r.confirmation_id = NEW.id
        AND r.session_id = NEW.session_id
    ) THEN
      RAISE EXCEPTION 'confirmations 撤回标记必须指向对应的撤回事件';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'confirmations 为不可变事件表，禁止 %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER confirmations_no_update
  BEFORE UPDATE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();

CREATE TRIGGER confirmations_no_delete
  BEFORE DELETE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();

-- 撤回事件同样只增不改
CREATE OR REPLACE FUNCTION retractions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'retractions 为不可变事件表，禁止 %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retractions_no_update
  BEFORE UPDATE ON retractions
  FOR EACH ROW EXECUTE FUNCTION retractions_immutable();

CREATE TRIGGER retractions_no_delete
  BEFORE DELETE ON retractions
  FOR EACH ROW EXECUTE FUNCTION retractions_immutable();
