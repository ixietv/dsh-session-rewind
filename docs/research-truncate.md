# 同会话内截断回退：能力边界与可行路径

> 任务 t11 产出。目标问题：**能否在同一个 `sessionId` 内，把时间线回退到某个切点，让切点之后的事件「消失」，并且用户就在这条原对话上继续？**
>
> 所有结论都带可复核的证据位置（文件路径 + 行号 / 类型名）。凡是没查到实证的，一律进 §10「未知项」，不写成结论。
>
> 证据基线：`app.asar`（DeepSeek Harness 0.2.1-rc.2）抽取副本位于 `C:\Users\i_xie_tv\.dsh\.probe\asar-out\node_modules\@deepseek-ai\`，下文简写为 `@ds/`。
> 数据类型清单由 `.probe\typert-dump.mjs` 从 `dsh-api-session-controller/lib/typert.host.js` 导出到 `.probe\host-types.txt`（425 条宿主声明）与 `.probe\client-types.txt`（152 条客户端声明）；插槽清单由 `.probe\slot-catalog.mjs` 导出到 `.probe\slots.txt`（100 个插槽）。

---

## 0. 结论摘要（先看这里）

| 问题 | 结论 | 关键证据 |
| --- | --- | --- |
| 官方有没有「删除 / 截断 / 重写已提交事件」的 API？ | **没有。三层全空**：`Session` 类无 truncate/remove；`SessionStore` 无 detach/remove；`SessionPersistence` 只有 5 个方法；RPC 无相关 handler | `@ds/dsh-session/lib/index.js:1517`、`:1980`、`:2006`；`@ds/dsh-session-persistence/README.md:36-45`；`host-types.txt:137` |
| 事件日志是不是 append-only？ | **是，且是显式不变量**："Committed events are never rewritten; `append`'s first `seq` must equal the stored next-seq, and a gap rejects." | `@ds/dsh-session-persistence/README.md:85`；`@ds/dsh-session-persistence-jsonl/README.md:77` |
| 那个能不能直接改磁盘上的 `.jsonl.zstd`？ | **会话被进程持有时不能**（写句柄会按记录长度回滚、内存 seq 与磁盘不一致）；**会话未被持有（重启后 / 从未打开）时可以**，这是唯一「真删」路径 | `@ds/dsh-session-persistence-jsonl/README.md:77`、`:107`；`@ds/dsh-session-persistence/README.md:53`、`:57` |
| 那「在原会话继续」到底怎么实现？ | **surface 遮蔽（replace）**：在同一 `sessionId` 里 append 一个把 `[cut..tail]` 整段替换成 1 个节点的 surface 事件。模型侧真的忘掉（`messages` 来自 `deriveMessages()`），`sessionId` 不变，可立刻继续对话 | `@ds/dsh-session/lib/index.js:1274`（agent-loop 组装请求）；`@ds/dsh-session/lib/types/surface.js:431-454`；`@ds/dsh-compaction-basic/lib/index.js:650-661` |
| 遮蔽的副作用？ | **UI 不会自动隐藏旧气泡**。客户端 timeline 由「append 起源」事件逐条映射，replace 事件默认不生成节点 | `@ds/dsh-client-ui-chat/lib/client.js:9844-9852`；`@ds/dsh-client-ui-chat/lib/client.js:9475-9487` |
| 客户端能否自己识别这次回退？ | **能**。wire 事件带 `surfaceOp` 与 `sourceEventSeqs`；官方 chat 代码就是按 `event.surfaceOp` 判定的 | `host-types.txt:204`（`SessionWireEvent`）；`@ds/dsh-client-ui-chat/lib/client.js:9476`、`:9486` |
| 回退按钮挂在哪个槽最不吵？ | **`conversation.chat.assistant-actions`**（list 槽，每个已完成 assistant 消息一个 actions 区，官方 feedback 按钮同槽）。**user 消息没有 actions 槽** | `.probe\slots.txt:10-16`；全表 100 槽中 user 侧只有 `conversation.chat.user.images` 与 `conversation.user.text.node` |

**一句话结论**：官方没有「原地删除历史」的原语，所以 v1 的 fork 不是「选了个笨办法」，而是选了唯一被 API 支持的路径。但新的用户要求（同一个 sessionId 继续）**不必**靠删除实现——用官方 compaction 同一套 `surfaceOp: replace` 把切点之后的区间整段遮蔽，模型侧就完成了回退，且 `sessionId` 不变。代价是 UI 侧要由插件自己收尾（隐藏/标记旧行）。

---

## 1. 会话事件的存储形态（实证）

### 1.1 磁盘布局：每个会话一个 append-only 的 zstd 日志

- `@ds/dsh-session-persistence-jsonl/README.md:32`："The seam ships the JSONL backend: **one append-only `.jsonl.zstd` log per session**."
- 路径推导（`README.md:57-71`）：`<root>/--<normalized-cwd>--/<encoded-id>/session.vN.jsonl.zstd`；`compression: 'none'` 时是 `session.vN.jsonl` 明文行（`:48`）。session id 做单段安全转义（无路径穿越、无碰撞）。
- **generation（版本代）机制**（`README.md:73`）："Runtime operations select the **numerically highest canonical generation**." —— 同一会话目录里可以同时存在 `session.v0..v4`，运行时选编号最大的那个。
- 实测本机：`C:\Users\i_xie_tv\.dsh\sessions\--<normalized-cwd>--\<sessionId>\session.v4.jsonl.zstd` 存在，**没有明文 `.jsonl`**；README 注释里写 v3 为 current，但磁盘上是 v4 —— README 的版本号说明略滞后于实际产物，判断「当前格式」时以磁盘与 `SESSION_FORMAT_VERSION` 为准。

### 1.2 物理编码：独立 Zstd 帧串接，一批一帧

`@ds/dsh-session-persistence-jsonl/README.md:111`：

- 默认产物是 **标准 concatenation of independent Zstandard frames**：1 个只含 header 行的校验帧，然后 **每个 durable append batch 一个校验帧**。
- current 格式**一行一个事件**；`sourceEventSeqs` 用无损压缩表示（连续 ≥3 个 seq 压成 `[start,end]` 区间）。
- `compression:'none'` 保留同样的逻辑行但不压缩；**一个 root 只属于一种编码**，混用后缀会被拒绝；不支持压缩/明文转换、混合 root、双写。

操作含义：想「离线截断」，可以按帧解码 → 丢掉尾部行 → 重新按「header 帧 + 批帧」重写；但更省事的是**解码全部行、截断、按 `compression:'none'` 语义重写为单帧**也要满足上面的编码一致性约束，所以**最稳的是复用官方解码/编码路径**（见 §6.2）。

### 1.3 耐久与崩溃语义（这一节决定了「运行中改文件」为什么危险）

`@ds/dsh-session-persistence-jsonl/README.md:77` 原文要点：

- `create(header)` 不落盘；首个 append 才写并 fsync header + 首批。
- 之后每个批次 append 行/帧并 fsync，然后 append 才 resolve；**写或 sync 失败会把文件回滚到之前长度**："a caught write or sync failure **rolls the file back to its prior length**"。
- "**Committed events are never rewritten.**"
- 崩溃后保留中断的最后一轮；不完整的尾部明文行被丢弃；**撕裂的尾部 Zstd 帧只贡献能完整解码的记录，"a write handle **truncates the torn bytes** and durably rewrites those recovered records before its first new batch"**。
- 完整帧校验失败 → 判定 corruption 并拒绝。

### 1.4 单一写者与版本簿记

- `@ds/dsh-session-persistence-jsonl/README.md:107`：`JsonlSessionHandle` 持 per-handle mutation chain、routed live-event buffer、单调读、幂等 close；tracker 持 **in-process single-writer claims**；物理 revision = device + inode + size + 纳秒时间戳（历史公开 revision 另含路径 SHA-256），历史 body 读取走 **revision-keyed memo**。
- `@ds/dsh-session-persistence/README.md:53`：`create` / `open('write')` 取得 in-process 单写者所有权；第二个 write open → `SessionAlreadyOwnedError`；`SessionOwnershipLostError` 表示写所有权永久丢失，需要 close 重开。
- `@ds/dsh-session-persistence/README.md:57`：后端把每个**已发布** session 的事件按 id 路由到其 active write handle；`session/disposed` 做最终 drain 然后关闭 handle。**"A published session without an active write handle persists nothing."**

---

## 2. 官方「删除 / 截断 / 重写」能力穷举：六层，全部为空

逐层查过，**没有任何一层提供「把已提交事件删掉」的入口**。

### 2.1 `Session` 实例（`@ds/dsh-session/lib/index.js`）

`host-types.txt:137` 给出完整公开签名，逐项看：

```
export class Session {
  get surface(): SessionSurface
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  get id(): SessionId
  readonly firstLiveSeq: SessionLogOffset
  readonly firstLifecycleSeq: SessionLogOffset
  eventAt(seq: SessionSeq): SessionEvent | undefined
  snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[]
  ownEvents(): readonly SessionEvent[]
  isOwnSeq(seq: SessionSeq): boolean
  get seq(): SessionLogOffset
  append<T>(type, data, ...opts): SessionEvent<T>
  requestHeader(): EpochHeader | undefined
  requestContext(): RequestContext | undefined
  toolHistory(): ToolHistory
  deriveMessages(): Message[]
  deriveEventMessage(event): Message | null
}
```

> 上面这段签名取自 `host-types.txt:137`，为可读性去掉了 `readonly` 修饰与可选参数的默认值，成员集合未做任何增删。

**没有 `truncate` / `remove` / `delete` / `setSeq` / `rewind` / `reset`。** `append` 的 seq 是算出来的（`lib/index.js:1530`）：`seq: SessionSeq(this.log.length)` —— 永远只能接在末尾，调用方无法指定位置。

`commit`（`lib/index.js:1579-1599`）的动作顺序是 `surfaceManager.validateNext(event)` → `this.log.push(event)` → 广播 `session/event`。**push 之前没有任何「先删掉某些事件」的钩子**。

### 2.2 `SessionStore`（宿主服务 `ctx.sessions`，`super(ctx, "sessions")`，`lib/index.js:1739`）

公开方法：`create(id, options)`（`:1772`）、`prepare`、`enter(session)`（`:1853`，返回 detach disposer）、`announce`（`:1901`）、`detachEntered`（`:1886`，内部）、`flush(session)`（`:1951`）、`liveEntryFor`、`get(id)`（`:1980`）、`list()`（`:1987`）、`fork(source, boundary, childSessionId)`（`:2006`）、`registerMessageProjection`（`:1729`）。

**没有 `remove(id)` / `detach(id)` / `dispose(id)` / `truncate(id)`。** 而且 `detachEntered` 拿不到：`enter()` 返回的 detach disposer 只交给调用 `enter` 的那个人；生产路径里 `enter` 由 `dsh-agent-loop` 的创建事务调用（`lib/index.js:1760-1763` 的注释明确要求 agent 会话必须用 `prepare + enter + announce` 折进 agent 自己的 effect），所以拆会话的扳机握在 agent 生命周期里，插件拿不到。

### 2.3 持久化 seam（`@ds/dsh-session-persistence`，服务 `ctx.sessionPersistence`）

`README.md:36-45` 列出**全部**公开方法：

| 方法 | 语义 |
| --- | --- |
| `create(header)` | 建新会话 |
| `open(id, 'write')` | 取写句柄（单写者） |
| `open(id, 'read')` | 取只读句柄 |
| `stat(id)` | 元信息 |
| `list()` | 列会话 |
| `flush()` | 耐久屏障 |

`README.md:49`：所有读写都经 `SessionHandle`，"**there are no id-addressed append or load methods**"；handle 上只有 `read(offset?, length?)`、`append(events)`、`flush()`、`close()`。

**没有 `delete` / `truncate` / `rewrite` / `replace`。** 而且 `README.md:81` 明确：provider 的 handle 类是私有的，消费者只能耦合 `ctx.sessionPersistence` 这个抽象服务。

### 2.4 provider 内部（`@ds/dsh-session-persistence-jsonl`）

`lib/index.js` 147 KB、`lib/worker.cjs` 563 KB —— 里面确实有 `truncate`（撕尾修复）和「重写整份文件生成 successor」的实现，**但都不是公开可调的**，且语义都不等于截断：

- 撕尾截断只作用于「一个从未 resolve 的 append」留下的尾部字节，且在写句柄的第一次新 append 之前自动发生（`README.md:77`）。
- successor 发布是 **格式迁移**（历史 generation → 当前格式），且 "**publishes the current successor without overwrite**"，源文件保持 byte-identical（`README.md:85-89`）。

### 2.5 RPC / typert 契约（`@ds/dsh-api-session-controller`）

`lib/typert.host.js` 导出的 session 域方法（`host-types.txt` 里全部 `*Request/*Value` 成对出现）覆盖：create、list、page、follow、prompt、cancel、rename、selectModel、fork、attachment、updateQueue、search、projections、inspect、openWorkspacePath 等。

**没有 `session/truncate`、`session/delete`、`session/rewind`、`session/undo`、`session/rewrite`。**

### 2.6 全库字符串与包名（`asar` 306 个 `@deepseek-ai` 包）

- 包名按 `undo|rewind|checkpoint|restore|rollback|revert|truncate|edit|history|fork|session` 过滤得 35 个，**没有任何 undo/rewind/restore/rollback 语义的包**（`dsh-session-checkpoint-policy` 是 compaction 的检查点策略，不是撤销）。
- 内容搜索 `session/undo`、`session/rewind`、`session/truncate`、`op:"truncate"`、`surfaceOp: null`：**0 命中**。

---

## 3. 五条「看起来像」的路径，逐条否证

| # | 长得像 | 实际是什么 | 为什么不能用来截断 |
| --- | --- | --- | --- |
| 1 | `open(id,'write')` 对历史 generation 会「写一个同目录临时文件、Worker 校验、发布 successor」 | **格式迁移** | 只把旧格式转成当前格式；`publishes the current successor without overwrite`，且源文件保持 byte-identical。内容不变 |
| 2 | 写路径会 `truncate` 文件 | **撕尾修复** | 只截「从未 resolve 的 append」的尾部字节，发生在写句柄第一次新 append 之前；对已提交事件无效 |
| 3 | `session/disposed` 能释放写句柄 | **生命周期通知** | 它是拆会话的**结果**，不是原因；触发者是 agent 生命周期（`@ds/dsh-agent-loop/lib/index.js:1703-1734` 的 `teardown`：abort → `machine.cancel({kind:'disposed'})` → `scope.dispose()` → `handle.close()` → `detachAgent/detachSession`）。插件没有扳机 |
| 4 | `sessions.fork({atSeq})` 能复制前缀 | **新建一个会话** | 正是 v1 的做法；`sessionId` 变了，与「原对话继续」直接冲突（`buildForkSeed` 合成 `session/end-seed` + fork closers，`@ds/dsh-session/lib/index.js:927-936`） |
| 5 | `ctx.sessions.create(id, { seed })` 能用裁剪过的 seed 重建同 id | **id 已被占用** | `enter()` 对已存在 id 直接抛 `session "${id}" already exists`（`lib/index.js:1856`）；且 live 的 clone 与持久化的原件会形成两个写者 |

另外 `agent.cancel({ kind: 'disposed' })`（`host-types.txt:2` 的 `Agent.cancel`，`AgentCancelCause` 含 `{kind:'disposed'}`）**不是**拆会话的公开入口：它归一化后只是取消当前运行（`@ds/dsh-agent-loop/lib/index.js:737` `case "disposed": return { kind: cause.kind }`），真正的拆除发生在 owner fiber 的 teardown 里（`:1703-1734`）。

---

## 4. 可行路径 A（推荐）：surface 遮蔽式回退，`sessionId` 不变，立即可继续

### 4.1 机制

模型看到的 messages 不是原始日志，而是从 **surface** 折出来的投影。surface 支持一种 `replace` 操作：把 surface 上的一段区间**替换成 1 个节点**，被替换的节点从 surface 上消失（原始日志仍完整保留，用于人读转录与重放）。

- 折叠规则：`@ds/dsh-session/lib/types/surface.js:431-454` `applySurfacePlan` 对 replace 执行
  `state.nodes.splice(startIdx, endIdx - startIdx + 1, plan.seq)`，并 `replaceGeneration += 1; contentGeneration += 1`。
- 请求组装确实读 surface 投影：`@ds/dsh-agent-loop/lib/index.js:1274` `const boundaryMessages = session.deriveMessages();`，随后 `messages: boundaryMessages`（`:1283`）。

**所以：只要我们 append 一个把 `[cut .. tail]` 遮蔽掉的 replace 事件，下一轮请求的 messages 里就没有切点之后的内容了——但 `sessionId` 完全没变，用户就在这条对话上继续。**

### 4.2 官方先例（不是发明，是照抄）

`@ds/dsh-compaction-basic/lib/index.js:650-661`：

```js
session.append("user/message", checkpointMessage, {
  surfaceOp: { op: "replace", startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
})
```

`@ds/dsh-compaction/README.md:74`：**"The surface is mutated exactly once."**；`:95`："replaces the selected span with one `user/message` carrying the summary — the only surface mutation"；`:97`："The shadowed events stay in the raw log, so replay is deterministic."

### 4.3 精确调用与硬约束（插件宿主侧）

`session.append(type, data, ...opts)`（`@ds/dsh-session/lib/index.js:1517`）只认两个 opts 键：`surfaceOp`、`sourceEventSeqs`。

必须全部满足（否则 append 当场抛，`commit` 之前就拒绝）：

| 约束 | 证据 | 回退场景怎么满足 |
| --- | --- | --- |
| surface 类型**必须**带 `surfaceOp`；非 surface 类型**禁止**带 | `surface.js:201-228` | 用 `user/message`（属于 `SURFACE_EVENT_TYPES`，`surface.js:13-19`） |
| `isReplaceOp` 要求恰好 3 个键 `{op:'replace', startSeq, endSeq}`，两个都是非负安全整数 | `surface.js:190-199` | 注意别多塞字段 |
| `startSeq`/`endSeq` 必须 **< 本事件 seq** | `surface.js:299-308` | 遮蔽到「当前末尾」时 `endSeq = session.seq - 1` |
| start/end 必须在**当前 surface 节点**里，且 `startIdx ≤ endIdx` | `surface.js:310-327` | 用 `session.surface.nodes` 定位下标 |
| `sourceEventSeqs` 非空、不重复、**全部早于本事件**、**必须覆盖每一个被遮蔽的 surface 节点** | `surface.js:230-263` | 把 `nodes[startIdx..endIdx]` 的 seq 全列进去 |
| `assistant/message` 禁止带 `sourceEventSeqs` | `surface.js:230-263` | 用 `user/message` 承载 |
| **node 0 若是 `system/message` 受保护**：覆盖 node 0 的替换必须自己也是 `system/message` 且恰好覆盖这 1 个节点 | `surface.js:376-391` | 切点永远在首条 user 消息之后，不碰 node 0 |
| 若事件类型属 `MESSAGE_PROJECTION_EVENT_TYPES`，必须已有投影定义 | `surface.js:405-407` | `user/message` 的投影由 chat 插件提供，天然满足 |
| `data` 必须 JSON 无损 | `@ds/dsh-session/lib/index.js:1524` | 只放普通对象/数组/数字 |

**tool 配对**：`@ds/dsh-compaction/lib/types/tool-pairing.js:83-96` 提供 `toolPairingBalancedBefore/After(session, seq)`，用来判断一个 cut 是否「没有未答的 tool-call 跨过」。surface 层本身**不**强制这一点（那是 compaction 自己加的，`@ds/dsh-compaction-basic/lib/index.js:550-565`），但**我们必须自己保证**：否则会留下「有 tool-call 没 tool-result」的 assistant 消息，下一轮请求会被 provider 拒绝。**把切点选在 turn 边界（`turn/end` 之后）即可天然满足。**

### 4.4 模型侧效果：真的忘掉

- 请求 messages：`@ds/dsh-agent-loop/lib/index.js:1274`（`deriveMessages()`）。
- 但请求里**同时**还带 `toolHistory: session.toolHistory()`（`:1284`），而 `toolHistory()` 是从 **raw log** 全量投影的（`@ds/dsh-session/lib/index.js:1643-1647`：`for (const event of this.log.slice(this.toolHistorySeq)) this.toolHistoryProjection.apply(event)`），**不受 surface 遮蔽影响**。
- 这是一个**已知残留**：`toolHistory` 只服务于需要工具调用历史的内部消费者（agent-loop / compaction-basic），它不构成 provider 的 messages 正文。**结论：模型正文确实回退；toolHistory 里仍可能留有被遮蔽的工具调用元数据**，如果将来某个插件用它反向重建上下文，需要重新评估。列进 §10。

### 4.5 UI 侧后果（必须处理，否则用户会认为"没回退"）

- 客户端 timeline **不是**从 surface 折出来的，而是**原始日志逐事件映射**：`@ds/dsh-client-ui-chat/lib/client.js:9844-9852` 的 `messageDefinition.match` 对 `user/message` 显式要求 `isAppendSurfaceEvent(event)` 且非 compaction checkpoint。
- `isAppendSurfaceEvent`（`:9475-9477`）= `isSurfaceEvent(event) && event.surfaceOp === "append"`；对应地 `isReplacementSurfaceEvent`（`:9485-9487`）= `event.surfaceOp !== "append"`。
- **即：我们的 replace 事件默认不会生成任何聊天节点，旧气泡也照旧显示。**
- 客户端**能**识别它（wire 事件带字段）：`host-types.txt:204` `SessionWireEvent { type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp? }`。官方自己也是这么取遮蔽统计的：`@ds/dsh-client-ui-chat/lib/client.js:9552` 从 `data.shadowedSeqs` 读被遮蔽列表（compaction 把它写进 checkpoint 的 data）。

**因此插件应当把自己的回退元数据写进 replace 事件的 `data`**（例如 `{ source: { kind: 'session-rewind', cutSeq, shadowedSeqs }, text: '…' }`），这样：

1. 刷新页面/重开会话后，UI 仍能从日志重建「此处已回退」的状态（**持久化天然成立**）；
2. 客户端可以据此把 `anchorSeq ≥ cutSeq` 的行隐藏或灰化，并显示一条提示。

### 4.6 风险与限制

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 原始日志仍然变长 | replace 不删日志，只遮蔽；磁盘占用不降 | 明确告知；需要真瘦身走路径 B |
| 遮蔽不可逆（正向） | 再次 replace 不能「取消」上一次（被遮蔽节点已不在 surface，无法作为新区间的端点） | 拒绝「撤销回退」；若要恢复只能新开会话或 editing 原日志 |
| 多次回退的区间嵌套 | 第二次只能遮蔽 `[cut2 .. cut1-1]`，`cut1` 及之后已在 surface 外 | 用 `session.surface.nodes` 实时算下标，不要缓存 |
| 与 compaction 交叠 | compaction 后续触发时会把我们的 replace 一起遮蔽进更小的一段 | 无碍，语义一致 |
| 切点在 turn 中间 | 会留下不平衡的 tool 配对 | 强制切点选 `turn/end` 之后的 seq |
| `assistant/message` 带 sourceEventSeqs 被拒 | 承载事件必须是 `user/message` | 固定用 `user/message` |
| 模型侧已冻结的消息缓存 | `@ds/dsh-agent-loop/lib/index.js:1275-1279` 的 `frozenMessages` 只「冻结」不删除 | 不影响正确性（冻结是给 KV cache 用的） |

---

## 5. 可行路径 B（唯一「真删」）：停机截断磁盘日志

只在**该会话没有被进程持有**时安全。适用场景：清理历史会话、体积治理、用户明确接受「重启 DSH」。

### 5.1 前提判定（三条全真才能动手）

1. `ctx.sessions.get(sessionId) === undefined`（没有 live session；`@ds/dsh-session/lib/index.js:1980`）
2. `ctx.agents.get(sessionId) === undefined`（没有 live agent；`@ds/dsh-agent-loop/lib/index.js:1658`、`:1661` 就是按这两个判「已释放」的）
3. 进程内没有该 id 的写句柄（等价于 1+2：写句柄由 agent 生命周期持有并在 `teardown` 里 `handle.close()`，`@ds/dsh-agent-loop/lib/index.js:1726`；`@ds/dsh-session-persistence/README.md:53`）

**对「用户正在聊的那个会话」这三条恒假** → 路径 B 不能用于当前会话的即时回退。这就是为什么路径 A 是主推。

### 5.2 操作步骤（离线脚本，不在 DSH 进程内）

1. 复制整个 `<root>/--<cwd>--/<id>/` 目录到备份位置（失败回滚的唯一手段，见 5.4）。
2. 用**官方解码逻辑**读出全部逻辑行（zstd 帧 → 每帧 JSONL 行）：
   - 帧格式见 `@ds/dsh-session-persistence-jsonl/README.md:111`（header 帧 + 每批一帧，一行一事件）；
   - 不要在外部自己拼 Zstd 帧——Node 内置 `zlib` 的 zstd 接口版本差异大，最稳是复用包内 `lib/zstd.ts` 的同款调用；
   - 校验和与帧边界不合规会被当作 corruption 拒绝（`README.md:77`、`:79`）。
3. 定位切点 `cutSeq`（**必须是 `turn/end` 之后**，理由同 §4.3 的 tool 配对）。
4. 只保留 `seq ∈ [0, cutSeq]` 的行，丢弃其余行；**header 行保持不变**（它在独立的首帧里，不进事件 seq 序列）。
5. 重新编码为「header 帧 + 批帧」结构，写入**同目录临时文件**，校验后原子替换 `session.vN.jsonl.zstd`（用 `os.replace`/`MoveFileEx` 语义，保证不出现半文件）。
6. 启动 DSH。resume 时 `open(id,'write')` 读到的新末尾即 `cutSeq`，后续 append 从 `cutSeq+1` 继续。

### 5.3 若切点没落在 turn 边界会怎样

resume 时 agent-loop 会算 `interruptedTurnClosers`（合成 tool/result 错误、未闭合 step/end、`turn/end {interrupted}`）并**以普通批次 append 写入**（`@ds/dsh-session-persistence/README.md:61`）。也就是说**不会损坏**，但会平白多出几条「中断」事件，UI 上会显示一个中断的回合。所以仍建议切 turn 边界。

### 5.4 失败与回滚

- 编码/校验任一步失败 → 不要替换目标文件，删除临时文件，保留原文件（`README.md:85-89` 的 successor 也是「不覆盖」策略，同理）。
- 已替换但启动后报 corruption → 用第 1 步的目录备份整体还原。
- 已替换且成功启动后**不可回退**（被删事件无法从任何地方恢复，除非有备份）。

### 5.5 风险清单

| 风险 | 级别 | 说明 |
| --- | --- | --- |
| 进程仍在持有文件 | **高** | 写句柄会「回滚到之前长度」（`README.md:77`）并覆盖你的改动；内存里的 `log.length` 才是 seq 真值 |
| 撕尾修复把改动当垃圾 | **高** | 写句柄首批发之前会 `truncate` 撕尾字节并重写恢复记录（`README.md:77`） |
| 破坏 generation 一致性 | 中 | 目录里若同时存在多个 generation，运行时选最高编号（`:73`）；改错文件等于没改 |
| 编码不合规 | 中 | 混用压缩/明文后缀会被拒绝（`:111`） |
| 客户端仍在用旧 seq 分页 | 中 | `session/page` 会校验 `sourceLog[throughSeq]?.seq === throughSeq`，否则抛 `session log does not contain through seq N`（`@ds/dsh-api-session-controller/lib/index.js:1491`）→ 前端需强制重载会话 |
| 不可逆 | 中 | 只能靠备份 |

---

## 6. 客户端 timeline 如何感知「事件被截断」（问题 4 答案）

**结论：客户端没有任何「截断」通知通道；它只被推「新增事件」，历史靠分页拉取。**

- `SessionWireEvent`（`host-types.txt:204`）只有 `type/seq/time/data/ignorable?/sourceEventSeqs?/surfaceOp?`，**没有 truncate/rewind/reset 之类的帧类型**；全库搜索 `session/truncate`、`session/rewind`、`session/undo` 均 0 命中（§2.6）。
- 增量：`session/follow`（`@ds/dsh-api-session-controller/lib/index.js:1510`）监听 `session/event` 推新事件（`:1529-1536`），文档写明是 "Follow events appended after an initial cursor"（`:1505-1508`）—— **只处理「追加」**。
- 历史：`session/page` 用 `throughSeq` / `beforeSeq` 分页（`SessionPageRequest`，`host-types.txt:173`），并**硬校验** `throughSeq` 必须真实存在（`lib/index.js:1491`）。日志被截短后，旧的 `throughSeq` 直接报 `gateway/internal`。
- 因此：**路径 B（真截断）之后必须强制客户端重建会话视图**（刷新页面 / 切走再切回 / 重新 open 会话），否则前端会处于「本地有一批服务端已不存在的行」的不一致状态。
- 反过来，**路径 A（replace 遮蔽）不需要任何重载**：它是普通的 append，`session/event` 正常推达（`@ds/dsh-session/lib/index.js:1587-1592`），客户端收到一个 `surfaceOp !== 'append'` 的事件，按官方 `isReplacementSurfaceEvent`（`@ds/dsh-client-ui-chat/lib/client.js:9485-9487`）判定后自行处理即可。

---

## 7. 回退 UI 触发面收窄（问题 5 答案）

### 7.1 为什么 `conversation.chat.turnTail` 会显得吵

`.probe\slots.txt:56-62`：

```
kind=list scope=session replaceRisk=none
registerOptions=id(required), order(optional:number), label(optional:string | (()=>string))
declaredBy=an entry in 'conversation.chat.node' (client-ui-chat)
ownerProps=TurnTailOwnerProps { turn: TurnLocation; seq: number; openFile(path): void }
```

它是挂在 **`turn-tail` 节点**上的扩展链（`.probe\slots.txt:45` 中 `TurnTailNodeView key 'turn-tail'`），而 `turn-tail` 每个回合结束都产生一个节点 → 列表项**每回合渲染一次**。组件可以内部返回 `null`，但那就没有 hover 锚点了（不能"平时隐形、hover 出现"）。

### 7.2 推荐：`conversation.chat.assistant-actions`

`.probe\slots.txt:10-16`：

```
kind=list scope=session replaceRisk=none
registerOptions=id(required:string), order(optional:number), label(optional:string | (() => string))
declaredBy=an entry in 'conversation.chat.node' (client-ui-chat), so it exists while that entry is mounted
occupants=client-ui-message-feedback MessageFeedbackActions id 'feedback'
ownerProps=AssistantActionOwnerProps { messageId: MessageId }   // 注释：Owner currency of finalized-assistant actions
source=packages/client/ui-chat/src/client/contract/slots.ts:441
```

好处：

1. **作用域天然收窄**到「已完成的 assistant 消息」的脚注动作区，而不是每回合一条横幅；
2. 与官方 feedback 按钮同槽，视觉上自动归入消息操作区；
3. ownerProps 给了 `messageId`，可以精确把「回退到这条回复之前」映射到一个 turn；
4. 我们自己的组件可以完全控制自身显隐（CSS `:hover` / 内部 state），**不需要宿主配合**——"平时隐形、hover 出现"是在我们组件内部实现的，与槽无关。

### 7.3 user 消息侧没有官方动作槽（必须知道）

100 个插槽里与 user 消息相关的只有：

- `conversation.chat.user.images`（single，`replaceRisk=shadows-shipped-ui`，`.probe\slots.txt:64-69`）
- `conversation.user.text.node`（keyed，keyDomain 已占 command/file/folder/secret/session/skill/text，t1 已记录）

**没有 `conversation.chat.user.actions` 之类的槽。** 若产品要求"点在 user 气泡上回退"，只能：

- (a) 注册 `conversation.chat.node` 的 key `user` 去遮蔽官方 `UserMessageNodeView`（keyed 槽同 key 是否允许覆盖，见 §10 未知项；风险：`replaceRisk=shadows-shipped-ui` 意味着会遮蔽官方 UI）；
- (b) DOM 注入（参考插件 `dsh-message-rewind` 的做法：`document.querySelectorAll('[data-chat-flow-kind="user"]')` + 自定义 `data-chat-anchor-key`，`lib/client.js:161`、`:173`）。

**建议产品语义改为**：在 assistant 回复的 actions 里提供「撤销本轮（回到这次提问之前）」，切点 = 该 turn 的起点。这样完全避开 user 侧无槽的问题，也与官方 `forkAt`（挂在 turn-tail 上）的语义一致。

### 7.4 `input.dock` / `input.overlay` 的显示条件

- `conversation.input.dock`（`.probe\slots.txt:155-161`）：list 槽，`ownerProps=InputZone { session: SessionSnapshot; input: InputState }`，占据者 `QueueDock`、`TodoDock`、`GoalDock`、`Band`。**这些 dock 项都是「有内容才显示」**（队列/待办/目标存在时）——说明"按条件显示"是组件自己的责任，槽不提供显隐开关。
- `conversation.input.overlay`（`.probe\slots.txt:184-190`）：list 槽，占据者 `command-popup`、`slash-menu`、`feedback-dialog`，**ownerProps 为空**，属于浮层，不适合放常驻的「已回退」提示。
- 结论：若需要一条「已回退到第 N 条」的常驻提示，用 `conversation.input.dock`（list 项 + 内部按 state 决定是否渲染）；若要浮层确认框，用 `conversation.input.overlay`。两者都不提供"槽级条件渲染"，条件由组件自己判断。

---

## 8. 不可行清单（明确不要尝试）

1. ❌ 直接调用某个「截断会话」API —— **不存在**（§2 六层全空）。
2. ❌ 在会话运行中改写 `.jsonl.zstd` —— 写句柄会回滚长度并重写撕尾（`@ds/dsh-session-persistence-jsonl/README.md:77`）。
3. ❌ 手写一个更高编号的 generation 文件（如 `session.v5.jsonl.zstd`）来"替换历史" —— generation 编号是**格式版本**（README `:57-71`），读到不认识的更新格式会被 direction-aware error 拒绝（`@ds/dsh-session-persistence/README.md:67`："A newer format instructs the operator to upgrade the harness"）。
4. ❌ 在内存里把 `session.log` 截短 —— `append` 的 seq 恒等于 `log.length`（`@ds/dsh-session/lib/index.js:1530`），会与持久化层的 stored next-seq 冲突（不变量见 `@ds/dsh-session-persistence/README.md:85`）。
5. ❌ 用 `ctx.sessions.create(id, {seed})` 重建同 id 会话 —— id 已被占用，`enter` 抛错（`@ds/dsh-session/lib/index.js:1856`）。
6. ❌ 让插件自己 detach 别人的会话 —— detach disposer 由 `enter()` 交给调用者，agent 会话由 agent-loop 持有（`@ds/dsh-session/lib/index.js:1760-1763`、`:1853`）；`SessionStore` 无公开 `detach(id)`。
7. ❌ 依赖 `session/disposed` 去主动释放 —— 它是拆除的**结果**（`@ds/dsh-session/lib/index.js:1925-1937`），扳机在 agent teardown（`@ds/dsh-agent-loop/lib/index.js:1703-1734`）。

---

## 9. 两条路径的取舍表

| 维度 | 路径 A：surface 遮蔽 | 路径 B：停机截断 |
| --- | --- | --- |
| `sessionId` 不变 | ✅ | ✅ |
| 模型侧真的回退 | ✅（`deriveMessages()`） | ✅（日志消失） |
| 立即生效、无需重启 | ✅ | ❌ 必须重启 DSH |
| UI 旧气泡消失 | ❌ 需插件隐藏/标记 | ✅ 重载后自然消失 |
| 磁盘变小 | ❌ | ✅ |
| 可逆性 | 不可撤销（只能再遮蔽更早处） | 不可逆（只能靠备份） |
| 实现风险 | 低（官方 compaction 同款，且有硬校验兜底） | 高（持文件、编码、generation、客户端旧 seq） |
| 适用范围 | 任何 live 会话（含当前正在聊的） | 仅未打开/重启后的会话 |
| 失败后果 | append 当场被拒（无副作用） | 日志损坏，需备份还原 |

**建议的产品组合**：默认走 A（即时、同会话、安全），并在 UI 明示「历史仍在本地日志中，未被删除」；把 B 作为单独的高级命令（明确提示需要重启、不可逆、需备份）。

---

## 10. 未知项（禁止当结论使用）

1. **`conversation.chat.node` 的 keyed 槽同 key 二次注册语义**：我们的条目能否覆盖官方已占用的 key（如 `user`、`turn-tail`）？`replaceRisk=shadows-shipped-ui` 暗示"会遮蔽官方 UI"，但**是否被允许、是覆盖还是抛错**，`.probe\slots.txt` 未记录，需 spike。
2. **自定义 ChatNodeKind 是否可行**：能否注册一个新 kind（如 `session-rewind`）并同时挂 `uiConversation.events` Definition 与 `conversation.chat.node` 的 keyed 槽。`keyDomain` 明确写着"fixed by the owner's key table"，运行时是否校验未验证（t1 已列为未知项）。
3. **`toolHistory` 残留的影响面**：请求同时带 `toolHistory: session.toolHistory()`（`@ds/dsh-agent-loop/lib/index.js:1284`），它读 raw log、不受遮蔽影响（`@ds/dsh-session/lib/index.js:1643-1647`）。目前只被 agent-loop / compaction 消费，但**若有插件用它重建上下文，遮蔽就不彻底**。需确认 provider 适配层是否忽略它。
4. **客户端能否可靠地把 DOM 行与 seq 对应**：官方行属性是 `data-chat-flow-kind`（参考插件用它做选择器，`dsh-message-rewind/lib/client.js:173`），`data-chat-anchor-key` 是参考插件自己加的（`:161`）→ 我们若要隐藏行，需要确认官方是否提供稳定的 seq/anchor 属性，否则要自己按 `chat.getSnapshot().timeline` 对齐。
5. **Zstd 帧的 Node 侧可操作性**：`@ds/dsh-session-persistence-jsonl` 用的是 Node 内置 Zstandard（`README.md:111`），其 API 在 Electron 的 Node 版本上是否与系统 Node 一致、能否在外部脚本里稳定复现"header 帧 + 批帧"结构，未实测。
6. **`session/page` 截断后的 `hasMore` 行为**：`paginate`（`@ds/dsh-api-session-controller/lib/index.js:1492`）在日志变短后对旧 `beforeSeq` 的处理未实测（只有 `throughSeq` 的硬校验是确证的）。
7. **compaction 与 rewind 的交叠顺序**：若用户在回退后又触发 compaction，compaction 的区间可能与我们的 replace 区间部分重叠，`validateSurfaceRegion`（`@ds/dsh-compaction-basic/lib/index.js:550-565`）是否始终能找到合法区间，未实测。

---

## 11. 证据强度声明

- **强（读源码 + 读真实文件 + 全库字符串搜索三重印证）**：§2 六层能力穷举（无截断 API）、§1 存储形态、§4.1/4.2 遮蔽机制与官方先例、§6 wire 协议无截断帧。
- **中（读源码 + 类型声明，未运行验证）**：§4.3 的约束表（源码就是硬校验，错误文案明确）、§7 插槽参数（来自官方 slot 元数据表）。
- **弱 / 推断（已在正文标注）**：§4.4 `toolHistory` 残留的实际影响、§5.2 外部脚本复现 Zstd 帧结构的可行性、§10 全部未知项。

> 本文档只陈述可复核的事实与由事实推出的路径；任何"应该可以"的地方都已降级到 §10。
