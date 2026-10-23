# tests/ — 回归 harness

本目录是插件自带的回归测试，**不随包发布**（`package.json` 的 `files` 只含 `lib` 与
`cordis.patch.yml`）。它由 `.probe/x/verify/` 下的 `rewind-e2e.mjs` / `rewind-f1.mjs`
适配而来，收编进仓库，用 Node 自带的 `node:test`（无需任何依赖）。

## 跑法

```bash
npm test              # 标准：每个测试文件一个子进程（node --test 默认隔离）
npm run test:inline   # 逃生口：同进程内跑，用于禁止 spawn 的受限环境
```

> **实测限制**：`npm test` 依赖 `node --test` 的默认子进程隔离，需要 spawn。本仓库
> 开发所在的沙箱禁止 spawn（报 `spawn EPERM`），因此这里用 `test:inline`。两者
> 覆盖的测试完全相同，失败时都返回退出码 1（无"绿灯假象"）。在正常开发机上 `npm test`
> 即标准路径。

也可直接跑单个文件：

```bash
node --experimental-test-isolation=none --test tests/host.test.mjs
```

## 结构

| 文件 | 职责 |
|---|---|
| `tests/host.test.mjs` | 宿主半边：H-1 守卫、B4 反例、H-2 降级、错误文本、单飞、硬约束 |
| `tests/client.test.mjs` | 客户端半边：F1 闭区间、normalizeMark、M-3 多会话作用域、markCache 哨兵 |
| `tests/contract.test.mjs` | 跨端契约：宿主**真实产出**的 notice → 客户端解析 → DOM 隐藏结果；exports 四键形态 |
| `tests/helpers/session.mjs` | `Session` 替身，按官方 surface 投影语义重建（`turn/start` 为 log-only、replace 走 `nodes.splice`） |
| `tests/helpers/dom.mjs` | fake DOM + Module Loader 装载器，支持多容器与手动驱动 observer/interval |

## 覆盖矩阵

| 评审项 | 测试 |
|---|---|
| **H-1** 目标回合已折叠则拒绝 | `host.test.mjs` → "H-1: 对同一回合二次回退被拒绝"、"H-1: 无参 /rewind 同样拒绝"、"H-1: 回退后继续对话（B6）" |
| **H-1 第二判据** 吞"更晚切点"的旧 checkpoint 会让旧隐藏行复发（幽灵路径） | `host.test.mjs` → "H-1 幽灵路径：回退到被藏区间内部的更晚回合被拒绝"、"H-1 放行侧：同一切点重切…"、"H-1 放行侧：回退到比新回合更早…" |
| **H-1 边界（B4）** compaction checkpoint 仍可折叠 | `host.test.mjs` → "B4: 尾部只剩 compaction checkpoint 时仍允许折叠"、"B4: isRewindCheckpoint 区分…" |
| **H-2** inject 补 sessions / store 缺失降级 | `host.test.mjs` → "H-2: store 缺失时在 append 之前拒绝…"、"H-2: flush resolve false…"、"H-2: resolveStore 两条路径" |
| **M-2** 收编 harness + npm test | 本目录；`package.json` scripts |
| **M-3** visibleMaxTurn/reconcile 容器作用域 | `client.test.mjs` → "M-3: 两个会话视图同时挂载时互不干扰"、"M-3: upto= 缺失时兜底只读本会话容器" |
| **F1** 闭区间回归 | `client.test.mjs` → 4 条 "F1…" |
| **跨端 turn=/upto= 契约** | `contract.test.mjs` → 全部 6 条 "跨端…" |
| **硬约束**（append-only / 无 RPC / exports 四键 / 无 commit） | `host.test.mjs` + `contract.test.mjs` 的 "硬约束…" |

## 为什么 session 替身要重建 surface 投影

旧 harness 里 `surface.nodes = log.map(e => e.seq)`（把 `turn/start` 也算进 surface），
不足以验证 H-1：H-1 守卫的正确性取决于**折叠后** surface 长什么样。本替身按官方
`applySurfacePlan`（`dsh-session/lib/index.js:463-470`）的语义重建——
`nodes.splice(startIdx, endIdx-startIdx+1, checkpointSeq)`，且 `turn/start` 是
log-only 不进 surface。只有这样，"回退一次后再回退到同一处"才会真实退化成
"尾部只剩上一个 checkpoint"，H-1 才有可测对象；同时它也能造出 compaction checkpoint
这种"同为 replace-origin 但不是我们的 checkpoint"的反例（B4）。
