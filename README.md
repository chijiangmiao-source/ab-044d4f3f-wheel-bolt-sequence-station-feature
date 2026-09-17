# 轮毂复核工位（hub-review）

触屏工位 + API 的真实联调项目：操作工按固定顺序 **A1 → B2 → A3 → B1 → A2 → B3** 逐颗复核轮毂的六颗螺栓，服务端以 PostgreSQL 持久化会话与**不可变确认事件**，只有在六次有效确认全部落库后才判定「轮毂复核完成」。

针对现场两类典型故障做了明确的协议设计：

- **触屏重试 / 网络重试导致同一颗螺栓被记两次** → 幂等键去重：同一幂等键 + 完全相同载荷的重试返回**原确认**，不产生第二条记录；
- **迟到的旧响应错误推进下一步** → 序号守卫：小于当前期待序号的按**迟到**拒绝，大于的按**越序**拒绝，任何失败都不推进进度。

## 目录结构

```
├── docker-compose.yml   # db / api / web / verify 四个服务
├── db/init.sql          # 建表 + 唯一约束 + 不可变触发器（postgres 首次启动执行）
├── api/                 # Express API：会话与确认事件（Node 20）
├── web/                 # 工位页面（nginx 托管静态页，/api 反向代理到 api）
└── verify/              # 一次性验收服务：协议用例 + 真实浏览器（Playwright/Chromium）操作用例
```

## 运行

```bash
docker compose up --build -d db api web
# 工位页面：http://localhost:${WEB_PORT:-8080}
# API：     http://localhost:${API_PORT:-3000}
```

宿主端口由环境变量覆盖（见 `.env.example`）：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build -d db api web
```

## 一次性验收（verify）

`verify` 是一次性服务：等待 api/web 健康后跑完全部用例并退出，退出码即验收结果。

```bash
# 方式一：起全栈并跟随 verify 的退出码（验收结束自动停掉全部容器）
docker compose up --build --exit-code-from verify

# 方式二：应用已在跑，单独执行验收
docker compose up --build -d db api web
docker compose run --rm verify
```

验收覆盖：

- **协议用例**（直连 API）：固定顺序、边界扭矩和幂等冲突；N·m 精确换算、精度与越界拒绝、跨单位幂等重放及旧格式客户端；工单码首次与重复打开、跨终端续作、并发首次打开和非法码；带原因终止、终止后拒绝、重复终止、完成态保护及最后一步与终止并发；迟到、越序、位置、扭矩、未知会话与缺字段拒绝、并发去重和数据库事件不可变；撤回两步后以新扭矩重做并完成、刷新只见有效记录且保留审计、无可撤回/已完成/已终止拒绝、两个撤回竞争只成功一次、连续撤回重做、撤回后幂等键语义、过期目标拒绝及撤回事件不可变；
- **页面用例**（真实 Chromium 驱动页面）：六步完成、异常扭矩、刷新恢复、网络重试、慢响应连点和完成态刷新；N·m 边界读数、越界与精度拒绝及历史 cN·m 展示；新工单、另一浏览器接续、并发首次打开、非法码及无码旧流程；完成两步后终止、展示并持久化原因与时间、关闭扭矩提交；完成两步后撤回第二步并以新扭矩重做后完成、刷新后只显示有效记录且保留审计痕迹、撤回失败保留权威进度与当前输入、连续撤回两颗并逐颗重做。

## API 协议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sessions` | 开始新会话（固定顺序 A1→B2→A3→B1→A2→B3），返回 `201` 与初始进度（旧客户端协议，继续可用） |
| POST | `/api/work-orders/{code}/session` | **按工单码打开复核**：同一事务内返回已绑定会话（`200`），尚未绑定时才创建（`201`） |
| GET | `/api/sessions/{id}` | 读取权威进度（页面刷新后以此为准；只含未撤回确认，另附撤回审计） |
| POST | `/api/sessions/{id}/confirmations` | 提交一次复核确认 |
| POST | `/api/sessions/{id}/confirmations/last/retract` | **撤回上一步**：追加不可变撤回事件并回退到上一颗，可立即重新确认 |
| POST | `/api/sessions/{id}/cancel` | 带原因终止复核（拆下返修/装夹错误），幂等可重放 |
| GET | `/healthz` | 健康检查 |

### 工单码绑定（换班 / 换触屏 / 清理浏览器后接续）

- 操作工在进入区输入或扫码工单码后调用「打开复核」`POST /api/work-orders/{code}/session`；
- 接口对工单码**去除首尾空白**后校验（非空、≤64 字符）并保存，非法码返回 `400 invalid_work_order_code`（中文原因可直接展示）；
- 已绑定该码的会话在**同一事务**中连同其确认记录一起返回（`200`）；尚未绑定时才创建新会话并绑定（`201`，从第一颗 A1 开始）；
- 数据库对非空工单码建立唯一约束，两个终端并发首次打开同一码：一个请求 `201`，其余在唯一约束冲突后改读已建会话返回 `200`，**只产生一个会话**；
- 页面刷新或在另一台触屏输入同一码，均读取服务端权威进度接续复核；查询或创建暂时失败时页面不覆盖本地已有会话；
- 历史会话无工单码（`work_order_code` 为 `NULL`，NULL 之间互不冲突），**无需补值**。

确认请求体：

```json
{
  "session_id": "会话编号（须与路径一致）",
  "sequence": 1,
  "position": "A1",
  "torque": 4500,
  "unit": "cN·m",
  "idempotency_key": "客户端为本次提交意图生成的唯一键"
}
```

- `sequence`：从 1 开始的整数序号；`position`：位置码；`idempotency_key`：1–128 字符。
- `torque`：读数。配合 `unit` 使用，支持 JSON 数字或十进制文本字符串（如 `"42.00"`，页面按录入原文发送以保真）：
  - `unit` 为 `"cN·m"` 或**不传**（旧格式客户端）：整数 cN·m，合格范围 **4200–4800 含边界**；
  - `unit` 为 `"N·m"`：数显扳手读数，**最多两位小数**，服务端先精确换算（×100，BigInt 十进制，不走浮点）为整数 cN·m，合格范围 **42.00–48.00 含边界**。
- 成功：`201` `{ replayed: false, confirmation, progress }`；重放：`200` `{ replayed: true, confirmation, progress }`。
- 失败：`{ error: { code, message }, progress }`，`message` 为可直接展示的中文原因，`progress` 为当前权威进度。
- `confirmation` 同时返回标准字段 `torque`（整数 cN·m，进度与完成明细使用）与原始读数 `torque_input`、`torque_unit`（仅作记录；历史明细仍按 cN·m 展示）。

### 录入单位与换算失败

现场部分数显扭矩扳手只显示 N·m，操作工无需心算：

- 工位默认单位保持 **cN·m**，可在页面切换为 **N·m**（最多两位小数），提交仍走同一个确认入口；
- 服务端先精确换算再执行既有的顺序、范围与幂等判定，因此 **45 N·m 与 4500 cN·m 是同一标准载荷**，同一幂等键跨单位重试只返回原确认；
- 换算失败时页面展示中文原因并停留在当前螺栓，失败请求不写事件、不推进序号：
  - 超过两位小数（无法精确换算为整数 cN·m）→ `422 torque_precision_exceeded`；
  - 数值过大无法精确换算 → `422 torque_unconvertible`；
  - 换算后越界（如 41.99 N·m = 4199 cN·m）→ `422 torque_out_of_range`，原因中同时给出原始读数与换算值。
- 空请求体创建会话、以及不传 `unit` 的旧格式确认请求，均保持原语义。

### 重试语义（核心）

服务端对 `POST /confirmations` 按以下顺序判定，**任何失败都不推进进度、不消耗幂等键**：

1. **幂等键优先**（键已落库时）：
   - 载荷（序号/位置/扭矩）完全相同 → `200` 返回**原确认事件**（`replayed: true`），不重复记录；
   - 载荷不同 → `409 idempotency_conflict`，返回已存在的确认，未推进。
2. **序号守卫**（键未见过时）：
   - `sequence < 当前期待序号` → `409 late_sequence`（迟到响应，拒绝）；
   - `sequence > 当前期待序号` → `409 out_of_order_sequence`（越序，拒绝）。
3. **位置校验**：位置码与当前期待步骤不符 → `422 position_mismatch`。
4. **扭矩校验**：服务端先按 `unit` 把读数精确换算为整数 cN·m（缺省单位按 cN·m），再判定 4200–4800（含边界）→ `422 torque_out_of_range`；N·m 超过两位小数 → `422 torque_precision_exceeded`；无法精确换算 → `422 torque_unconvertible`；非整数 cN·m、非法单位等非法请求体 → `400 invalid_body`；未知会话 → `404 session_not_found`。

并发与一致性：同一会话的提交、撤回与终止都在会话行锁（`SELECT ... FOR UPDATE`）事务内串行化；有效确认的部分唯一索引 `(session_id, sequence) WHERE retraction_id IS NULL` 与覆盖全部历史的 `(session_id, idempotency_key)` 唯一索引兜底，因此并发重试/触屏连点最多落库一条有效确认，撤回后同一序号又能重新确认。确认事件表与撤回事件表均由触发器禁止 `UPDATE/DELETE`（确认表仅允许撤回事务对有效行一次性写入撤回标记），是只增不改的事件日志。

### 终止复核（POST /cancel）

轮毂拆下返修或装夹错误时，操作工可在未完成页面点击「终止复核」，填写 **2–100 字**原因后确认：

- 请求体：`{ "reason": "轮毂拆下返修" }`；成功：`200 { cancelled: true, replayed: false, progress }`，`progress.status = 'cancelled'` 并携带 `cancel_reason`、`cancelled_at`、`confirmed_count`，`expected_sequence/expected_position` 为 `null`；
- **已完成会话不可终止**：`409 session_completed`，返回完成态 `progress`；
- **重复终止幂等**：已终止会话再次终止返回现有结果 `200 { cancelled: true, replayed: true, progress }`，原因与终止时间不被覆盖；
- 原因缺失/非字符串/长度越界：`400 invalid_body`；未知会话：`404 session_not_found`。

终止与确认并发：两者都在**会话行锁事务**内执行，先取得锁者生效，后到者在同一把锁上读到最新权威状态——确认先到则会话完成、终止收到 `409 session_completed`；终止先到则最后一步确认收到 `409 session_cancelled`。因此一个会话只会形成**一个终态**，确认事件始终只增不改（终止不删除、不改写任何事件）。

已终止会话的任何确认提交（包括旧客户端在途的自动重试）一律返回 `409 session_cancelled` 与最新权威 `progress`，**不写事件、不推进、不消耗幂等键**；该判定在幂等键查询之前。

`GET /api/sessions/{id}` 在已终止会话上额外返回 `cancel_reason`、`cancelled_at`；其余字段与原格式一致，旧客户端的创建、查询、确认请求不受影响。

### 撤回上一步（POST /confirmations/last/retract）

操作工提交后发现扭矩抄错时，无需废弃整轮复核：进行中的会话可**撤回最后一条有效确认**并立即以新读数重新确认该颗螺栓。

- 页面仅在**已有确认且会话尚未完成（`in_progress`）**时展示「撤回上一步」，并要求操作工**二次确认**；
- 请求体可携带 `{ "confirmation_id": 123 }`（页面二次确认时所见最后一条有效确认编号，乐观并发标记，缺省亦可）；
- 成功：`200 { retracted: true, retraction, progress }`：
  - `progress` 为服务端权威进度，期待序号/位置**回到被撤回的那一颗**（如撤回第 2 步后 `expected_sequence` 回到 2、位置 B2），`confirmed_count` 同步回退；
  - `retraction` 为不可变撤回审计事件：`{ id, session_id, sequence, position, torque, torque_input, torque_unit, confirmation_id, idempotency_key, confirmed_at, retracted_at }`；
- 失败均随错误返回最新权威 `progress`，页面保留该进度且**不清除当前输入**：
  - 没有有效确认 → `409 nothing_to_retract`；
  - 会话已完成 → `409 session_completed`；会话已终止 → `409 session_cancelled`；
  - 请求携带的 `confirmation_id` 已被并发请求先撤回 → `409 already_retracted`；不是当前最后一步 → `409 retraction_target_stale`；
  - 未知会话 → `404 session_not_found`。

服务端在**锁定会话行的事务**内串行执行（与确认、终止同一把锁）：先锁会话、再 `SELECT ... FOR UPDATE` 锁定当前最后一条有效确认，随后

1. 向 `retractions` 追加一条**不可变撤回事件**（`confirmation_id` 全表唯一，一条确认至多被撤回一次）；
2. 给原确认一次性写入撤回标记（触发器保证扭矩/序号/位置/幂等键等业务字段一律不变、标记只能写一次且必须指向确指本行的撤回事件）；
3. 把 `sessions.expected_sequence` 回退到被撤回的序号。

因此撤回**不删除、不改写任何确认事件**，原读数完整保留用于审计；会话查询（`GET`、按工单码打开）的 `confirmations` **只包含未撤回记录**，撤回痕迹通过新增的 `retractions` 数组单独返回（无撤回时为空数组）。

**并发撤回**：两个撤回请求同时到达时在会话行锁上排队，先得手者成功；后到者在同一事务里读到目标确认已被撤回，返回 `409 already_retracted` 与回退后的权威进度——只成功一次、只产生一条撤回事件、期待序号只回退一次。

**同一序号重新确认**：有效确认集合上建有部分唯一索引 `(session_id, sequence) WHERE retraction_id IS NULL`，保证任一时刻每个序号至多一条有效记录，而撤回后允许同序号以新读数重新落库。重新确认是一次新的提交意图，**必须使用新幂等键**并仍从原 `POST /confirmations` 入口提交：

- 撤回后用**旧幂等键 + 相同载荷**重放：仍返回原确认事件（`200 replayed: true`，该事件带 `retracted: true`），不重新落库、不推进；
- 旧幂等键 + 不同载荷：仍为 `409 idempotency_conflict`；
- 新幂等键 + 正确读数：正常 `201` 落库并推进。

可连续撤回多颗（按 3、2 的顺序）并逐颗重做；历史表中同一序号可能存在多条记录（仅一条有效），审计通过 `retractions` 完整可查。已终止/已完成会话不可撤回；撤回与确认、终止并发时同样由行锁决定先得手者，只会形成一个自洽状态。**不调用该接口的旧客户端不受任何影响**：创建、查询与六步确认的请求/响应字段与语义全部保持原样（`retractions` 为纯新增字段）。

页面侧约定：

- 进入区以工单码「打开复核」为主入口（也可开始无码新会话）；本地保存会话编号与工单码，刷新或重启页面时优先按工单码向服务端打开权威会话；
- 每次「用户提交意图」生成一个幂等键；**网络异常（超时/断连）的自动重试复用同一键**（指数退避，最多 6 次），因此重试永远不会把同一颗螺栓记两次；
- 收到确定性拒绝（4xx）不重试，展示拒绝原因并重新拉取权威进度对齐页面；
- 提交在途时禁用提交按钮，避免触屏连点产生并发提交；
- 刷新页面后重新 `GET` 权威进度；「轮毂复核完成」只在服务端状态为 `completed`（即六次有效确认全部落库）时显示，否则稳定停留在当前螺栓。
- 「终止复核」仅在进行中会话可用：填写 2–100 字原因并确认后，页面展示终止时间与原因并关闭扭矩提交；刷新后从服务端恢复已终止态；旧页面不调用 `/cancel` 也不受任何影响。
- 「撤回上一步」仅在**已有确认且尚未完成**时出现，点击后展示二次确认面板（写明将撤回的序号、位置与原读数）；确认后调用撤回接口，成功即以服务端权威进度回到上一颗，随后仍从原确认入口提交新读数（新幂等键）。撤回失败（无可撤回记录/已完成/被并发先撤回）显示明确原因、重新拉取权威进度且**不清除当前输入**；页面的「撤回记录（审计）」区在进行中与完成后都展示被作废的原读数及撤回时间，刷新后保持。

## 数据模型

- `sessions(id, status, expected_sequence, work_order_code, cancel_reason, cancelled_at, created_at, updated_at)`：`expected_sequence` 在确认落库的同事务内递增（1→7）、在撤回落库的同事务内回退到被撤回的序号；`work_order_code` 可空且非空值全表唯一；`status` 为 `in_progress`/`completed`/`cancelled`，终止原因与时间仅在 `cancelled` 时非空；
- `confirmations(id, session_id, sequence, position, torque, torque_input, torque_unit, idempotency_key, confirmed_at, retraction_id, retracted_at)`：不可变事件，`torque` 为换算后的整数 cN·m 标准字段，`torque_input`/`torque_unit` 保存操作工原始读数与单位；未撤回时两列撤回标记为 NULL，撤回时由撤回事务一次性写入。幂等键唯一索引覆盖全部历史记录（含已撤回），`(session_id, idempotency_key)` 同键永远只绑定一条；有效记录的部分唯一索引 `(session_id, sequence) WHERE retraction_id IS NULL` 保证任一时刻每序号至多一条有效记录，撤回后同序号可重新确认；
- `retractions(id, session_id, confirmation_id, sequence, retracted_at)`：**不可变撤回事件**，每次撤回追加一行；`confirmation_id` 全表唯一（一条确认至多被撤回一次），联表原确认得到审计视图（序号/位置/原读数/原确认与撤回时间），由数据库触发器禁止 `UPDATE/DELETE`。

重置数据：`docker compose down -v`（清空数据卷后 `db/init.sql` 会重新执行）。
