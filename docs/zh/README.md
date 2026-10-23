# dsh-session-rewind

**在当前对话里原地回退 —— 同一个会话，不 fork，不新开标签页。**

[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0-2F6BFF)](https://github.com/deepseek-dsh/dsh-desktop) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#许可证)

---

DSH 官方对「撤销最近几轮」的处理方式，要么 fork 出一个新会话，要么手动改状态文件。`dsh-session-rewind` 只做一件事：加一条 `/rewind` 命令，把**当前**对话的尾部原地折叠掉。`sessionId` 始终不变，事件日志保持追加语义，模型在下一次请求里是真的「忘了」被折叠的那几轮。

这不是 fork。磁盘上什么都没删，`.jsonl` 没有被重写，侧栏里也不会多出一个会话。

## 为什么要回退

| 场景 | 之前 | 用 dsh-session-rewind |
|---|---|---|
| 某一轮答坏了想重来 | 开新会话，丢掉全部上下文 | `/rewind 1`，之前的都留着 |
| 对话中途跑偏 | fork 后重新解释一遍 | `/rewind 3`，原地继续 |
| 太长想砍掉一段探索 | 手动裁剪 | 回合动作行里点一下 |

## 核心特性

- **原地折叠** —— `session.append('user/message', checkpoint, { surfaceOp: 'replace' })`，`sessionId` 不变。
- **日志只追加** —— 早先的每个事件保留原 seq；唯一的写入是一条 checkpoint 事件。
- **模型真忘** —— 被折叠的节点从 `deriveMessages()` 中消失，下一次请求确实看不到它们。
- **两个入口** —— `/rewind [<回合>]` 命令，以及官方 `conversation.chat.assistant-actions` 动作行里的图标按钮。
- **默认安全** —— agent 运行中直接拒绝；按会话单飞；持久化失败报 `PERSIST_FAILED` 而不是假装成功。
- **零额外运行时依赖** —— Host 半边不 import 任何东西；Client 半边只 require `react`。

## 安装

```bash
git clone https://github.com/ixietv/dsh-session-rewind.git "$HOME/.dsh/plugins/dsh-session-rewind"
```

然后重启 DeepSeek Harness。Loader 会读取 `cordis.patch.yml` 插入 Host 行；Web shell 依据 `dsh.client.platform: "web"` 加载 `lib/client.js`。

## 使用

| 入口 | 语法 | 行为 |
|---|---|---|
| 命令 | `/rewind` | 回退最近一个回合 |
| 命令 | `/rewind 3` | 回退到第 3 回合之前 |
| UI | 回合动作区图标 | hover 任意回合，点击回退到它 |

## 工作原理

```
用户: /rewind <回合>
   │
   ▼
Host (lib/host.js) ── 校验回合号、agent 空闲、无进行中的回退
   │
   ▼
定位目标 turn/start 的 seq ── 收集其到末尾的全部 surface 节点
   │
   ▼
session.append('user/message', checkpoint, { surfaceOp: 'replace', sourceEventSeqs })
   │
   ▼
ctx.sessions.flush(session) ── 持久化；失败则报 PERSIST_FAILED
   │
   ▼
Client (lib/client.js) ── 隐藏已折叠的 DOM 行，用 sessionStorage 打标记
```

## 架构

```text
dsh-session-rewind
├── lib/host.js            # Host 半边：注册 /rewind，计算切点，追加 checkpoint
├── lib/client.js          # Web 客户端半边：动作行按钮、DOM 隐藏、回退标记
├── cordis.patch.yml       # Loader patch：插入一行 Host（不 override / 不 isolate）
├── docs/design.md         # round 2 契约：语义与 DEC-1..DEC-12 决策
├── docs/research.md       # surface 原语与命令系统调研
├── docs/research-truncate.md  # 截断与 tool-pairing 语义
└── docs/verification.md   # 验证记录与验收证据
```

| 模块 | 职责 |
|---|---|
| `lib/host.js` | 拥有命令、切点，以及唯一那次 `surfaceOp: replace` 追加 |
| `lib/client.js` | 拥有触发面，以及被折叠行的视觉消失 |
| `cordis.patch.yml` | 与官方模块并列组合，而不是替换它们 |

## 设计要点

- **切点落在回合边界** —— 天然满足 tool-pairing 平衡，不需要额外打补丁。
- **checkpoint 的 source 用 `{ kind: 'user' }`** —— 它在封闭的 `MessageSourceMap` 内；由于 replace checkpoint 不属于「append surface」事件，UI 不会把它渲染成用户气泡。
- **不支持 restore / 撤销回退** —— 第二次回退只能退到更早的位置，因为被折叠的节点已经不在 surface 上了。

## 开发

```bash
node --check lib/host.js
node --check lib/client.js
```

## 常见问题

**会创建新会话吗？** 不会。整个插件的意义就是不做这件事。

**历史会被从磁盘删掉吗？** 不会。事件都在，只是派生的 surface 不再暴露它们。

**回退能撤销吗？** 不能原地撤销。被折叠的节点已经不在 surface 上。

## 许可证

MIT
