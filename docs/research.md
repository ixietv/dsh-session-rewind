# 会话回退（session rewind）源码侦察事实清单

侦察员：api-scout ｜ 任务：t1 ｜ 目标宿主：DeepSeek Harness 0.2.1-rc.2（`app.asar`）
产出目的：给架构师一份**只含被源码证实的结论**的事实底座。每条结论都带文件路径与行号；未能证实的内容集中在第 8 节「未知项（禁止当结论使用）」。

---

## 0. 结论摘要（先看这里）

| # | 判定 | 结论 | 证据 |
|---|---|---|---|
| F1 | ✅ 可行 | 官方**唯一的**"回退"原语是 **fork 出新会话**，客户端服务 `sessions.fork(opts)`，任意真实 seq 都能切（含首条消息之前） | §3.1 §3.2 |
| F2 | ✅ 可行 | 切到子会话的正确 API 是 **`ctx.uiWorkspace.openSession(childId)`**；`sessions.open` **不存在** | §5.1 |
| F3 | ❌ 不存在 | 全库**没有** undo / rewind / restore / rollback / truncate 任何 API 或包 | §3.4 |
| F4 | ✅ 可行（仅"模型可见"） | 宿主可用 `session.append(type, data, { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs })` **原地**用 1 个节点替换一段历史 —— compaction 就是这么干的 | §2.3 §2.4 |
| F5 | ❌ 不可行 | surface replace **无法让 UI 变短**。客户端聊天行只从 *append-origin* 事件生成，replace 型事件默认不产生任何行；被遮蔽的旧行**仍然显示** | §2.5 §5.6 |
| F6 | ❌ 不可行 | 没有任何"遮蔽/隐藏某个已渲染行"的扩展点。Definition 匹配是**全匹配叠加**（不是首个胜出），`exclusive` 冲突直接抛错 → 只能**加**行，不能**减**行 | §5.6 |
| F7 | ⚠️ 不可逆 | surface replace 是 **1 换 N**，N 个原节点无法还原（再把那 1 个节点 replace 掉，得到的还是 1 个节点）。原地截断 = 会话内**永久**丢弃历史 | §2.4 |
| F8 | ✅ 可行 | 官方已把 **`forkAt(seq)` 回调**交给每个 chat 节点渲染器（`ChatNodeOwnerProps.forkAt`），但它只挂在 turn-tail 的 footer，**只支持"按回合末尾"分支**，不支持"按用户消息" | §5.3 |
| F9 | ⚠️ 需 spike | 自定义 ChatNodeKind（如 `session-rewind`）+ 自定义 `conversation.chat.node` 槽键能否在运行时成立，未验证 | §8 |

**给架构师的取舍建议（事实层面，不含实现）**：F1+F2 是**官方支持路径**，风险最低；F4 能实现"模型真的忘掉"，但 F5/F6/F7 三个硬约束意味着它**用户看不见效果、且不可撤销**，只能作为显式选项而非默认行为。

---

## 1. 侦察方法与可复现工具

- asar：`C:\Users\i_xie_tv\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`（18309 个文件，174MB）。
- 抽取脚本：`C:\Users\i_xie_tv\.dsh\.probe\extract.mjs`，用法 `node extract.mjs <asar> <路径正则> <输出目录>`；抽取时剥掉 `dsh/` 前缀，本文件所有 `node_modules/@deepseek-ai/...` 路径都相对
  `C:\Users\i_xie_tv\.dsh\.probe\asar-out\`。
- 自建辅助脚本（后续所有成员可直接复用）：
  - `C:\Users\i_xie_tv\.dsh\.probe\grep-asar.mjs` —— 不解包直接在 asar 内按内容搜字符串：`node grep-asar.mjs <asar> <needle> [maxFiles] [onlyPathRegex]`（第 4 参要么全给、要么完全不传；传 `(?!)` 会跳过一切）。
  - `C:\Users\i_xie_tv\.dsh\.probe\asar-pkgs.mjs` —— 只读 asar header 枚举包名：`node asar-pkgs.mjs <asar> <regex>`。
  - `C:\Users\i_xie_tv\.dsh\.probe\slot-catalog.mjs` —— 从 `dsh-cordis-client-runner/lib/client.js` 抽出 100 条插槽目录，输出 `slots.txt`。
  - `C:\Users\i_xie_tv\.dsh\.probe\typert-dump.mjs` —— 抽 `{name, declaration}` 类型声明对：宿主 425 条 → `host-types.txt`，客户端 152 条 → `client-types.txt`。**查精确签名用它最快。**
  - `C:\Users\i_xie_tv\.dsh\.probe\log-scan.mjs` —— 扫 `session.v4.jsonl` 打印 seq/type/surfaceOp。
- 重要事实：**asar 内没有任何 `.d.ts`**；类型信息全部藏在各包的 `lib/typert.host.js` / `lib/client.js` 的"类型元数据注册表"里（`declaration:` 字符串）。

---

## 2. 宿主侧：Session、append、surface

### 2.1 Session 服务与实例获取

- `dsh-session/lib/index.js:1739` → `super(ctx, "sessions")`：**宿主服务名 `ctx.sessions`**（`SessionRegistry`）。
  - `create(id, options)`（:1772）、`enter(session)`（:1853）、`get(id)`（:1980）、`list()`（:1987）、`observe(event)`（:816）。
- 在 RPC 控制器里普遍写成 `this.ctx.sessions.get(sessionId)`（`dsh-api-session-controller/lib/index.js:224, 241, 396`）；Agent 上的会话实例是属性 `agent.session`（`dsh-agent/lib/index.js:198` `agent.session.requestHeader()?.config`）。
- 面向客户端的控制器服务是 **`ctx.sessionController`**（`dsh-api-session-controller/lib/index.js:2952` `super(ctx, "sessionController", { namespace: "session" })`），**不是** `ctx.sessions`。两者不同层：前者是 RPC 门面，后者是会话注册表。
- `Session` 关键成员（`dsh-session/lib/index.js`）：`get surface()`（:1329）、`append(...)`（:1517）、`commit(event, entry)`（:1579）、`deriveMessages()`（:1672）、`fork(...)`（:2006）。

### 2.2 `session.append` 精确签名

`dsh-session/lib/index.js:1517-1538`：

```js
append(type, data, opts?)   // opts 只认两个字段：surfaceOp、sourceEventSeqs
```

- **不是** `append(event)`。`data` 必须 JSON 无损快照，否则抛 `carries non-JSON-serializable data`。
- `commit`（:1579）先 `this.surfaceManager.validateNext(event)` 再写日志 → **一切校验都在 append 落地前触发**。

### 2.3 `surfaceOp` 与 `sourceEventSeqs` 的硬约束（`dsh-session/lib/types/surface.js`）

| 行号 | 约束 | 报错原文 |
|---|---|---|
| :13-19 | surface 类型只有 5 种：`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result` | — |
| :190-199 | replace 必须**恰好 3 个键** `{op:'replace', startSeq, endSeq}`，两 seq 为非负安全整数 | — |
| :201-228 | surface 类型**必须**带 surfaceOp；非 surface 类型**禁止**带；op ∈ {append, replace} | `session event "x" is surface-eligible and requires a surfaceOp marker` / `is not surface-eligible and cannot carry surfaceOp` |
| :230-263 | `sourceEventSeqs`：非空、无重复、全部**早于**当前 seq、且**必须覆盖全部被遮蔽节点** | `sourceEventSeqs must reference earlier events: N >= current seq` / `surface replace: sourceEventSeqs must include every shadowed surface node; missing ...` |
| :299-308 | replace 的 startSeq/endSeq 必须 < event.seq | `surface replace at seq N: startSeq and endSeq must reference earlier events` |
| :310-327 | start/end 必须在当前 `surface.nodes` 内，且 startIdx ≤ endIdx | `surface replace: start seq N not found in surface` |
| :349-375 | `tool/result` 的 replace 只能覆盖**恰好 1 个**节点且只能改 content | `may change only content` |
| :376-391 | **node 0 是 system/message 时受保护**：只有 `system/message` 能覆盖它、且恰好 1 个节点 | `surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node` |
| :431-454 | 执行 `nodes.splice(startIdx, endIdx-startIdx+1, plan.seq)`，`replaceGeneration++`、`contentGeneration++` | — |
| :394-407 | seq 必须与日志长度连续；消息类事件必须先有投影定义 | `requires a message projection; load its owning plugin` |
| :39-52 | **语义关键**：`isAppendSurfaceEvent` 的文档原话 | "The model-visible surface deliberately shadows replaced ranges, so it is the wrong source for a human transcript — a landed replacement would erase conversation the user already saw. Append-origin events are that transcript's durable source material; replacement copies stay model-only." |

→ 对"回退"的直接含义：
1. 从"首条用户消息"回退**不会**碰 node 0（node 0 是 system prompt），被 :376-391 保护的场景无关。
2. 但 `sourceEventSeqs` 必须**逐个列出**被遮蔽的 surface 节点，漏一个就抛错（:230-263）。
3. tool-call / tool-result 配对平衡**不是 surface 层强制的**，只是 compaction 自己的 `validateSurfaceRegion`（§2.4）额外要求。跨过未应答 tool call 的截断在 surface 层能通过，但模型侧会看到孤立 tool-call。

### 2.4 官方唯一先例：compaction 的"原地改写"

- `dsh-compaction-basic/lib/index.js:650-661`：

```js
session.append("user/message", checkpointMessage, {
  surfaceOp: { op: "replace", startSeq: start, endSeq: end },
  sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
})
```

- `dsh-compaction-basic/lib/index.js:550-565` `validateSurfaceRegion(session, start, end)` 额外要求（**compaction 自有，不是 surface 层**）：区间内 tool-pairing 前后必须平衡（`is not a balanced boundary (would split a step's tool-call/result pair)`、`would split a step, or the step is still open`）。
- `dsh-compaction/lib/types/tool-pairing.js`：`eventDelta`（:9-18，assistant/message 里 tool-call 块 +N、tool/result −1）、`toolPairingBalancedBefore/After`（:83-96），按 `surface.replaceGeneration` 失效的 WeakMap 缓存（:7）。
- `dsh-compaction/README.md` 权威表述：:74 "**The surface is mutated exactly once.** The summary rides on a `user/message` replacement inside the bracket; all `compaction/*` events stay log-only."；:97 "The shadowed events stay in the raw log, so replay is deterministic."；:142 "The raw events stay logged but stop appearing in derived model messages; the seam itself performs no rewrite."
- CompactionEngine 契约（README:78）：`compactIfNeeded`、`compactNow`、`compactRegion`；服务名 `ctx.compaction`；另有 `ctx.tokenMeter`。

### 2.5 UI 为什么看不见 replace（决定性）

客户端聊天行**不是**从 `surface` 派生的，而是**原始日志逐事件映射**（`dsh-client-ui-chat/lib/client.js`）：
- :9844-9852 `messageDefinition.match` 对 `user/message` **要求 `isAppendSurfaceEvent(event)`** 且非 compaction checkpoint；
- :9712（assistant）、:10386（tool/result）同样是 append-origin；
- :9827-9830 唯一的例外：`source.kind === "compact-checkpoint"` 的 replace 会被识别成"压缩卡片"（:9527-9563 生成 `{kind:'compaction', ...}`）。

→ **任何 replace 事件默认在 UI 里不产生行，而被它遮蔽的旧行照旧显示。** 这就是"原地截断"在界面上完全看不出效果的原因。

---

## 3. fork：官方真正的回退原语

### 3.1 宿主 `session/fork` RPC

- schema：`dsh-api-session-controller/lib/typert.host.js:506-513`
  - 入参 `{ sessionId, atSeq?（describe: 'Exact inclusive source event seq; omission selects the latest completed-turn prefix.'）, allowMigration? }`
  - 出参 `{ sessionId }`
  - 类型别名：`SessionForkRequest { sessionId; atSeq?; allowMigration? }`、`SessionForkValue { sessionId }`（`host-types.txt:160-161`）
- 实现：`dsh-api-session-controller/lib/index.js`
  - :720-733 `latestCompletedPrefixBoundary(events)`（省略 atSeq 的默认：最后一个 `turn/end`，再向后吞掉非 `turn/start`、非 append `user/message`、非 `agent/inbox/spliced` 的独立事件）
  - :842-848 文档原话："An explicit `atSeq` is the inclusive cut; an omitted value selects the latest completed-turn prefix. An open cut receives synthetic fork closers."
  - :849 `async fork(request)`；:856-860 atSeq 校验（非负安全整数，否则 `gateway/bad-request`）
  - :870 `boundary = atSeq ?? latestCompletedPrefixBoundary(...)`
  - **:871 唯一的存在性校验**：`source.events[boundary]?.seq !== boundary` → 抛 `session/fork-unavailable`，`event N does not exist in session "..."`。**没有"必须是 turn/end"的要求。**
  - :872 `buildForkSeed(source.events, boundary)`；:879 子会话 id `session-${randomUUID()}`；:883-898 `ctx.agents.create({ sessionId, seed, inheritedEventCount: boundary+1, meta:{cwd, parentSession, isSeeded:true, agentPreset}, agentOptions:{provider,model} })`；:902-909 挂 workspace；:910 返回。
- `dsh-session/lib/index.js:927-936` `buildForkSeed(events, boundary)`：`prefix = events.slice(0, boundary+1)` + 合成 `session/end-seed`（`data:{inherited:true}`，seq = boundary+1）+ `openTurnClosers(prefix, {kind:'forked'})`。注释："close its open tail with forked results and step/turn endings. Closed steps and turns are preserved unchanged."
  → **切在 open turn 中间也安全**（会自动补合成的收尾事件）。

### 3.2 客户端 `sessions.fork`

`dsh-api-session-controller/lib/types/client/sessions/service.js`：

```ts
async fork(opts: {
  sessionId: SessionId
  atSeq?: number
  allowMigration?: boolean
  increaseTitle?: boolean
  onCreated?: (childId: SessionId) => void
}): Promise<SessionId>   // 失败抛 SessionForkError（含 rpcError、sourceSessionId）
```

- `onCreated` 在**改名之前**调用；`increaseTitle` 走 `increasedForkTitle(sourceTitle)`。
- **`ClientSessions` 没有 `open` 方法**（方法全集：retain/using/retainInfo/subagentAddress/refreshProjections/refresh/search/scope/retainAgentScope/scopeOf/sessionOf/binding/retainScope/retentionSnapshot/projectList/create/fork/handleControlFrame…，见该文件 :148-583）。

### 3.3 首条消息能不能回退？能。

真实会话日志（`C:\Users\i_xie_tv\.dsh\sessions\--C-Users-i_xie_tv-OneDrive-Desktop-...--\b753fb42-.../session.v4.jsonl.decompressed.jsonl`，377 行）前段 seq：0 `permission/preset`、1 `sandbox/mode`、2 `approval/policy`、3 `session/end-seed`、4 `agent-preset/selected`、5 `command/run`、9/12/14/15 `agent/inbox/spliced`、10 `command/done`、11 `model/selection`、13 `turn/start`、16 `step/start`、17 `system/message`、18-22 `user/message`（注入上下文 + 真实提问）。

→ 首条真实提问前存在大量 log-only 事件。**推荐 `atSeq = 16`（`step/start`）**：前缀 0..16 里没有任何 surface 消息，`openTurnClosers` 会把 seq 13 的 `turn/start`、16 的 `step/start` 补成合成收尾，子会话从"零对话"开始。
不要取 17（`system/message`）：那会把第一个 step 的系统提示一起继承进子会话，可能与子会话自己新写的系统提示重复。**通用规则：boundary 必须落在"不含任何 surface 消息"的位置上，或至少与期望保留的对话前缀严格对齐。**
参考插件之所以做不到首条消息，**不是平台限制，是它自己的 anchor 策略**（§6）。

### 3.4 全库没有 undo 类能力

- `@deepseek-ai` 共 **306 个包**，按 `undo|rewind|checkpoint|restore|rollback|revert|truncate|edit|history|fork|session` 过滤得 35 个，**没有任何 undo/rewind/restore/rollback 包**（`dsh-session-checkpoint-policy` 属于 compaction 检查点策略，不是撤销）。
- 全局字符串搜索 `session/undo`、`session/rewind`、`session/truncate`、`op:"truncate"`、`surfaceOp: null`：**asar 内 0 命中**。
- surface 的 op 枚举只有 `append` 与 `replace`（`dsh-session/lib/types/surface.js:201-228`），**没有 delete/truncate/unreplace**。

---

## 4. 插件形态（包结构）

参考插件 `C:\Users\i_xie_tv\.dsh\profiles\desktop\node_modules\dsh-message-rewind\package.json`：

```json
"type": "module",
"main": "lib/host.js",
"exports": { ".": "./lib/host.js", "./client": "./lib/client.js", "./cordis.patch.yml": "...", "./package.json": "..." },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } },
"peerDependencies": { "@deepseek-ai/cordis": "*", "@deepseek-ai/dsh-client-ui-slots": "*", "react": "^18.2.0" }
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: message-rewind
      name: 'dsh-message-rewind'
```

客户端入口是预构建 bundle，必须包一层模块加载器（`lib/client.js:19`）：

```js
window.__ModuleLoader__.load({ id: 'dsh-message-rewind', factory: (require) => { ... } })
```

内部用 `require('react')` / `require('@deepseek-ai/dsh-client-ui-slots')` 等（各官方 client.js 同样是这种写法，例如 `dsh-client-ui-renderer/lib/client.js:14`、`dsh-client-ui-conversation/lib/client.js:31`）。
插件声明依赖的标准写法：`const inject = ['slots', 'sessions']`（参考插件 `lib/client.js:380`）。

---

## 5. 客户端：插槽、服务、精确参数

### 5.1 切换会话

- `ctx.uiWorkspace.openSession(childId)` —— `dsh-client-ui-workspace/lib/client.js:1470-1472` `openSession(target) { this.replaceMain(target, this.lifetime.signal, "reveal") }`；类型声明 `openSession(target: SessionTarget): void`（`dsh-cordis-client-runner/lib/client.js:1494`）。
- 官方自己的分支按钮就是这么写的 —— `dsh-client-ui-chat/lib/client.js:13266-13283`：

```js
forkAt: (seq) => {
  const messageId = [...chat.getSnapshot().timeline.turns.values()]
    .find((turn) => turn.end?.seq === seq)?.data.get("turn-tail")?.closing?.finalNode.messageId
  ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true,
    onCreated: (childId) => { ctx.get("productAnalytics")?.track("branch_session_click", {...}) } })
    .then((childId) => { ctx.uiWorkspace.openSession(childId) })
    .catch(() => {})
}
```

- 其它同包可用服务：`ctx.sessions.binding(sessionId)` → `{ session }`（chat 条目 inject 用它，:13236-13239）；`ctx.sessions.list.getSnapshot().byId[sessionId].cwd`（:13244）；`ctx.uiConversation.imageUrl(sessionId, attachment)`；`ctx.sidebarRight.openResource(url, {params:{line}})`；`ctx.get('productAnalytics')`、`ctx.get('chatFileMentions')`。

### 5.2 `ctx.slots` 服务本体

- 实现：`dsh-client-ui-renderer/lib/client.js:1305` `var SlotRegistry = class extends cordis.Service`，`:1347-1352` `constructor(ctx){ super(ctx, "slots"); ... }` → **服务名 `"slots"`**。`apply` 在 :1867-1875：`new SlotRegistry(ctx).install(createSlotRenderer())`，并 `ctx.reflect.provide("uiRenderer", { mount })`。
- 注意：`@deepseek-ai/dsh-client-ui-slots` **只提供纯核心 `SlotCore` 与类型**，服务实例在 renderer 包里。
- 关键 API（同文件）：
  - `inject(key, callback)`（:1368-1427）—— 按**声明生命周期**安装 effect：slot 已声明→同步执行；未声明→挂起，等声明者 `register()` 提交后执行；声明坍缩→dispose，重新声明再执行。整个 controller 属于调用者 fiber，插件卸载自动取消。
  - `register(rawOptions, component)`（:1813-1816）/ `registerFactory`（:1817-1820）—— 都返回 `ctx.effect(...)`。`_register` 支持 `options.store`（函数或句柄）与 `options.registrant`（缺省取 `this.ctx.fiber?.name`）（:1603-1623）。
  - `entries(key)`（:1542）、`entriesOfSlot(key)`（:1554）、`snapshot(root?)`（:1562）、`onEntryError(fn)`（:1574）、`spec(key)`（:1582）、`subscribe`（:1591）、`getVersion`（:1599）。
  - `renderSlot(key, owner)`（:1531-1536）：**ctx 级只能渲染 `'root'`**，否则抛 `ctx-level renderSlot only renders "root" (got "<k>"); child slots render through the component props face`。
- 渲染期硬校验：entry 已释放 → `StaleAuthorizationError: renderSlot('<k>') from a disposed registration`；声明缺失 → `SlotOwnershipError: slot '<k>' is not declared by this entry's children`；kind 不符 → `is declared 'chain' — use renderSlotChain` / `is declared '<kind>', not 'chain' — use renderSlot`；Factory 越界 → `local slot '<n>' is not declared by factory '<name>'`；递归 → `recursive render of factory '<name>'`。

### 5.3 注册项字段全集

`dsh-client-ui-chat/lib/client.js:13222-13287` 是官方最完整的注册实例：

```js
ctx.slots.register({
  name: "conversation.view",      // 必填：槽键
  id: "chat",                     // single/list/keyed 各自的键
  order: 0,                       // list 排序，升序，默认 0
  label: () => t("view.chat"),    // 显示名，thunk 每次投影重读
  locale: NS,
  children: { "conversation.chat.flow": { kind: "single", scope: "session", inject: CHAT_FLOW_INJECT } },
  store: chatStore,               // 条目自己的 store
  inject: (sessionId) => ({ ... }), // 每会话 owner props 合并体
}, ChatView)
```

多条目一次注册用 generator：`ctx.slots.inject("conversation.composer.dock", function* () { yield ctx.slots.register({...}, ActivityPill); yield ctx.slots.register({...}, UsagePill) })`（`dsh-client-ui-chat/lib/client.js:13313-13328`）。

### 5.4 与回退相关的插槽（完整参数）

| 槽键 | kind | replaceRisk | registerOptions | 占用者 / 声明者 |
|---|---|---|---|---|
| `conversation.chat.node` | keyed | **shadows-shipped-ui** | `key`(必填) | 声明者：`conversation.chat.flow` 的条目。keyDomain = `ChatNodeKind` 固定表，已占：assistant-step, command, command-input, compaction, context, manual-compaction, model-retry, question-reply, steering, system-prompt, tool-call, turn-error, turn-max-tokens, turn-process, turn-tail, turn-trigger, unknown, user, workflow-run（19 种；**`user` 由 `client-ui-chat UserMessageNodeView` 占用，替换该键 = 替换所有用户气泡**）｜source `packages/client/ui-chat/src/client/contract/slots.ts:402` |
| `conversation.chat.flow` | single | shadows-shipped-ui | — | 占用者 ChatFlow；ownerProps 含 `entries`、`pendingInputs`、`lastInputTurn`、`deferCollapse`、`forkAt` 等｜`slots.ts:390` |
| `conversation.chat.turnTail` | **list** | none | `id`(必填)、`order`(可选，默认 0)、`label`(可选) | 占用者 DeliverablesTail、PlanCards、ScheduleTurnCard `id 'schedule-created'`；ownerProps `TurnTailOwnerProps { turn; seq; openFile }`｜`slots.ts:435` |
| `conversation.composer.dock` | **list** | none | `id`(必填)、`order`(可选)、`label`(可选) | 声明者：`conversation.composer.bar` 的条目；占用者 ActivityPill `id 'activity'`、UsagePill `id 'usage'`；ownerProps 为空｜`packages/client/ui-conversation/.../slots.ts:274` |
| `conversation.chat.assistant-actions` | list | none | `id`(必填)、`order`、`label` | 占用者 MessageFeedbackActions `id 'feedback'`｜`slots.ts:441` |
| `conversation.approval.detail` | single | shadows-shipped-ui | — | 声明者：`conversation.composer` 的条目（client-ui-approval）｜`slots.ts:37` |
| `conversation.chat.user.images` | single | shadows-shipped-ui | — | 声明者：factory `conversation.chat.user.content`｜`slots.ts:417` |
| `conversation.user.text.node` | keyed | shadows-shipped-ui | `key`(必填) | keyDomain 已占 command/file/folder/secret/session/skill/text；声明者 factory `conversation.user.text`｜`ui-conversation/.../slots.ts:196` |

**`forkAt` 已由官方交给每个 chat 节点渲染器**：`conversation.chat.node` 的 ownerProps 是

```ts
ChatNodeOwnerProps { groupPart?, cwd?, openFile, inspectCall?, forkAt: (seq: number) => void, loadImage, fileMentions, turnProcess? }
```

即：只要渲染一个 chat 节点的自定义视图，就能拿到 `forkAt`。但它目前的 UI 位置只在 turn-tail footer（`dsh-client-ui-chat/lib/client.js:6963` TurnTailNodeView 收 `forkAt`，:6998 `forkAt(data.seq)`）→ **官方只提供"按回合末尾分支"**，不提供"按用户消息回退"。

### 5.5 标准 props（所有 session scope 插槽固定 17 项）

`useRemoteAccess`、`useResource`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`、`useChat`、`useConversation`、`useInput: SnapshotSelectorHook<InputState>`、`inputActions: InputActions`、`useSession: SessionSnapshotSelector`、`sessionId: SessionId`、`useProjection`、`useAccess`、`useTrajectory`。

`InputActions` 实测方法（`dsh-client-ui-conversation/lib/client.js`）：`setDraft(text)`（:14672、:15008）、`submit(mode = "queue", source)`（:15164）、`insertText(text, span, keepCompleting = false)`（:15345）、`captureInsertion()`（:14913）、`persistDraft()`（:17937）、`pruneAttachments(ids)`（:18831）。`ImageActions.addImages` 见参考插件 `lib/client.js:317` 的用法（`cap2.inputActions.addImages(user.imageIds)`）。

### 5.6 自定义聊天行 / 无法隐藏行（关键限制）

- 扩展点：`ctx.uiConversation.events.register(definition)`（官方用法见 `dsh-client-ui-chat/lib/client.js:9822`）。
  - `dsh-client-ui-conversation/lib/client.js:3356-3358`：以 **`definition.kind` 为唯一键**，重复注册抛 `conversation Definition "<kind>" is already registered`；另有 views（:3631，按 `target`）、groups（:3653）、userText（:3890，按 `rule.id`）三个 registry。
- 匹配是**全匹配叠加**，不是首个胜出：`dispatchInput`（:2792-2848）遍历 `this.eventDefinitions.entries()`，**每个** `match` 非 null 的 definition 都会 publish 一次（:2806-2817、:2832-2841）。
  - 只有 `result.exclusive === true` 会"占用 target"，两条都 exclusive 冲突直接抛 `conversation Definitions "A" and "B" both claim <type> at seq N on target "T"`（:2819-2827）。
  - → 我们能**加行**，不能**顶替或删掉**已渲染行。F6 由此成立。

---

## 6. 参考插件 `dsh-message-rewind` 逐条诊断

路径：`C:\Users\i_xie_tv\.dsh\profiles\desktop\node_modules\dsh-message-rewind`

**结构**：`lib/host.js` 只有 11 行空壳（`export function apply() { /* no host-side behavior */ }`）→ **完全没有宿主侧能力**，这正是它不可能做"原地截断"的根因。全部逻辑在 `lib/client.js`（18KB）。

**流程与失败点**（`lib/client.js`）：

- `:296` `let sessionsFace = null`；`:383-384` `const slots = ctx.get('slots'); sessionsFace = ctx.get('sessions')`；`:380` `const inject = ['slots','sessions']`。
- `:298-334` `performRewind(...)`：
  - `:300` `const anchorSeq = anchorFor(user, cap)`；`:301` 为 null → `toast(t('firstMsg')); return false`
    → **首条消息无法回退的直接原因**：`anchorFor` 取"`cap.turnEnds` 中小于 `user.seq` 的最大值"，首条消息之前没有任何已完成回合，直接返回 null。
  - `:303` `const childId = await sessionsFace.fork({ sessionId, atSeq: anchorSeq, increaseTitle: true })`
  - `:304` `sessionsFace.open(childId)` → **`TypeError: sessionsFace.open is not a function`**（§3.2 已证明 ClientSessions 无 `open`），被 `:330` catch → `:331` `toast(t('forkFail') + ': ' + e.message)`
    → **失败模式**：fork 的 RPC 已经成功、子会话已落盘，但界面永不跳转 → **孤儿会话 + 用户看到"回退失败"**。
  - `:305-308` `waitFor(() => captures.get(childId)?.inputActions, 8000)`：靠 `conversation.composer.dock` 里自己的 RewindCapture 组件在"子会话被打开后"才注册，来间接判断切换完成。因为 `:304` 已抛错，这段永远等不到 → 8 秒后走 `:310-312` 剪贴板兜底（注释却写着 "session switch already happened"，与实际相反）。
  - `:314-324` `send()`：`cap2.inputActions.setDraft(editedText)` → `addImages(user.imageIds)` → `submit()`；`:328` `setTimeout(send, 220)`。
- 其它实现细节：`:100` `TURN_END_KINDS = new Set(['turn-tail','turn-error','turn-max-tokens'])`；`:102-128` 遍历 `snapshot.chat.nodes` 找 user 节点（`node.kind/key/anchorSeq/data.content`）；`:95-99` 注释提醒 compaction 行的 seq 不能当锚点。
- **DOM 补丁**：`:173` `root.querySelectorAll('[data-chat-flow-kind="user"]')` 挑选用户行，`:161` 用行上的 `data-chat-anchor-key` 取锚点；配 `MutationObserver` + `setInterval(1500)` 兜底；`openModal`（`:227-262`）用 `document.createElement` 手搓对话框（**不走 React、不用官方组件，主题样式全靠自注入 CSS**）：`:342-378` 注入依赖 `--dsw-alias-*` 变量的样式。
- `anchorFor` 定义在 `:273`，被 `:229`（`openModal` 预计算）与 `:300`（`performRewind`）调用。
- **文档错误**：`lib/client.js:12` 与 `cordis.patch.yml` 注释称 "fork cuts at the first turn/end at or after atSeq"。这与宿主实现不符 —— `atSeq` 是**精确的 inclusive cut**（`dsh-api-session-controller/lib/index.js:842-848`），不存在"向后找第一个 turn/end"的行为。它的 anchor 策略只是"够用且保守"，不是平台语义。

**结论**：参考插件是"纯客户端 + fork + 重投草稿"的实现，三处硬缺陷 ——
1. 首条消息直接放弃（anchor 策略过保守，非平台限制）；
2. 切换会话用了不存在的 API（正确是 `ctx.uiWorkspace.openSession`），导致必然的孤儿会话；
3. 依赖 DOM 选择器注入按钮（脆，且随 UI 改版失效），而不是插槽。

---

## 7. 可行性判定（三种形态，供架构师取舍）

### 形态 A：fork 回退（官方路径，推荐为默认）
- 机制：`sessions.fork({ sessionId, atSeq })` → `ctx.uiWorkspace.openSession(childId)`（可选 `inputActions.setDraft` 预填）。
- 可行范围：**任意真实 seq，含首条消息之前**（§3.1 :871 只校验存在性；§3.3 给出具体 seq）。
- 优点：官方支持、可逆（父会话不动）、`buildForkSeed` 自动补收尾事件、open turn 中间切也安全。
- 代价：父会话保留（"回退"实际是"分叉"），会话列表变长。

### 形态 B：原地截断（surface replace）
- 机制（宿主侧必需）：`const s = ctx.sessions.get(sessionId)` → `s.append('user/message', marker, { surfaceOp:{op:'replace', startSeq, endSeq}, sourceEventSeqs:[...全部被遮蔽节点] })`。
- 能做到：**模型真的忘掉**这段历史（`applySurfacePlan` 让 surface 只剩 1 个节点）。
- 硬限制：F5 模型可见 ≠ UI 可见（旧气泡照旧显示）；F6 无法隐藏行；F7 不可逆；此外 `sourceEventSeqs` 必须精确覆盖全部被遮蔽节点（漏一个抛错），跨未应答 tool call 截断会让模型看到孤立 tool-call。
- 额外风险：对**正在运行**的会话在 agent 之外 append，会与 running turn 竞争（`dsh-api-session-controller/lib/index.js` 用 `claims` map 串行化，:406-412）。此风险**尚未实测**，属未知项。

### 形态 C：A + 客户端"回退标记"装饰
- 用 A 做真实回退；用自定义 Definition（§5.6）+ `conversation.chat.node` 新键（F9 需 spike）在界面上显示"已从此处回退"。
- 这是唯一能在 UI 上"看见"回退语义的路径，但依赖 F9。

---

## 8. 未知项（禁止当结论使用，需 spike 验证）

1. **自定义 ChatNodeKind 是否可行**：`uiConversation.events.register` 以 `kind` 为键（:3356），`conversation.chat.node` 的 keyDomain 文档写的是"fixed by the owner's key table `{ [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }`"。TS 层是封闭联合，**运行时 `_register` 是否校验 keyDomain 未知**（文档只说是编译期约束）。若运行时不校验，自定义 kind 可渲染；若校验，则只能复用 19 个既有 kind —— 而既有 kind 已被官方占用（`shadows-shipped-ui`），替换 `user` 会**替换所有用户气泡**。
2. **宿主 append 与运行中 turn 的互斥**：`session.append` 是否需要先 `enter(session)` 或抢占 claim；对 live session 从插件旁路写入是否被 `validateNext` 拒绝（seq 连续性由 agent 与插件共享，`dsh-session/lib/types/surface.js:394-396`）—— 未实测。
3. **宿主写入后客户端如何刷新**：是否有 `sessions.refresh` / live 推流能让 UI 看到新事件；若无，需用户手动重开会话。—— 未查证 `refreshProjections`（`sessions/service.js`）的实际效果。
4. **`session/rewind` 这类 log-only 事件类型**是否需要在宿主注册投影/类型（surface 之外的类型是否需要注册表登记）—— 未查证。
5. **`SlotsCore._register` 对 `children` 声明缺失时的行为**（我们若 `register` 到需要被父条目声明的槽，父条目未声明时的运行期表现）—— 只知道 renderSlot 会抛 `SlotOwnershipError`。
6. **compaction 后再回退**的语义（surface 已是 1 个 checkpoint 节点时的 startSeq 定位）—— 未测试。

---

## 9. 速查：客户端插槽全表位置

100 个 slot key 的完整目录（key/kind/scope/registerOptions/ownerProps/standardProps/keyDomain/declaredBy/occupants/replaceRisk/example/source）在：
- 源码：`dsh-cordis-client-runner/lib/client.js:2434` 起的 `const CLIENT_SLOT_API = [...]`
- 已导出：`C:\Users\i_xie_tv\.dsh\.probe\slots.txt`（由 `slot-catalog.mjs` 生成，100 条，含可直接抄的 `example` 片段）

其余可复用产物：`host-types.txt`（宿主 425 条类型声明）、`client-types.txt`（客户端 152 条）。

---

## 10. 证据强度声明

- 本文件所有"行号结论"均来自 **0.2.1-rc.2 的 asar 实际内容**，非记忆、非推断。
- 标注为"官方文档原话"的英文句子是源码/README 中逐字引用。
- 第 8 节列出的 6 项**未经实测**，任何实现决策若依赖它们，必须先做最小 spike。
