# AG-UI 协议适配层（Pi Agent → AG-UI）

本文说明用户聊天的交付记录、默认 SSE、AG-UI 事件和断线重放。

## 1. 会话与事件的存储

| 数据 | 事实源 | 说明 |
|---|---|---|
| 会话历史 | Pi JSONL（`<project>/.pi/sessions/`） | adapter 只读事件，不写会话文件 |
| 资料 / 版本 / 计划 / 跟踪 / 通知 | 项目 SQLite（`data/workbench.db`） | 领域 SSE `/api/events` 不变 |
| AG-UI 传输事件 | 同一 SQLite 的 `agent_events` 表 | 仅用于断线重放，不是第二套会话事实源 |

`agent_events` 只记录 AG-UI 传输事件；material / tracking / plan / notification 等领域事件不会写入。


### 用户聊天的持久记录

同一条用户消息从首答、工具调用、整篇纠错到断点续写共用一个 `turnId`。Pi 会话的当前分支保存以下自定义条目。

| 条目 | 内容和写入时机 |
|---|---|
| `pe_turn_started` | 接受用户消息时记录 `turnId`、`question`、`startedAt`。排队的回合用 `queued` 标记，开始执行时追加 `pe_turn_active`，以便将原始消息归入对应回合。 |
| `pe_answer_lint` | 每次检查完整候选正文时记录发现、候选证据和补救次数，供执行记录读取。 |
| `pe_turn_delivery` | 收口时一次写入 `version: 1`、`turnId`、`text`、`citations`、`status`、`finishedAt`，有缺口或异常时另存 `reason`。AG-UI 回合另存传输用的 `runId`。同一回合再次收口时读取首次保存的记录。 |

纠错可整篇替换一次。达到输出上限或文本检查发现截断时，可续写一次，服务端保留前缀并对拼接后的全文重新核验。`citations` 保存最终正文实际引用的单元格，工具产生的其他引用随工具过程保存。

| `status` | 交付语义 |
|---|---|
| `completed` | 正文通过本轮交付检查。 |
| `partial` | 只发布能单独复核的完整句，并说明剩余缺口。 |
| `failed` | 正文为空，`reason` 给出失败原因。 |
| `cancelled` | 用户取消。可以保留此前通过独立核验的部分。 |

默认 SSE 先发送 `turn.started`，实时发送带 `turnId` 的工具事件，再从持久记录发布 `turn.delivered {record}`。`GET /api/sessions/:id/state` 与默认 SSE 的重连首帧使用同一快照。每条新回答包含 `turnId`、`text`、`citations` 和 `status`。核验期间状态为 `pending`，已完成的工具可展开。前端按 `turnId` 合并完成事件、刷新结果和断线重放。

`turnTimeline(session)` 读取 Pi 当前分支，供快照与 `transcript_search` 共同投影。旧会话按已有停止消息和工具过程重建答案与引用，混合会话逐回合选择读取方式。重新打开已落盘但未收口的回合时，服务记录中断原因。若进程在保存交付之后、写完协议终态之前中断，AG-UI 重连按该记录补齐缺失事件并保留已有游标。运行 `npm run test:turn-delivery` 可验证该契约。

### 第一轮验收复现

在仓库根目录运行 `npm run test:turn-delivery`。端到端用例使用真实 Pi SDK、临时项目与 SQLite，并脚本化模型输出和断线时机。

| Issue | 验收场景 | 脚本 |
|---|---|---|
| #10 | 错误引用的 A 被 B 替换，只保留 B 的引用，包含同一坐标来自不同工作簿的情况 | `scripts/test-post-answer.mjs` |
| #10 | 长度上限、正常停止后不完整、跨断点数值错误、带空格及重复前缀的续写 | `scripts/test-post-answer.mjs` |
| #10 | 两项预算、部分交付、工具或模型失败、取消、空续写 | `scripts/test-post-answer.mjs` |
| #10 | 重复收口、暂时写盘失败、模型请求前中断、新进程打开原文件 | `scripts/test-post-answer.mjs` |
| #13 | 默认 SSE 与 AG-UI 的纠错和两类续写、核验中断线、按游标重放、排队与冷启动 | `scripts/test-turn-delivery.mjs` |
| #13 | 界面四种终态、正文引用、展开工具、重放与旧快照迟到、CopilotKit 最终快照请求失败 | `scripts/test-turn-delivery-ui.mjs` |
| #13 | 终态写入中断、协议尾帧按游标恢复、工具进度跨分页 | `scripts/test-agui-delivery-recovery.mjs` |
| #13 | 新旧回合混合、旧会话引用、工具过程、历史只命中已交付正文、当前回合的检索边界 | `scripts/test-presentation-snapshot.mjs`、`scripts/test-transcript-search.mjs`、`scripts/test-f5-session.mjs` |

## 2. 标识规范（`lib/agent-protocol/ids.mjs`）

| 标识 | 规则 |
|---|---|
| `threadId` | Pi `sessionId`（稳定不变） |
| `runId` | 每次 prompt 前生成（`run_<uuid>`） |
| `messageId` | 用户聊天的最终正文使用 `turnId`。独立 Pi 适配器使用 Pi 消息 ID 或生成的 `msg_<uuid>`。 |
| `toolCallId` | Pi `toolCallId` |
| `eventId` | `evt_<runId>_<sequence 补零>`，随行持久化，重放不变 |
| `sequence` | 每个 run 从 1 开始严格递增，`unique(run_id, sequence)` 兜底 |
| `ordinal` | 每库单调计数，仅用于整条 thread 的跨 run 重放排序 |

## 3. 事件映射（`pi-ag-ui-adapter.mjs`）

| 事件来源 | 用户聊天的 AG-UI 事件 |
|---|---|
| 首次 `agent_start` | `RUN_STARTED`。若提前失败，在发布失败记录前补发开始事件。 |
| 工具开始、更新、结束 | `TOOL_CALL_START/ARGS`、`CUSTOM pi.tool_progress`、`TOOL_CALL_END/RESULT`。进度是累计快照，失败的工具结果以 `Error:` 开头。 |
| Pi 正文增量、单次生成结束 | 候选答文保存在 Pi 执行记录中，核验继续。 |
| 保存交付记录 | 有正文时发布一组 `TEXT_MESSAGE_START/CONTENT/END`。所有状态均发布 `CUSTOM pe.turn_delivery`，其 `value` 是完整持久记录。 |
| 完成、部分完成 | `RUN_FINISHED` |
| 用户取消 | `RUN_FINISHED`，含 `result.aborted = true` |
| 交付失败 | `RUN_ERROR`，含失败原因 |

独立使用适配器、直接调用 Pi 的会话仍按原始生成的 delta、message_end 和 agent_settled 转发文本和终态。

## 4. 状态机（`run-state-machine.mjs`）

- `RUN_STARTED` 必须是第一个业务事件；`RUN_FINISHED` / `RUN_ERROR` 必须是最后一个。
- `TEXT_MESSAGE_CONTENT` 必须在对应 `TEXT_MESSAGE_START` 之后，否则抛 `content_before_start`。
- `TOOL_CALL_RESULT` 只能紧跟同一 call 的 `TOOL_CALL_END`；未知/已关闭调用抛 `unknown_tool_call`。
- 终态后任何业务事件都抛 `run_already_terminal`。
- 异常结束（`fail`）、abort（`finish({aborted:true})`）会补齐 `TEXT_MESSAGE_END`、`TOOL_CALL_END` 和一条带 `isError: true` 的合成 `TOOL_CALL_RESULT`。

状态机不依赖 Pi、HTTP 或 SQLite，可纯内存测试。

## 5. 数据库

```sql
create table agent_events (
  event_id     text primary key,
  workspace_id text not null,
  thread_id    text not null,
  run_id       text not null,
  sequence     integer not null,
  ordinal      integer not null,
  event_type   text not null,
  payload_json text not null,
  created_at   text not null,
  unique (run_id, sequence),
  unique (ordinal)
);
```

索引：`(workspace_id, thread_id, ordinal)`、`(run_id, sequence)`。
建表在 `Store.migrate()`，增量迁移，不重建库；`node:sqlite`，未引入 `better-sqlite3`。

所有项目**共用**同一个 `data/workbench.db`，隔离靠 `workspace_id`：读取（含按 `runId` / `eventId`）一律带 `workspace_id` 过滤，`agentEventLog` 绑定到具体 workspace。`ordinal` 是全库单调计数，`unique(run_id, sequence)` 只保证 run 内序号。

## 6. HTTP 接口（`ag-ui-endpoint.mjs` + `server.mjs`）

所有路径都走现有 `projectFor()` 校验（`?project=` 或 `X-Project-Id`）。

### `GET /api/ag-ui/info`

```json
{
  "version": "1.0.0",
  "protocol": "ag-ui",
  "projectId": "product-eng",
  "agents": [{ "name": "pi", "threadIdSource": "pi-sessionId" }],
  "features": { "sse": true, "replay": true, "lastEventId": true, "afterEventId": true, "attachments": true, "projectIsolation": true }
}
```

### `POST /api/ag-ui/agent/pi/run`

```json
{
  "threadId": "<pi sessionId，可省略；省略则新建会话>",
  "messages": [{ "role": "user", "content": "分析这份报告" }],
  "forwardedProps": {
    "projectId": "product-eng",
    "attachments": ["uploads/2026-10-20-report.pdf"]
  }
}
```

- 返回 SSE；`projectId` 必须与路径解析出的项目一致（否则 403）。
- 附件必须是项目内**真实存在**的普通文件：先 `realpath` 再判断是否仍在项目根内（`..` 逃逸、指向项目外的软链、缺失文件、目录一律丢弃）；项目内的绝对路径会被规范化为相对路径。提示词按现有格式追加 `[已上传资料]` 列表。
- 同一 thread 已有活动 run → 409 `run_in_progress`；Pi 正在流式（例如旧接口发的消息）→ 409 `thread_busy`。
- 反向也成立：AG-UI run 进行中，旧 `POST /api/sessions/:id/messages` 返回 409 `ag_ui_run_active`，避免 followUp 事件混进当前 run。

### `POST /api/ag-ui/agent/pi/connect`

```json
{ "threadId": "<pi sessionId>" }
```

只重放/续传，不启动新 run。重放覆盖该 thread **所有** run（按 `ordinal` 排序），不会在历史 run 的终态处提前结束；队列排空后若没有活动 run 就关闭，有活动 run 则持续流式，直到该 run 的终态再关闭。

### `POST /api/ag-ui/agent/pi/stop/:threadId`

中止当前 run，返回 `{ ok, threadId, stopped }`。无活动 run 时 `stopped: false`。

### SSE 帧

```
retry: 2000

id: evt_run_xxx_000001
data: {"type":"RUN_STARTED","timestamp":...,"threadId":"...","runId":"..."}
```

`data` 是标准 AG-UI 事件对象；`id` 是稳定 `eventId`。

## 7. 断线重放

游标优先级：

1. `Last-Event-ID` 请求头（EventSource 的断线续传字段；本接口是 POST，客户端需自己带上）
2. `afterEventId`（query、JSON body 或 `forwardedProps`）

语义：

- 带 `runId` 的流（`/run`）按 run 内 `sequence` 续传。
- `connect` 按整条 thread 的 `ordinal` 续传，可跨多个 run。
- 先订阅实时回调 → 再读 SQLite 重放 → 再按游标排空队列；因此「读库期间产生的事件」不会丢，重放与队列里重复的事件按 `eventId`/游标去重。
- 终态事件发出后主动关闭 SSE 并**退订**实时回调；活动 run 才保持连接（15s 心跳 `: ping`）。客户端断开由 `ServerResponse` 的 `close` 事件感知并释放订阅（POST 场景下 `IncomingMessage` 的 `close` 太早，不能用于此目的）。
- 若终态事件写库失败：SSE 客户端仍会收到该帧（无 `id:` 行，`data` 里带 `"persisted": false`），stream 随即关闭；该帧无法重放，这是“宁可丢重放、不可丢实时终态”的取舍。
- 超过 5000 条时自动分页，不会截断。

## 8. 兼容性

保留未改：

- `GET /api/sessions/:id/state`
- `GET /api/sessions/:id/events`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/abort`
- `GET /api/events`
- `npm start` → `node server.mjs`

前端默认仍走旧接口；AG-UI 是并行新增的传输层。同一会话两条路径可共存，但同一时刻只允许一个活动 run：AG-UI 发起时检查 `session.isStreaming`，旧 `/messages` 则检查 `entry.agui.isRunning`，两个方向都返回 409。旧 `/abort` 在有 AG-UI run 时转调 `adapter.abort()`，与 `/stop` 语义一致（立即停止流式）。

## 9. 测试

```bash
npm run test:protocol
```

覆盖（全部离线，另含一次真实起服务的旧接口回归）：ID 规则、状态机不变量（含终态拒绝、重复 START 拒绝）、纯文本 / 文本→工具→文本 / 多工具 / 工具失败 / prompt 异常 / assistant 报错后重试 / settled 后 reject / abort / 适配器异常 / 终态写库失败 / sequence 与 eventId / 数据库重开后重放 / 跨项目隔离 / SSE 游标、跨 run connect、实时握手、真实 HTTP 断线退订、写库失败时的 volatile 终态帧 / 413 与非法 JSON 映射 / 路由语义（含 connect 项目校验）/ 旧接口回归（真实起服务）。

另做过一次**真实模型**冒烟（非测试套件，需要 API key）：普通问答、真实 `ls` 工具调用（事件顺序 `TOOL_CALL_START → ARGS → END → RESULT → TEXT_MESSAGE_*`）、断线后按 `Last-Event-ID` 重放（68 帧中只补 65 帧、id 完全一致）、运行中 `/stop`（`RUN_FINISHED{result:{aborted:true}}` 且之后无事件）。

其他既有测试：`test:framework`、`test:monitoring`、`test:monitoring:store`、`test:tracking-tool`、`test:workbook`、`test:pdf`、`test:web-fetch`、`test:anysearch`、`test:asr`。

## 10. 已知边界 / 未验证

- 自动化测试不发起真实模型调用（fake session + 固定 fixture）；真实链路由上面的一次性冒烟覆盖，未纳入 CI。
- `agent.prompt` 抛错、且 Pi 先发 `agent_settled` 的路径，用“延迟一个宏任务再判定终态”处理；已由 fake session 覆盖，但没有在真实故障注入下验证。
- 适配器按 `agent_start` 起 run；若进程在 run 中途崩溃，重放会停在半截（没有终态）。客户端可据 `RUN_STARTED` 无终态 + `connect` 立即关闭判断 run 已丢失。
- 客户端断开 SSE 不会 abort run（与 CopilotKit 一致：需要显式 `/stop`）。
- `agent_events` 没有自动清理策略；payload 含完整文本与最多 20k 的工具结果，按 thread/时间做归档是后续工作。
- 未引入 `@ag-ui/core` 依赖（本机 npm 不可用且不希望引入未锁定的 zod 传递依赖），事件形状由测试断言。
