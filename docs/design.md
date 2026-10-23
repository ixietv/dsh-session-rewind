# dsh-session-rewind 设计：原对话回退（round 2 重裁）

- 状态：**已裁定（round 2，勘误 r2.1）**，取代 round 1 的 fork 语义。实现者按本文执行，不再二次决策。
- 本轮勘误（2026-10-18，据 t17 评审）：①持久化收敛 `commit` → `ctx.sessions.flush(session)`（§2.4 步 7、§3.1 步 8）；②成功文本补 `upto=<m>`（§3.1，客户端解析契约）；③隐藏判据改**闭区间** `cutTurn <= turn <= shadedUpto`（DEC-7、§2.4 步 8、§2.6 J-3、§3.2、§4.3、AC-7）；④新增未知项 S-9（§9）。
- 依赖事实文档：`docs/research.md`（下称 **R**）、`docs/research-truncate.md`（下称 **T**）。
- 证据约定：`T§4`＝research-truncate.md 第 4 节；`ui-chat/client.js:6986`＝`@deepseek-ai/dsh-client-ui-chat/lib/client.js` 第 6986 行；`slots.txt`＝`C:\Users\i_xie_tv\.dsh\.probe\slots.txt`。
- 本文不含实现代码；出现的类型/签名均为**契约**，实现必须逐字对齐名称。
- 标记约定：`[已验证]`＝源码行号已核；`[未验证]`＝推断，必须按 §9 的判据先 spike；`[用户拍板]`＝进 §10。

---

## 0. 相对 round 1 的三处翻转（先看这个）

| # | 维度 | round 1 | round 2（本文） | 原因 |
|---|---|---|---|---|
| FLIP-1 | 回退语义 | `sessions.fork()` 派生新会话 | **同会话 surface replace**（`sessionId` 不变） | 用户明确要求「不要新分支，要原对话继续」；官方确有同会话原地折叠能力（§2.3） |
| FLIP-2 | 触发面 | 3 个入口：回合尾按钮 + 输入区常驻按钮 + 选择器浮层 | **1 个入口**：回合尾动作区图标按钮（受官方 hover/CSS 控制）+ `/rewind` 命令 | 用户要求「减小触发 ui 的范围」（§4.1） |
| FLIP-3 | 宿主职责 | 零 RPC、零日志写入（纯客户端 initiator） | 宿主注册 **`/rewind` 命令**并执行折叠；客户端只负责触发与展示 | 只有宿主能拿到 `Session` 与写权限（§3.1） |

保留不变：打包形态（§6）、`running` 时禁用、回合粒度、父会话不删除、`autoResend` 默认关闭。

---

## 1. 决策表

| # | 决策 | 结论 | 依据 |
|---|---|---|---|
| DEC-1 | 回退语义 | **同会话原地折叠**：`session.append('user/message', checkpoint, {surfaceOp:{op:'replace',…}})`，`sessionId` 不变 `[已验证]` | `dsh-session/lib/index.js:1517`、`surface.js:431-454`；官方先例 `dsh-compaction-basic/lib/index.js:650-661` |
| DEC-2 | 触发通道 | 客户端 → 宿主只经**官方命令系统**：`ctx.remote.commands.execute(sessionId, line, attachments)` `[已验证]` | `dsh-client-ui-commands/lib/client.js:1717-1724`；`dsh-commands/README.md:32-46` |
| DEC-3 | 命令 | 宿主注册 `/rewind [<turn>]`，无参数＝回退最后一个回合 `[已验证]`（机制） | `dsh-command-compact/lib/index.js:80-101`（`ctx.commands.register` 模板） |
| DEC-4 | 切点 | 目标回合的 `turn/start` 事件 seq 起的**全部 surface 节点**被遮蔽；切点在回合边界，天然满足 tool-pairing 平衡 `[已验证]` | `T§4.3`；`dsh-compaction/lib/types/tool-pairing.js:83-96` |
| DEC-5 | checkpoint 消息 | `createUserMessage({ content:[说明文本], source:{kind:'user'} })` `[已验证]`（类型）/ `[未验证]`（trajectory 视图是否出现该条） | `MessageSourceMap` 为封闭 map（`typert.host.js:2567`）；`dsh-compaction-basic/lib/index.js:596-599` |
| DEC-6 | UI 触发面 | **唯一按钮**在 `conversation.chat.assistant-actions`（回合尾动作区）；另提供 `/rewind` 命令行入口 | `ui-chat/client.js:6986-7000`、`:5151`（官方 hover CSS）、`slots.txt:10-16` |
| DEC-7 | 旧消息视觉消失 | **DOM 隐藏**：对满足 **`cutTurn <= turn <= shadedUpto`** 的 flowItem（`turn` 读 `[data-chat-turn]`）设 `hidden`；**上界不可省**——无上界会把回退后继续对话产生的新回合一起藏掉（§4.3.1）；官方布局以 `:not([hidden])` 判定可见 `[已验证]`（机制）/ `[未验证]`（跨刷新持久性） | `ui-chat/client.js:3805-3813`、`:2164/:2194/:2262/:2282`；§4.3.1 |
| DEC-8 | 持久通道 | 本次会话内内存 Map + `sessionStorage`；跨页面重开依赖 §9 S-1 结论 `[未验证]` | §9 S-1 |
| DEC-9 | 运行中 | `agent` 非 idle 时命令直接拒绝；按钮在 `running` 时不渲染 | `dsh-command-compact` busy 语义（README 错误表第 1 行）、`session.js:812-836` |
| DEC-10 | 并发 | 宿主命令 handler 按 session 单飞（Set 去重），第二次拒绝并给出文本 | `dsh-command-compact/lib/index.js:82-90`（active Set 模板） |
| DEC-11 | 打包 | 与 round 1 相同（`type: module` + `main: lib/host.js` + 四 exports + `dsh.bundle.patch` + `dsh.client.platform: web`） | R§4 |
| DEC-12 | 不可逆性 | 不做 restore/undo-of-rewind；重复回退只能回退到**更早**处（surface 已不含被遮蔽节点） | `T§4.6` |

---

## 2. 回退语义：原对话继续

### 2.1 三条候选与裁定

| 方案 | 同 sessionId | 模型真忘 | 立即生效 | 需要重启 | 裁定 |
|---|---|---|---|---|---|
| A. 命令驱动的 surface replace | ✅ | ✅ | ✅ | ❌ | **主路径** |
| B. fork 新会话 | ❌ | ✅ | ✅ | ❌ | **废弃**（违反用户要求） |
| C. 停机改写 `.jsonl.zstd` | ✅ | ✅ | ❌ | ✅ | **废弃**（T§5：需独占写句柄、不可逆、跨 generation 风险） |

废弃 B 的额外理由（不只是用户偏好）：
1. `sessions.fork` 的语义固定为「派生新 Session」，宿主端点 `session/fork` 只出 `{sessionId}`（`typert.host.js` 中 `SessionForkValue`），**没有"替换原会话"的表达力**；
2. fork 后必须 `ctx.uiWorkspace.openSession(childId)` 才能切走（`ui-workspace/client.js:1470-1472`），而父会话留在侧栏成为孤儿副本 —— 这正是参考插件被用户否决的形态；
3. round 1 契约里的 `RewindRequest.mode`/`childSessionId` 等字段在 round 2 全部删除（§8）。

### 2.2 主路径的技术前提（逐条已验证）

- 折叠原语：`Session.append(type, data, ...opts)` 只接受 `surfaceOp` 与 `sourceEventSeqs`（`dsh-session/lib/index.js:1517-1538`）。
- 折叠实现：`state.nodes.splice(startIdx, endIdx - startIdx + 1, plan.seq)`，并 `replaceGeneration += 1`、`contentGeneration += 1`（`surface.js:431-454`）。
- 模型可见性：下一次请求用 `session.deriveMessages()` 构 `messages`（`dsh-agent-loop/lib/index.js:1274`、`:1283`）→ 被遮蔽节点不再出现在请求里，**同 sessionId 下模型确实"忘掉"了这段**。
- 官方先例：`compaction-basic` 用同一原语把「区间」折叠成一条 `user/message` checkpoint（`index.js:650-661`）。
- 校验：`sourceEventSeqs` 非空、无重复、必须覆盖**每一个**被遮蔽 surface 节点（`surface.js:230-263`），且 `startSeq/endSeq` 必须 < 新事件 seq（`:299-308`）、必须落在当前 `surface.nodes` 内（`:310-327`）、node 0 受保护（`:376-391`）。

### 2.3 checkpoint 消息的形状（硬约束）

`MessageSourceMap` 是**封闭 map**（`typert.host.js:2567`），成员固定为 `user | model | tool | system-prompt | model-selection | … | compact-checkpoint | …`。因此：

- **不能**发明 `source.kind = 'session-rewind'`（类型层不存在；运行时校验未验证，且没必要冒险）。
- 计划使用 `source: { kind: 'user' }` —— 它在 map 内，且 UI 不会因此渲染成用户消息：`ui-chat` 的 user definition 要求 `isAppendSurfaceEvent(event)`（`ui-chat/client.js:9844-9852`、`9475-9477`），而我们的 checkpoint 是 `surfaceOp: 'replace'`，不满足。
- 不得复用 `compact-checkpoint`：那是 compaction 的语义占位，`ui-chat` 会把它渲染成「压缩摘要」节点（`:9527-9565`），会误导用户。
- 内容固定为一行说明文本（例如「（已回退：此前 N 条历史消息已从此会话中移除。）」），让模型知道上下文有缺口而不是以为自己记错。`content` 必须是合法 `ContentBlock[]`。

> `[未验证]` trajectory 视图（`conversation.view` 的 `trajectory`）是否会把这条 replace checkpoint 显示出来 —— 见 §9 S-2，验收时人工看一眼。

### 2.4 主路径时序（端到端 9 步）

| 步 | 执行方 | 动作 | 失败后果 |
|---|---|---|---|
| 1 | 客户端 | 用户点击回合尾动作区的「回退」图标（或手敲 `/rewind <turn>`） | — |
| 2 | 客户端 | 计算目标：`cutTurn`（按钮所属回合号）；`running` 则按钮不渲染，直接 return | 无副作用 |
| 3 | 客户端 | `ctx.remote.commands.execute(sessionId, '/rewind ' + cutTurn, [])` | 抛错 → 提示「回退请求失败」并可重试 |
| 4 | 宿主 | 解析 `rawInput`；非法的 → `{kind:'error', text: USAGE}` | 日志记 `command/run` + `command/done(error)`，无日志变更 |
| 5 | 宿主 | 校验 agent idle + 单飞 + 定位 `turn/start(cutTurn)` + 计算遮蔽集合 → 不满足则返回错误文本 | 同上，会话日志不变 |
| 6 | 宿主 | `session.append('user/message', checkpoint, {surfaceOp, sourceEventSeqs})` | 抛错 → `{kind:'error', text:'…nothing changed'}`；会话不变 |
| 7 | 宿主 | `await ctx.sessions.flush(session)`（**不是** `session.commit()`：`Session.append` 内部已完成内存提交，`Session` 上没有可调用的无参 `commit`；持久化收敛的唯一入口是 store 的 `flush(session)`，§3.1 步 8） | `{kind:'error', text:'…could not be saved'}`；内存 surface 已变，需在文本里提示用户检查 |
| 8 | 客户端 | 命令 resolve 后：写 `rewindMarks.set(sessionId, {cutTurn, shadedUpto})` + `sessionStorage`，随后 DOM 隐藏 **`cutTurn <= turn <= shadedUpto`** 的行（上界依据 §4.3.1） | 隐藏失败仅影响视觉，模型侧已回退 |
| 9 | 客户端 | 可选（`autoResend`）：把该回合原 `user/message` 文本回填输入框（`inputActions.setDraft`） | 草稿失败仅影响便利性 |

> 命令的结果文本由官方 adapter 渲染（`dsh-commands/README.md:46`：handler 返回 `success|error` + UI 文本，adapter 负责显示，**不进入模型历史**）。客户端插件不需要自己画 toast。

### 2.5 失败与回滚语义

- 第 4–6 步任何失败：**会话日志零变更**，用户只看到一条错误文本，可重试。
- 第 7 步（persistence）失败：内存 surface 已折叠，但磁盘未落。**这是唯一的不一致窗口**，处理方式：返回 `error` 文本明确「已折叠但未能保存，请刷新后确认会话状态」，不尝试反向恢复（反向不可逆，T§4.6）。
- 客户端第 8 步失败：不影响语义，允许下一次渲染重试。

### 2.6 「原对话继续」的可验证判据（验收必查）

| 判据 | 期望 | 验证手法 |
|---|---|---|
| J-1 `sessionId` 是否变 | **不变**（URL/侧栏/当前会话 id 完全一致） | 回退前后各记录 `sessionId`，断言相等 |
| J-2 旧消息是否消失（模型侧） | 消失 | 回退后发「刚才我们聊了什么」，模型不应复述被回退内容；或直接看下次请求体不含被遮蔽节点 |
| J-3 旧消息是否消失（UI） | 消失（**仅 `cutTurn <= turn <= shadedUpto` 区间**；回退后新增回合必须可见） | 回退后视觉核对；F5 刷新再核对；再发一条消息确认新行可见（§4.3.1） |
| J-4 父会话/侧栏 | **不多出任何新会话** | 回退前后 `ctx.sessions.list.getSnapshot()` 会话数相等 |
| J-5 是否需刷新才生效 | **不需要**（模型侧立即生效；UI 由 DOM 隐藏立即生效） | 回退后直接继续对话 |
| J-6 会话日志 | **只增不删**：回退前所有事件 seq 与内容不变，末尾新增 1 条 `user/message`(replace) | 比对 `session.snapshotEvents()` 前缀哈希 |

J-1/J-2/J-4/J-5 是硬判据；J-3 的"刷新后仍消失"依赖 S-1（§9），若 S-1 判定不可行，J-3 降级为"同标签页内有效"并进 §10 请用户拍板。J-3 的隐藏区间是 `[cutTurn, shadedUpto]` 闭区间，跨刷新重建该区间见 S-9。

---

## 3. 职责边界与对外契约

### 3.1 宿主（`lib/host.js`）

**导出**：`export const name = 'session-rewind'`、`export const inject = ['commands']`、`export function apply(ctx)`。

**注册的命令**（`ctx.commands.register`，模板见 `dsh-command-compact/lib/index.js:92-100`）：

| 字段 | 值 |
|---|---|
| `definitionId` | `CommandDefinitionId('dsh-session-rewind')` |
| `name` | `'rewind'` |
| `description` | `'Rewind this conversation to before a turn'` |
| `input` | `{ hint: '[<turn>]' }` |
| `handler` | `(invocation) => Promise<CommandResult>` |

**handler 输入**（`invocation`，见 `dsh-commands/README.md:62` 与 `dsh-command-compact/lib/index.js:51`）：`{ agent, rawInput, signal, commandId, attachments }`。其中 `agent.session` 是宿主 `Session` 实例（`dsh-agent/lib/index.js:198`、`:514` 佐证 `agent.session` 存在）。

**语法**：`/rewind` → 回退最后一个回合；`/rewind <turn>` → 回退到回合 `<turn>` 之前（`<turn>` 为非负整数）。其余一律 `USAGE`。

**算法（按序，任一步返回错误文本）**：

1. 解析 `rawInput.trim()`；空 → `targetTurn = 'last'`；`/^\d+$/` → 数字；否则 `USAGE`。
2. `const session = invocation.agent.session`；`agent` 非 idle（有未收敛 turn / `agent.status !== 'idle'`）→ `BUSY` 文本。
3. 单飞：`active.has(session.id)` → `BUSY` 文本；否则加入并在 `finally` 移除。
4. 定位切点：遍历日志找 `type === 'turn/start' && data.turn === targetTurn` 的**第一个** seq → `turnStartSeq`；找不到 → `NO_SUCH_TURN`。`last` 取 `turn/start` 中 `data.turn` 最大的那条。
5. 计算遮蔽集合：`S = session.surface.nodes.filter(seq => seq >= turnStartSeq)`。`S` 为空 → `NOTHING_TO_REWIND`；`S` 必须**连续位于 surface 尾部**（即 `surface.nodes.indexOf(S[0]) + S.length === surface.nodes.length`，否则 `SURFACE_UNEXPECTED`）。同时算出两个派生量（供成功文本与 §4.3 的闭区间使用）：
   - `firstShadedTurn = min{ turnOf(seq) | seq ∈ S }`
   - `shadedUpto = max({ turnOf(seq) | seq ∈ S } ∪ { 回退前会话的最后一个 turn })`

   其中 `turnOf(seq)` = 日志中最后一个满足 `srcSeq <= seq` 的 `turn/start` 事件的 `data.turn`（`turn/start` 列表顺序扫描或二分即可）。正常情况下 `firstShadedTurn === targetTurn` 且 `shadedUpto === 回退前会话的最后 turn`；取并集是为了让上界**只会更大不会更小**（上界偏大只影响视觉，偏小会让旧消息重新可见）。
6. 保护：`S` 不得含 `surface.nodes[0]`（node 0 受保护，`surface.js:376-391`）→ 若包含则 `SYSTEM_PROTECTED`。
7. 写入：`const checkpointSeq = session.append('user/message', createUserMessage({ content:[{type:'text', text: notice(S.length)}], source:{kind:'user'} }), { surfaceOp:{ op:'replace', startSeq:S[0], endSeq:S[S.length-1] }, sourceEventSeqs:[...S] })`。
8. `await ctx.sessions.flush(session)`；捕获持久化异常 → `PERSIST_FAILED`。**不要**写 `session.commit()`：`append` 内部已经提交到内存日志（`dsh-session/lib/index.js:1517-1537`，其中 `this.commit(event, entry)` 是需要 `entry` 的**两参内部路径**，不是公开收尾方法），`Session` 上不存在可调用的无参 `commit()`；把已提交事件推到持久层的唯一官方入口是 `SessionStore.flush(session)`（`dsh-session/lib/index.js:1951`，注释原文 "THE flush entry point: the store owns the carrier"）。
9. 返回 `{ kind:'success', text: SUCCESS(S.length, firstShadedTurn, shadedUpto), sourceEventSeq: checkpointSeq }`；`SUCCESS(k, n, m)` 必须**逐字**生成错误表末行的文本（三个参数顺序固定：先 `k` 条数、再 `n` 下界、再 `m` 上界），不得改写拼写或插入空格。

**错误文本表（用户可见，逐字实现）**：

| 码 | 文本 |
|---|---|
| `USAGE` | `Usage: /rewind [<turn>]` |
| `BUSY` | `Rewind is unavailable while this conversation is running, or another rewind is in flight.` |
| `NO_SUCH_TURN` | `That turn is not in this conversation.` |
| `NOTHING_TO_REWIND` | `Nothing to rewind before that turn.` |
| `SURFACE_UNEXPECTED` | `The conversation history changed before it could be rewound. Nothing was changed.` |
| `SYSTEM_PROTECTED` | `The conversation cannot be rewound that far.` |
| `PERSIST_FAILED` | `The conversation was rewound in memory but could not be saved. Refresh and check the session state before retrying.` |
| 成功 | `Rewound to before turn=<n> upto=<m>: <k> messages removed from this conversation.` |

**成功文本的三个占位符（客户端解析契约）**：

| 占位符 | 取值 | 说明 |
|---|---|---|
| `turn=<n>` | `firstShadedTurn`（第 5 步派生量） | 被遮蔽的**最小**回合号 |
| `upto=<m>` | `shadedUpto`（第 5 步派生量） | 被遮蔽的**最大**回合号（正常即回退前会话的最后一个回合） |
| `<k>` | `S.length` | 被遮蔽的 surface 节点数（与 §2.3 的说明文本口径一致） |

> **格式硬约束**：`turn=`、`upto=` 与数字之间**不得有空格**（客户端按 `/\bturn=(\d+)\b/` 与 `/\bupto=(\d+)\b/` 解析）；两个标记必须同时出现、顺序固定为 `turn=` 在前、`upto=` 在后；数字为十进制非负整数，其后紧跟空格或冒号。
>
> **跨端文本契约**：这两个标记是宿主与客户端之间唯一的跨页面重建依据——客户端用它们还原**隐藏闭区间** `[cutTurn, shadedUpto]`（页面重开后日志里没有内存态，只能靠这条文本还原；只有下界会把回退后新增的回合也藏起来，见 §4.3.1）。因此拼写、`=` 两侧无空格、数字紧跟 `=` 这三条都不可随意改动；宿主侧 `lib/host.js` 的 notice 构造处与客户端 `lib/client.js` 的解析处必须同步修改。

**宿主禁止**：不新增 RPC/端点；不写除单条 replace 事件外的任何日志事件；不 fork；不触碰 `.jsonl` 文件；不注册 typert contribution（`ctx.typert.register` 的第三方可用性为 `[未验证]`，本设计不需要它）。

**启动自检**：`apply()` 中 `ctx.get('commands')` 不可用则打印 `[session-rewind] host disabled: commands service unavailable` 并跳过注册；成功则 `[session-rewind] host ready`。

### 3.2 客户端（`lib/client.js`）

**导出形态**：必须包 `window.__ModuleLoader__.load({ id: 'dsh-session-rewind', factory: (require) => {…} })`（R§4）。**inject**：`['slots', 'sessions', 'remote.commands']`（`remote.commands` 的证据：`dsh-api-session-controller/lib/client.js:4249-4257` 的 inject 列表含 `remote` 与 `remote.commands`）。

**对外服务**（`ctx.set('sessionRewind', …)` 或等价注册，供其它插件/测试调用）：

```ts
interface SessionRewindService {
  /** 当前会话的回退标记（含用户直接输入命令的情况）。闭区间 [cutTurn, shadedUpto]。 */
  marks(sessionId: SessionId): { cutTurn: number; shadedUpto: number } | undefined
  /** 主动发起一次回退（与按钮同路径）。 */
  apply(input: { sessionId: SessionId; turn: number }): Promise<RewindOutcome>
  /** 供状态栏/调试：本会话是否处于"已回退"状态。 */
  status(sessionId: SessionId): { rewound: boolean; cutTurn?: number; shadedUpto?: number }
}

type RewindOutcome =
  | { ok: true; cutTurn: number; shadedUpto: number; text: string }
  | { ok: false; code: 'BUSY' | 'RPC_FAILED' | 'REJECTED'; text: string }
```

`cutTurn`/`shadedUpto` 均从 §3.1 的成功文本解析（`/\bturn=(\d+)\b/`、`/\bupto=(\d+)\b/`）；解析失败视为该次回退的 UI 标记不可用（`REJECTED`），不影响宿主侧已完成的语义回退。

- `apply` 内部就是 `ctx.remote.commands.execute(sessionId, '/rewind ' + turn, [])`，并从 `result.value.result` 读 `{kind, text}`（`dsh-client-ui-commands/lib/client.js:1717-1724` 的返回形状）。
- **客户端不做任何 RPC 之外的写操作**：不调 `sessions.fork`、不调 `openSession`（round 1 的这两个调用全部删除）。

**客户端职责清单**：①渲染唯一入口按钮；②调用命令；③把"已回退"标记（`{cutTurn, shadedUpto}`）落到内存 + `sessionStorage`；④DOM 隐藏 **`cutTurn <= turn <= shadedUpto`** 的行（§4.3，上界理由见 §4.3.1）；⑤（可选）草稿回填。

### 3.3 取消与中断

`apply` 接受可选 `signal`，透传给 `commands.execute`（若该 remote 接受 signal 则传；`[未验证]` 见 §9 S-3）。用户关闭页面时不需要补偿逻辑（宿主命令由宿主自己收敛）。

---

## 4. UI 触发面裁定（最小化）

### 4.1 结论

| v1 入口 | v2 裁定 | 理由 |
|---|---|---|
| 回合尾按钮（`conversation.chat.turnTail`，id `session-rewind-turn`） | **删除**，改用 `conversation.chat.assistant-actions` | turnTail 是独立区块、每回合渲染且无 hover 策略；assistant-actions 渲染进官方 `MessageIconActions` 动作行，天然带官方的显隐策略（§4.2） |
| 输入区常驻「回退」按钮（`conversation.input.dock`，id `session-rewind-dock`） | **UI 删除**；组件保留为**渲染 null 的逻辑组件**（同 id），只用于草稿回填 | 触发面减半；但 `inputActions` 只能从带 `InputZone` ownerProps 的槽取得（`slots.txt:155-161`） |
| 选择器浮层（`conversation.input.overlay`，id `session-rewind-picker`） | **删除** | 与回合尾按钮的目标选择重复；overlay 槽是命令面板/对话框位置，不适合常驻（`slots.txt:184-190` 占位为 command-popup/slash-menu/feedback-dialog） |
| — | **新增** `/rewind` 命令行入口（零 UI） | 官方命令系统原生发现（slash menu），无渲染成本 |

**结果**：常驻可见控件 = 1 个 20px 图标按钮（且仅在可回退时渲染），外加官方 slash menu 里的 `/rewind`。

### 4.2 唯一按钮：`conversation.chat.assistant-actions`

**原生渲染路径**（`ui-chat/client.js:6986-7000`）：`TurnTailNodeView` 在 `closing !== null` 时渲染

```
renderSlot("conversation.chat.assistant-actions", { messageId: closing.finalNode.messageId })
```

并把结果作为 `MessageIconActions` 的 `extraActions` 传入（`:7002`）；`MessageIconActions` 把这些子元素放进动作行容器内、紧跟官方「复制」按钮、位于官方「分支」按钮之前（`:5175`、`:5209-5222`）。

**显隐由官方 CSS 决定**（`ui-chat/client.js:5151`，同一条 CSS 字符串内）：

```css
@media (hover:hover) {
  [data-actions-reveal=hover] .actions { opacity: 0; transition: opacity 80ms }
  [data-actions-reveal=hover]:hover .actions,
  [data-actions-reveal=hover]:focus-within .actions { opacity: 1 }
}
```

`data-actions-reveal` 的取值在 `:6992`：`endsWithResponse ? "always" : "hover"`，其中 `endsWithResponse` 只在该回合是**最后一个回合且以 assistant 回复收尾**时为 `true`（`:6974-6982`）。⇒ **历史回合的整个动作行（含我们的按钮）默认 `opacity: 0`，只有 hover/focus 才显现**；只有"最后一条回复"是常显。

**渲染条件（实现必须逐条照做）**：

| 条件 | 依据 |
|---|---|
| `closing !== null`（有收尾 assistant 节点） | 槽只在此时被渲染（`:6987-6996`）；`messageId === undefined` 时官方也跳过（`:6988`） |
| `running === false`（会话不在运行） | 回退在运行中不可能成功（宿主会拒绝）；用 `useChat`/`useSessionStatus` 判定 |
| 该回合存在可回退的 surface 消息 | 否则按钮点了只会得到 `NOTHING_TO_REWIND`；用 `useChat` 快照判定 |
| `useAccess('session/rewind')` 或等价能力位（`[未验证]`） | 官方对分支用了 `useAccess('session/fork')`（`:6970`）；我们没有对应能力位，**不引入权限位**，直接省略该条 |

**不要做的事**：不覆盖 `conversation.chat.node` 的 `key: 'user'`（该槽 `shadows-shipped-ui`，覆盖会顶掉官方 `UserMessageNodeView`，`ui-chat/client.js:7184-7189`）；用户消息行内没有 actions 子槽（`slots.txt` 中 `conversation.chat.user*` 仅 `conversation.chat.user.images` 一条）。

### 4.3 旧消息视觉消失：DOM 隐藏

**为什么只能这样**：`ui-chat` 的聊天行只从 append-origin 事件生成（`:9844-9852`），replace 事件不产生行、也不移除旧行（T§4.5）；Definition 只能"加行"，没有"删行/屏蔽行"的扩展点（`ui-conversation/client.js:2792-2848` 只做匹配叠加，冲突直接抛错）。

**用官方自己的隐藏语义**：每个聊天行在 `ui-chat/client.js:3805-3813` 输出

| 属性 | 值 |
|---|---|
| `data-chat-turn` | 回合号 |
| `data-chat-flow-kind` | 节点 kind（`user`/`assistant-step`/`turn-tail`…） |
| `data-chat-flow-key` / `data-chat-anchor-key` | 该行的 flow key |
| `data-turn-process-hidden` | 官方自己用属性表达"隐藏"的先例 |

官方布局与分页逻辑一律用 `[hidden]` 判定"这一行是否参与布局"（`ui-chat/client.js:2164` 的 `:not([hidden])`、`:2194`、`:2262`、`:2282`，CSS 中的 gap/margin 亦按此计算）。⇒ 给 flowItem 设 `el.hidden = true` 与官方折叠语义同构，不会破坏滚动锚定。

**算法（客户端）**：

1. 容器 = `document.querySelector('[data-chat-turn]')?.parentElement`（聊天流容器）。
2. 对每个 `[data-chat-turn]` 元素：`const t = Number(el.dataset.chatTurn); if (cutTurn <= t && t <= shadedUpto) el.hidden = true;`，并记录到 `hiddenByUs` WeakSet（解除时用）。**上界不可省**：只判 `t >= cutTurn` 会把回退后继续对话产生的新回合一起藏掉（§4.3.1）。
3. `MutationObserver({ childList: true, subtree: true })` 观察容器：新增 flowItem 同样套用规则（命令结果文本、后续渲染、**回退后新增的回合**都会触发；新回合的 `t > shadedUpto` 因此自然保持可见）。
4. 标记来源：内存 `Map<sessionId, {cutTurn, shadedUpto}>`（本次会话）+ `sessionStorage['session-rewind:'+sessionId]`（同标签页刷新存活）。会话切换/标记变化时重算并解除超出闭区间的隐藏。
5. **只在我们隐藏过的元素上写 `hidden`**，解除时只删这些；不碰官方自己隐藏的 `turn-process` 行（`data-turn-process-hidden`）。

### 4.3.1 为什么上界必须是闭区间（AC-7 的语义前提）

隐藏判据若写成「`turn >= cutTurn`」（无上界），回退完成后**立刻**就是错的：用户继续对话时，新一轮的消息同样满足 `turn >= cutTurn`，会被一并藏掉——用户会看到自己的新提问凭空消失。

新回合的编号必然大于 `shadedUpto`，依据：

- turn 号是**日志事件**，不是 surface 概念：agent loop 每开一轮就 `this.session.append("turn/start", { turn })`（`dsh-agent-loop/lib/index.js:945`），`turn` 由 `turnBoundary` 投影的 `lastTurn` 递增（`:783`：`stateOf(session, "turnBoundary")?.lastTurn ?? 0`）。
- `turnBoundary` 投影消费的是**日志**（含 log-only 事件），`surfaceOp: 'replace'` 只折叠 surface 节点（`surface.js:431-454`），既不删日志、也不回退任何计数器；`turn/start` 不在 surface 里，也不需要出现在 `sourceEventSeqs` 中。
- 因此回退后再开一轮：`lastTurn` 仍是回退前看到的最大值 → 新 turn = `lastTurn + 1 > shadedUpto`。

⇒ 判据固定为闭区间 `cutTurn <= turn <= shadedUpto`；AC-7 专列一条验收「回退后新增回合必须可见」。

**风险**：这是 DOM 层补丁（`[未验证]` 项见 §9 S-4/S-5）——官方改名属性或换容器结构会失效；失效时**退化为"旧消息仍在屏幕上"**，模型侧语义不受影响。

### 4.4 明确不做

- 不做 DOM 注入来"改文案/改按钮位置"（round 1 的 `--dsw-alias-*` 自注入删除）。
- 不做 toast/弹层（命令结果由官方 adapter 渲染）。
- 不做"回退历史列表"面板。
- 不做右键菜单、快捷键。

---

## 5. 边界情况矩阵

| # | 场景 | 行为 |
|---|---|---|
| B1 | 回退第一个回合 | 允许：`S` = 从第一个 `turn/start` 起的全部 surface 节点（node 0 系统提示受保护，`surface.js:376-391`，因此 `S` 不含它）→ 会话退化为「只有系统提示 + checkpoint 说明」。`SYSTEM_PROTECTED` 只在 `S` 意外包含 node 0 时触发 |
| B2 | 会话运行中（turn 未收敛） | 按钮不渲染；命令直接 `BUSY`。不做排队 |
| B3 | 工具调用进行中 | 同 B2（仍在同一 turn 内）。切点只在 `turn/start`，**永不切在 tool-call/result 之间**（`dsh-compaction/lib/types/tool-pairing.js:83-96` 的平衡约束因此天然满足） |
| B4 | 已被 compaction 折叠过的历史 | 不特判：`surface.nodes` 里 compaction checkpoint 节点本身就是一个普通节点，`seq >= turnStartSeq` 时随区间一起被遮蔽（与 T§4.6「与 compaction 交叠语义一致」结论相同）。**`S` 是否为空只取决于 `turnStartSeq` 与存活 surface 节点的位置关系**：只有 `turn/start` 位于**所有**存活 surface 节点之后（典型：compaction 之后刚开了新 turn、该 turn 尚无消息）时 `S` 才为空 → `NOTHING_TO_REWIND`；若目标回合早于最后一次 compaction，`turnStartSeq` 之后仍存在 compaction checkpoint 节点，`S` 非空，回退会**连同该 checkpoint 节点一并折叠**（实测行为，t13 harness 两例分别覆盖这两条路径；早先"早于 compaction 一定 `S` 空"的表述与真实 API 不符，已按实测修正） |
| B5 | 已被回退过一次，再回退到更早处 | 允许（DEC-12）：`S` = 当前 surface 中 `seq >= turnStartSeq` 的节点。**不能**回退到更晚处（节点已不在 surface） |
| B6 | 回退后又有新对话，再回退 | 允许，同上；`S` 覆盖新的 tail。隐藏区间随之扩到新 tail（`shadedUpto` 重算），而回退后新增的回合位于新的上界之外、始终可见（§4.3.1） |
| B7 | fork 出来的子会话 | 允许（它是普通 session）；fork 继承的前缀事件 `seq < inheritedEventCount` 在 child 日志里是"继承副本"，`turn/start` 可正常找到 → 行为一致 `[未验证]`（§9 S-6） |
| B8 | subagent 会话 | 允许回退该 subagent 自己的会话；不在父会话上联动 |
| B9 | 并发两次点击 | 宿主单飞拒绝第二次（`BUSY`）；客户端按钮在 in-flight 期间禁用 |
| B10 | 空会话 / 无 assistant 收尾 | 按钮不渲染（`closing === null`）；命令 `NOTHING_TO_REWIND` |
| B11 | 多客户端同时操作同一会话 | 第二个客户端会收到宿主拒绝或 surface 校验失败（`SURFACE_UNEXPECTED`），不产生半折叠 |
| B12 | 附件/图片所在回合 | 回退后附件文件仍在磁盘（内容寻址，不删除）；仅引用消失。文档需向用户说明"不回收磁盘" |

---

## 6. 打包、安装与回滚

与 round 1 相同，仅列关键约束（R§4 已实测参考插件形态）：

```json
{
  "name": "dsh-session-rewind",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "main": "lib/host.js",
  "exports": {
    ".": "./lib/host.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-client-ui-slots": "*",
    "react": "^18.2.0"
  }
}
```

- `cordis.patch.yml`：`- insert: - id: session-rewind, name: 'dsh-session-rewind'`。
- 宿主依赖 `ctx.commands` 与 `CommandDefinitionId`（`@deepseek-ai/dsh-commands/brand`）：**不写进 `peerDependencies`**（官方包由宿主运行时提供，写进去会让安装期校验去寻找它们；R§4 的参考插件也没有声明宿主侧依赖）。若安装器要求声明，再加 `@deepseek-ai/dsh-commands`。
- 构建：无编译步骤（纯 ESM JS）；闸门 `node --check lib/host.js`、`node --check lib/client.js`。
- **安装必须用户确认**：`plugin_manager(action="install_bundle")` 属于危险操作，执行前向用户说明将写入 `~/.dsh/profiles/<profile>/` 并在 patch 中插入条目，得到明确同意后再执行。
- 回滚：`plugin_manager(action="set_plugin", enabled=false, target="session-rewind")`；彻底移除用 `remove_bundle`。**无数据残留**：本插件不写配置文件、不建目录、不改历史会话。
- 已回退的会话**不可恢复**（DEC-12），卸载插件不改变这点 —— 安装说明必须写明。

---

## 7. 验收标准

| # | 判据 |
|---|---|
| AC-1 | `lib/host.js` 用 `ctx.commands.register` 注册 `name:'rewind'`，`/rewind` 出现在 slash menu |
| AC-2 | 回合尾动作区出现 1 个图标按钮，与复制/分支同一行；**历史回合默认不可见，hover 才出现**（截图/录屏证据） |
| AC-3 | 除该按钮与 `/rewind` 外，界面无其它常驻回退控件（确认 v1 的 dock 按钮、overlay 选择器已移除） |
| AC-4 | 点击按钮后：`sessionId` 不变（J-1）、侧栏会话数不变（J-4）、无需刷新（J-5） |
| AC-5 | 回退后继续对话，模型不复述被回退内容（J-2），并在下一条请求体中看不到被遮蔽节点 |
| AC-6 | 回退前日志前缀不变，末尾新增**恰好 1 条** `user/message`(replace) 事件（J-6，前缀哈希比对） |
| AC-7 | UI 上 **`cutTurn <= turn <= shadedUpto`** 的行消失（J-3）；**回退后继续对话产生的新回合（`turn > shadedUpto`）必须仍然可见**（依据 §4.3.1：`turn/start` 是 log-only 事件、编号不回退）；F5 刷新后仍消失（同标签页 `sessionStorage`）；新开标签页的行为按 S-1 结论记录 |
| AC-8 | 运行中：按钮不渲染；`/rewind` 返回 `BUSY` 文本，会话日志无变更 |
| AC-9 | 无参数 `/rewind` = 回退最后一个回合；`/rewind 0` = 回退到第一个回合之前（B1） |
| AC-10 | 非法输入 `/rewind x`、`/rewind 999` → 分别得到 `USAGE` / `NO_SUCH_TURN`，日志零变更 |
| AC-11 | 已 compaction 的历史：不特判，按 B4 表现（`turn/start` 位于所有存活 surface 节点之后 → `NOTHING_TO_REWIND`；早于 compaction 的目标则连 checkpoint 节点一并折叠） |
| AC-12 | 第二次点击（in-flight）被 `BUSY` 拒绝；两次并发点击不会产生两条 replace 事件 |
| AC-13 | `node --check` 双入口通过；`exports` 四键齐备；`dsh.client.platform === 'web'` |
| AC-14 | 卸载插件后聊天界面复原（`hidden` 标记随页面重载消失）；会话内容保持"已回退"状态 |

---

## 8. 与 round 1 实现的差异清单（implementation 直接照做）

| 文件 | 段落 | 改动性质 | 说明 |
|---|---|---|---|
| `lib/host.js` | 全文 | **重写** | 现为 11 行空壳 + 自检；改为注册 `/rewind` 命令并实现 §3.1 的 9 步算法、错误文本表、单飞 |
| `lib/client.js` | 动作执行段（原 `performRewind` 一代） | **删除** | 删除 `sessions.fork(...)`、`openSession(...)`、`waitFor(inputActions, 8000)`、剪贴板兜底、`setTimeout(220)` |
| `lib/client.js` | 入口注册段 | **删除** | 移除 `conversation.chat.turnTail`(id `session-rewind-turn`)、`conversation.input.overlay`(id `session-rewind-picker`) 两处注册 |
| `lib/client.js` | 新增段 | **新增** | `conversation.chat.assistant-actions`(id `session-rewind-rewind`) 按键组件；`conversation.input.dock` 保留但 `return null`（仅消费 `inputActions` 做草稿回填） |
| `lib/client.js` | 新增段 | **新增** | `rewindMarks`（Map + sessionStorage）、DOM 隐藏器（§4.3 五步算法）、MutationObserver 生命周期随 session effect 清理 |
| `lib/client.js` | 导出服务 | **改签名** | 删除 `plan()/apply({atSeq,messageSeq,mode,text})` 旧契约；改为 §3.2 的 `marks/apply({sessionId,turn})/status` |
| `docs/design.md` | 全文 | **重写** | 本文 |
| `docs/verification.md` | 全文 | **待补** | 现 295 行验证记录是 fork 语义的；implementation 需按 §7 AC-1..AC-14 重测重写 |
| `package.json` | `version` | 改值 | `0.1.0` → `0.2.0`；`config` 中 `increaseTitle`/`firstTurnConfirm`（fork 专用）删除，保留 `autoResend` |
| `research-truncate.md` | — | 保留 | 作为 §2/§5 的证据来源，不改 |
| `lib/host.js` | §3.1 步 8 + 成功文本 | **改值**（勘误 r2.1） | 若已按 round 2 实现：`await session.commit()` → `await ctx.sessions.flush(session)`；成功文本 `turn=<n>` → `turn=<n> upto=<m>` |
| `lib/client.js` | 成功文本解析 + 隐藏判据 | **改值**（勘误 r2.1） | 解析增加 `/\bupto=(\d+)\b/`，标记改存 `{cutTurn, shadedUpto}`，隐藏判据改闭区间（§4.3） |

**不做差异**：`cordis.patch.yml`、`exports`、`dsh.bundle.patch`、`dsh.client.platform`、peerDependencies 均不变。

> 本轮（r2.1）只改本文档，未改代码；表末两行是给 implementation 的同步项。新增未知项 S-9 登记在 §9 表末（跨刷新重建的 `{cutTurn, shadedUpto}` 两字段与旧 mark 兜底）。

---

## 9. 未知项与风险（每条附验证方法与判据）

| # | 未验证项 | 为什么重要 | 验证方法 | 判据 / 兜底 |
|---|---|---|---|---|
| S-1 | 第三方插件能否 `ctx.uiConversation.events.register(definition)` 并注册 `conversation.chat.node` 的**新 key**（当前 key 表 19 个：`slots.txt` 记录 `assistant-step/command/…/user/workflow-run`） | 决定"回退标记"能否**跨页面重开**重建（J-3 的刷新以上部分）；`keyDomain` 只是目录里的说明字符串（`dsh-cordis-client-runner/lib/client.js:2701`），运行时是否拒新 key 未知 | 写 20 行探针插件：`ctx.uiConversation.events.register({kind:'rewind-probe', …})` + `ctx.slots.register({name:'conversation.chat.node', key:'rewind-probe'}, () => null)`，装进 profile 后刷新页面看控制台 | 期望无抛错且页面不出现 JSON fallback 块。**可行** → 用 definition 匹配 `{type:'user/message', surfaceOp:'replace'}` 生成标记节点，从节点读 cutTurn 持久化；**不可行** → 只保留 sessionStorage（J-3 降级为"同标签页"），进 §10 U-A |
| S-2 | replace checkpoint 会不会在 **trajectory 视图**里出现 | 用户可能看到一条突兀的消息 | 回退后切到 trajectory 视图人工查看 | 出现则接受（内容是一行说明）；若显示为原始 JSON 则在 checkpoint 文本里保持人类可读 |
| S-3 | `remote.commands.execute` 是否接受 `signal`（能否取消） | 只影响 UI 取消体验 | 读 `dsh-commands` 客户端声明，或传 `AbortSignal` 实测 | 不接受则 `apply` 不带 signal，改为禁用按钮直到 resolve |
| S-4 | `[data-chat-turn]` 是否在所有渲染模式（含 `conversation.view` 切到 trajectory）下都在 | DOM 隐藏依赖它 | 两种视图下 `document.querySelectorAll('[data-chat-turn]').length` | 不在则隐藏失效（模型侧不受影响），记录到 verification.md |
| S-5 | React 重渲染会不会把 `hidden` 属性冲掉 | 影响隐藏稳定性 | 回退后触发一次重渲染（切换会话再切回），看隐藏是否保持 | 被冲掉 → MutationObserver 需同时观察 `attributes`（`childList:true, subtree:true, attributes:true, attributeFilter:['hidden']` 会自激，改用短周期 reconcile 或重放规则） |
| S-6 | fork 子会话的继承前缀里能否定位 `turn/start` | 决定 B7 | 在 fork 子会话里执行 `/rewind <inherited turn>` | 找不到 → `NO_SUCH_TURN`，在文档写明"fork 子会话只能回退其自有回合" |
| S-7 | `agent` idle 的判定入口（`agent.status` 还是 `agent.turn`） | 决定 B2/B3 | 读 `dsh-agent` 导出类型或用 `/compact` 的 busy 判定对照 | 以 `/compact` 的失败路径为准（它用的 `ManualCompactionError{code:'busy'}` 是唯一官方口径） |
| S-8 | `createUserMessage` 是否可从 `@deepseek-ai/dsh-session/types` 直接 import（宿主侧） | 决定 checkpoint 构造方式 | `node -e "import('@deepseek-ai/dsh-session/types').then(m=>console.log(typeof m.createUserMessage))"` | 不可 import 则按 `UserMessage` 形状手写字面量 `{role:'user', content:[…], source:{kind:'user'}}`，并用 `session.append` 的运行时校验试错 |
| S-9 | **闭区间标记的跨刷新重建**：S-1 可行时，`conversation.chat.node` definition 匹配用的 data 能否稳定携带 `{cutTurn, shadedUpto}` 两字段；以及旧版本留下的、**只有 `cutTurn` 的 mark** 如何安全降级 | 隐藏必须同时有下界与上界（§4.3.1）：只有 `cutTurn` 时无法区分"被遮蔽的旧回合"与"回退后新增的回合"，缺上界会把新对话一起藏掉；跨版本升级与跨页面重开都会走到这条路径 | ①把 definition 的匹配 data 定为 `{cutTurn, shadedUpto}` 两字段，回退成功时一并写入；②手工往 `sessionStorage['session-rewind:<id>']` 写仅含 `cutTurn` 的旧 mark 模拟升级，刷新后观察隐藏范围；③回退后立即再发一条消息，确认新行可见 | 兜底：应用/重建时若标记缺 `shadedUpto`，取**当时快照中可见的最大 turn** 作上界，并在每次新 turn 出现时重算上界（新 turn 一律视为可见）。理由：缺上界时唯一安全的假设是"屏幕上最后一行仍属于被遮蔽区间"，任何更晚出现的回合都不可能是被回退的旧内容；上界偏大只影响视觉冗余，偏小会让旧消息重新可见 |
| R-1 | DOM 属性改名（官方升级） | 视觉层失效 | 每次 DSH 升级后跑 AC-7 | 失效 = 旧消息重新可见；语义不受影响 |
| R-2 | `sourceEventSeqs` 覆盖不全导致抛错 | 命令直接失败 | 严格按 `surface.js:230-263` 用 `surface.nodes` 过滤，不用日志全量 | 失败 → `SURFACE_UNEXPECTED`，会话不变（安全失败） |
| R-3 | 与 compaction 交错时的语义 | 用户困惑 | AC-11 | 见 B4 |
| R-4 | 磁盘不回收、回退不可逆 | 用户预期 | 在命令成功文本与 README 写明 | 文案问题，不改实现 |

---

## 10. 开放问题与需要用户拍板项

| # | 问题 | 选项 | 我方建议 |
|---|---|---|---|
| U-A | **跨页面重开**后旧消息是否必须仍隐藏？（依赖 S-1） | (a) 必须（则需 S-1 可行，或另加宿主侧持久通道）；(b) 同标签页内即可，重开页面后旧消息重新可见（模型仍已回退） | 先做 S-1 spike；可行则 (a)，不可行则接受 (b) 并在 README 说明 |
| U-B | 回退后是否**自动重发**该回合原消息？ | (a) 默认不重发，仅回填草稿（当前 DEC）；(b) 默认自动重发（更像"编辑并重发"） | 保持 (a)，`autoResend` 开关留给用户 |
| U-C | checkpoint 说明文本是否让模型看到？ | (a) 写入一行说明（模型知道上下文有缺口）；(b) 写空内容（模型无感，但可能出现空消息渲染） | (a) |
| U-D | 是否允许回退到"第一个回合之前"（只剩系统提示） | (a) 允许（B1）；(b) 禁止，至少保留一轮 | (a)，但按钮在该场景仍然显示，失败才提示 |

> 以上四项都不阻塞 implementation 的主体（§3 契约已闭合）；U-A 影响 AC-7 的验收口径，U-B 影响一个 config 默认值。

---

## 11. 证据索引

| 主题 | 出处 |
|---|---|
| 折叠原语与校验 | `dsh-session/lib/index.js:1517-1538`；`dsh-session/lib/types/surface.js:230-263, 299-327, 376-391, 431-454` |
| 官方 replace 先例 | `dsh-compaction-basic/lib/index.js:596-599, 650-661`；`dsh-compaction/lib/types/tool-pairing.js:83-96` |
| 模型可见历史 | `dsh-agent-loop/lib/index.js:1274, 1283` |
| 持久化收敛入口 | `dsh-session/lib/index.js:1951`（`SessionStore.flush(session)`，"THE flush entry point"）、`:1517-1537`（`append` 内部 `this.commit(event, entry)`，两参内部路径） |
| turn 编号分配 | `dsh-agent-loop/lib/index.js:783`（`lastTurn`）、`:945`（`append("turn/start", { turn })`） |
| 命令注册/分发 | `dsh-commands/README.md:32-46, 62-66`；`dsh-command-compact/lib/index.js:80-101` |
| 客户端提交命令 | `dsh-client-ui-commands/lib/client.js:1717-1724` |
| 客户端 remote 服务 | `dsh-api-session-controller/lib/client.js:4249-4257` |
| assistant-actions 渲染位置 | `dsh-client-ui-chat/lib/client.js:6986-7002`、`5175-5222` |
| hover 显隐 CSS | `dsh-client-ui-chat/lib/client.js:5151`、`6992` |
| 聊天行 DOM 属性 | `dsh-client-ui-chat/lib/client.js:3805-3813` |
| `[hidden]` 可见性语义 | `dsh-client-ui-chat/lib/client.js:2164, 2194, 2262, 2282` |
| replace 事件不生成行 | `dsh-client-ui-chat/lib/client.js:9475-9477, 9844-9852` |
| 插槽目录 | `slots.txt`（`conversation.chat.assistant-actions`、`conversation.input.dock`、`conversation.input.overlay`） |
| MessageSourceMap 封闭性 | `dsh-api-session-controller/lib/typert.host.js:2567` |
| fork 语义（已废弃） | `dsh-api-session-controller/lib/types/client/sessions/service.js:339-359`；R§3 |
| 无截断原语 | T§2、T§5 |
