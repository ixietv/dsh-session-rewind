# dsh-session-rewind — 构建与可安装性验证报告（r4 为准；§1–§10 = r2，§11 = r3 历史）

> **当前有效裁决 = §12（r4，task `t22`）**，绑定 t19（宿主 `upto=` + 4 个 low 修复）+ t20（客户端闭区间 F1 修复）+ t21（design 勘误）之后的字节。
> §11 是 r3（task `t16`）裁决，绑定 t13/t14/t15 字节；§1–§10 是 r2（task `t10`）fork 形态字节的历史记录。两份都**不再覆盖当前实现**，保留仅供追溯（r3→r4 差异见 §12.7）。

- 验证者：verifier（team `rewind-plugin-squad`；r2 = `t10` attempt `db9acd2e-…`；r3 = `t16` attempt `a9f8899d-…`；r4 = `t22` attempt `727450a0-8239-4caa-9fcc-373d54986706`）
- 验证对象：`C:\Users\i_xie_tv\.dsh\plugins\dsh-session-rewind`
- 验证时间：r2 = 2026-10-18 22:5x；r3 = 23:4x；r4 = 2026-10-18 23:5x（Asia/Shanghai）
- 轮次：**r4（当前）**。r2 顶替 r1（`t6`），r3 顶替 r2，r4 顶替 r3。
- 验证边界：**只读验证**。未改实现代码，未改 `package.json` / `cordis.patch.yml` / `docs/design.md`，未改 profile，**未执行安装**。新增资产只落在 `.probe/x/verify`（非交付物）。
- 结论（r4）：**PASS**。`node --check` 双入口 exit 0；清单 10/10；双端 harness **15/15**；**F1 回归独立复现 harness 13/13**（fake DOM 驱动 observer 与 1s 兜底两条路径）；`normalizeMark` 四类非法上界全部收敛为「只隐藏切点」；无 r1 残留、仅 `require('react')`、`autoResend` 零命中。未发现新缺陷；2 条 non-blocking 观察见 §12.8。

---

## 1. 字节绑定（本次裁决覆盖的文件）

| 文件 | 大小 / 行数 | sha256（本次 = 当前盘上字节） | r1(t6) 记录 | 变化 |
|---|---|---|---|---|
| `lib/host.js` | 18903 B / 480 行 | `4accfb43f9284fe02b3b4e0a1c5927de25c0ef18cf886b82e782b201a6ac5f02` | `4d6419e6…aed41d` | **t8 改写** |
| `lib/client.js` | 62180 B / 1379 行 | `c03ea562efb03ac95a7a3d53f9c14083d4665b28582ec5148afeecc64836ca9e` | `4561e4b4…95ffb882` | **t8 改写** |
| `package.json` | 659 B | `54cfe5350a250324fa0a8cde782dbb56ed353e6adc874ea88ede8ceb10bc1423` | 同 | 未变 |
| `cordis.patch.yml` | 424 B | `53a4e5db30de76360c8c34829cf9eaa2b7c07f6b61207c92ec5ff816d00df617` | 同 | 未变 |
| `docs/design.md` | 443 行 | `70bc12d4d22ee882abc79682d774ee2677071c03e7c7d20983d3a612d80fdb1b` | `79ba213f…7c8ec9` | **t8 改文档** |
| `docs/verification.md` | 本文件 | 见文末复算命令 | `8619d7d1…` | 本轮重写 |

**与 r1 的差异只来自 t8 repair**（评审 F1「客户端零 primitives」+ design/claimsEndpoint/config/onCreated/computeTargets 修订 + 未在清单内的 `ctx.logger` 访问器缺陷修复）。清单与补丁两个文件在 r1→r2 之间**逐字节未变**（hash 相同），但仍按“当前字节”重跑全部契约检查（§3 V-4），不沿用旧结论。

复算命令（任何评审可独立重放）：

```bash
cd C:/Users/i_xie_tv/.dsh
sha256sum plugins/dsh-session-rewind/package.json plugins/dsh-session-rewind/cordis.patch.yml \
          plugins/dsh-session-rewind/lib/host.js plugins/dsh-session-rewind/lib/client.js \
          plugins/dsh-session-rewind/docs/design.md
```

## 2. 验证环境

| 项 | 值 | 取证方式 |
|---|---|---|
| OS | Windows | 会话环境 |
| Node | `v24.18.0` | `node -v` |
| DSH runtime | `0.2.1-rc.2` | `app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json` 的 `version`（`getDshRuntimeVersion()` 读它） |
| Cordis | `4.0.5` | `app.asar/dsh/node_modules/@deepseek-ai/cordis/package.json` |
| Shell React | `18.3.1` | `@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js` 唯一版本字面量 `version:"18.3.1"` → 满足 peer `^18.2.0` |
| 目标 profile | `desktop`（`dsh.profile.bundles` 26 项，**无** `dsh-session-rewind`） | 只读读取 `profiles/desktop/package.json` |

---

## 3. 验证项与原始证据

### V-1 链路契约命令（`Verify` 两条）

```
$ ( cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js )
[exit code: 0]

$ test -f plugins/dsh-session-rewind/package.json && test -f plugins/dsh-session-rewind/cordis.patch.yml && test -f plugins/dsh-session-rewind/docs/design.md
[exit code: 0]
```

> 安装性备注：两条必须**分开**执行。写在同一 shell 链里时 `cd plugins/dsh-session-rewind` 之后的相对路径 `plugins/...` 会失效，得到 exit 1 —— 那是路径问题，不是文件缺失（r1 已实测，r2 复现）。

### V-2 `node --check` 双入口

```
$ cd plugins/dsh-session-rewind
$ node --check lib/host.js
host.js exit=0
$ node --check lib/client.js
client.js exit=0
```

结论：**通过**。宿主是 ESM（命名导出），客户端是经典脚本（仅 `window.__ModuleLoader__.load(...)`，无 ESM 语法），`"type": "module"` 下两者均按预期解析。

### V-3 宿主入口加载形状（`import()` + 导出面）

```
$ node -e "import('./plugins/dsh-session-rewind/lib/host.js').then(m=>console.log('apply='+typeof m.apply,'inspectCapability='+typeof m.inspectCapability,'codes='+Object.keys(m.REWIND_ERROR_CODES).length))"
apply=function inspectCapability=function codes=9
```

导出面（排序后）：`CONFIG_KEYS, DEFAULT_CONFIG, FORK_ENDPOINT, HOST_SERVICE_NAME, REWIND_ERROR_CODES, RewindError, apply, createHostService, inspectCapability, mapForkError, normalizeConfig, remoteErrorLike, remoteMethodNames`。

**关于 `name` / `inject` 模块级导出（任务描述与实现的事实差异，如实记录）**：当前 `lib/host.js` **没有** 模块级 `export const name` / `export const inject`；它通过 `apply` 内的 `ctx.inject(['sessionController'], …)`（`lib/host.js:480-482`）声明依赖，服务依赖在 Cordis 4.0.5 里同样由 fiber 的 `inject` 集合登记（`cordis/lib/index.js:744, 1099, 1320`）。这符合 Cordis 插件契约（模块只需 `apply`，`inject`/`name` 为可选元数据；Loader 行的 `name:` 提供显示名），也已由 §3 V-5 的 `ctx.inject` 断言直接证实。故不是缺陷，但**任务期望的 “host.js 仍导出 apply/name/inject” 与现状不符**，报告按实测记，不做美化。

### V-4 清单与补丁契约（当前字节，10/10）

脚本：`.probe/x/verify/checks-manifest.mjs`（只读，非交付物）

```
PASS  manifest: identity and module type
      dsh-session-rewind@0.1.0 type=module private=true
PASS  manifest: main and exports are self-consistent and point at real files
      exports={".":"./lib/host.js","./client":"./lib/client.js","./cordis.patch.yml":"./cordis.patch.yml","./package.json":"./package.json"}
PASS  manifest: dsh.bundle.patch and dsh.client.platform satisfy the loaders
      dsh={"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"}}
PASS  manifest: files field ships the host, the client bundle and the patch
      ["lib","cordis.patch.yml"]
PASS  manifest: peerDependencies match design §6.1 and gate no DSH runtime requirement
      peers={"@deepseek-ai/cordis":"*","@deepseek-ai/dsh-client-ui-slots":"*","react":"^18.2.0"} runtime=0.2.1-rc.2 unmet={}
PASS  patch: one insert row whose id/name bind the package
      id=session-rewind name=dsh-session-rewind bytes=424
PASS  patch: entry binding covers both halves (bare package name row)
      single bare-name row (host half) + dsh.client (browser half)
PASS  client bundle: module id equals the package name (factory key)
      id=dsh-session-rewind
PASS  client bundle: no ESM syntax and no imports beyond declared clients
      requires=["react"]
PASS  host bundle: zero third-party imports (design §4.5-1)
      bytes=18903 peers untouched

10/10 checks passed
[exit code: 0]
```

**peers 与 `require` 的一致性（任务重点 2）**：peers 保持三件不变（`@deepseek-ai/cordis:"*"`、`@deepseek-ai/dsh-client-ui-slots:"*"`、`react:"^18.2.0"`）。实际 `require` 只有 `react`，满足 `require ⊆ peers`；另两项是**版本契约声明**（代码经注入的 `ctx` 使用 `ctx.slots` / `ctx.reflect.provide`，不在运行时 require），`docs/design.md:321` 已明确写出这一点，与实现一致。

**判定依据（运行安装内源码）**：
- `exports["./client"]` 必须是字符串或 `{default:string}`，否则 `client-modules: <pkg> exports["./client"] must be a string or an object with a string default`（`@deepseek-ai/dsh-client-modules/lib/index.js:171-182`）；声明了 `dsh.client` 却无该键 → `declares dsh.client but exports no "./client" bundle`；有键但文件不存在 → `MissingClientBundleError: client bundle not found; run \`pnpm run build\` before launch`（`:828-839`）。本插件文件真实存在 ⇒ **手写 JS 无需构建步骤即被投递**（与 design §6.4「无构建步骤」一致）。
- 兼容闸门只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 形态的 peer（`@deepseek-ai/dsh-app-boot/lib/index.js:279-298`，`semver.satisfies(runtime, range, {includePrerelease:true})`，`workspace:^|~|*` 视为当前 runtime）→ `unmet={}`，安装前的 DSH 版本检查不会拒。
- `cordis.patch.yml` 形态与本机已安装且正常工作的 `dsh-message-rewind`、`plugins/dsh-our-free-model` 完全同构（`- insert: - id: <slug>` + `name: '<包名>'`），无 `override` / `disabled` / `isolate`。

### V-5 加载自检（宿主 7 + 客户端 7，14/14）

脚本：`.probe/x/verify/load-sim.mjs`（只读；本轮按 r2 字节更新用例）

```
PASS  host: exports apply as a function
      exported names: CONFIG_KEYS, DEFAULT_CONFIG, FORK_ENDPOINT, HOST_SERVICE_NAME, REWIND_ERROR_CODES, RewindError, apply, createHostService, inspectCapability, mapForkError, normalizeConfig, remoteErrorLike, remoteMethodNames
PASS  host: apply registers sessionRewindHost and logs readiness
      status={"enabled":true,"reasonCode":"enabled","config":{"autoResend":false,"increaseTitle":true,"firstTurnConfirm":true},"endpoint":"session/fork"} logs=["info:[session-rewind] host ready"]
PASS  host: rewind() delegates to sessionController.fork only
      fork({"sessionId":"parent-1","atSeq":12}) -> {"childSessionId":"child-1","cutSeq":12,"parentSessionId":"parent-1"}
PASS  host: atSeq=0 (first-message rewind) is accepted
      fork({"sessionId":"p","atSeq":0})
PASS  host: disabled without sessionController, no RPC attempted
      status.reason="the sessionController service is not mounted" code=REWIND_DISABLED
PASS  host: fork failure maps to REWIND_FORK_FAILED keeping cause
      code=REWIND_FORK_FAILED cause=session not found
PASS  host: sessionController dependency declared through ctx.inject (not module metadata)
      module-level inject=absent (uses ctx.inject) name=absent
PASS  client: bundle registers exactly one Module Loader factory with the package id
      id=dsh-session-rewind load-calls=1
PASS  client: factory resolves with only seed-word peers (module purity)
      inject=["slots","sessions","uiWorkspace","uiConversation","locale"] requires=["react"]
PASS  client: exports.inject matches design §4.1 service set
      ["slots","sessions","uiWorkspace","uiConversation","locale"]
PASS  client: apply() occupies the four declared list slots
      slots=conversation.chat.turnTail,conversation.input.dock,conversation.input.overlay,shell.overlay effects=4 provided=sessionRewind
PASS  client: missing uiWorkspace degrades without throwing and registers nothing
      registrations=0 effects=3
PASS  client: zero Harness Client package dependency (r2 F1: primitives removed)
      requires=["react"] toast=dshrw-toast registrations=4
PASS  client: load-time (top-level) side effects are limited to the registration call
      styles=0 timers=0 listeners=0 (no apply() called)

14/14 checks passed
[exit code: 0]
```

**任务重点 4（`client.js` 无顶层副作用）**：以空 `document` / 计数 `setTimeout` / 计数 `addEventListener` 的沙箱**只执行 bundle、不调用 `apply`**，结果 `styles=0 timers=0 listeners=0` —— 顶层唯一效果就是那次 `__ModuleLoader__.load({id, factory})` 注册；样式注入（`ensureStyle`）、locale 字典、四槽注册、`reflect.provide` 全部发生在 `apply` 内。

**零 primitives 依赖（F1 落地证据）**：`lib/client.js` 里 `require(` 仅 1 处、参数为 `'react'`；去掉注释后的可执行代码中不再出现 `primitives` 字样；`dshrw-toast`（插件自带样式类）存在，`apply` 在 4 槽全部注册。注释里提到 primitives 的两行（`:17`、`:1105`）是**说明文字**，不产生依赖。

**可信度分级**

| 检查 | 手段 | 可信度 |
|---|---|---|
| 宿主 `apply` 生命周期、服务注册、`rewind()` 转发与错误映射 | 真实 `import()` 产物 + 仿 Cordis ctx（`provide/inject/effect/get/logger`），语义对齐 `cordis/lib/index.js:800, 1782` | **高**（t5 另有真实 Cordis 4.0.5 生命周期 9 例） |
| `fork` 返回 `{sessionId}` 取值 | 逐行对齐官方 handler `@deepseek-ai/dsh-api-session-controller/lib/index.js:910` `return { sessionId: childId }` | **高** |
| 客户端 bundle 解析、exports、四槽、降级、加载期零副作用 | `vm.runInNewContext` 真实执行 `lib/client.js` + 按运行中 shell 的 seed 表（`function SZ()`）实现 `require`（非 seed 词会抛） | **中高**（Loader 契约逐行核对，未跑真实 Loader） |

### V-6 构建步骤结论

design §6.4（`docs/design.md:339-342`）已改为「无构建步骤：手写 ESM / Module-Loader 源文件即产物，无 `src/`、无 `tsc`/bundler，语法闸门 `node --check`」。与实体一致：目录内无 `src/`、无构建脚本、无 `node_modules`。V-4 的 `exports["./client"]` 契约证明客户端 bundle 由 `dsh-client-modules` **直接读盘**投递，不需要“构建后再启动”。结论：**通过**，r1 的 D-1 已关闭。

---

## 4. 判定汇总（r2）

| # | 验证项 | 结论 |
|---|---|---|
| V-1 | 契约 `Verify` 两条命令 | PASS（exit 0 ×2） |
| V-2 | `node --check` 双入口 | PASS（exit 0 ×2） |
| V-3 | 宿主 `import()` + `apply` 为 function + 9 错误码 | PASS |
| V-4 | exports 四键 / dsh.bundle.patch / dsh.client.platform=web / peers 与 require 一致 | PASS（10/10） |
| V-5 | 加载自检（宿主 7 + 客户端 7） | PASS（14/14） |
| V-6 | 无构建步骤与 design §6.4 一致 | PASS |

## 5. 未验证项与原因（r2）

| # | 未验证项 | 原因 |
|---|---|---|
| U-1 | 真实 `pnpm add` / `dsh plugin add`、profile 依赖解析、Loader 按包名 `import` | 属**部署动作**，需用户显式确认；本任务禁止（`Out of scope: profile`）。步骤见 §7 |
| U-2 | 真实浏览器：Module Loader 启动、四槽渲染、点击回退、`openSession` 跳转、草稿投递 | 无浏览器自动化环境，且不得启动替代服务；属人工验收（design §7 AC-1…AC-11） |
| U-3 | 真实 Cordis Loader 挂载宿主半身 | `@deepseek-ai/cordis` 只存在于 `app.asar` 内，Node 无法直接 `import`；已用等价 ctx 仿真覆盖（V-5），t5 另有真实 Cordis 4.0.5 生命周期 9 例 |
| U-4 | 自建 toast（`.dshrw-toast`）在真实 shell 中的视觉与层级 | 仅能静态断言「类存在 + 4 槽注册 + 无 primitives 依赖」；渲染需浏览器 |
| U-5 | HMR 热更路径（`pnpm run dev:web`） | 未在源码 checkout 内运行 watcher；不影响安装形态 |
| U-6 | 该 desktop composition 下 `sessionController` 是否 mounted | 依赖运行时 composition；缺失时宿主自检打 `[session-rewind] host disabled: <reason>` 并拒绝 RPC（V-5 已证），不崩 |

## 6. 缺陷与观察清单（r2）

**r1 的 4 条缺陷在 r2 均已关闭**（t8 落地）：

| r1 编号 | 现状 | 证据 |
|---|---|---|
| D-1 构建步骤声明与产物不符 | **已关闭** | design §6.4 重写为「无构建步骤」（`docs/design.md:339-342`），与实体一致（V-6） |
| D-2 声明 slots 却 require primitives | **已关闭** | `lib/client.js` 现只 `require('react')`；peers 三件不变，`require ⊆ peers`（V-4/V-5），design `:321` 说明另两件是版本契约 |
| D-3 违反官方 practices.md:36（require Harness Client 包） | **已关闭** | 该 require 已删除，可执行代码零 primitives 引用（V-5） |
| D-4 `package.json` 的 `config` 运行时惰性 | **已关闭** | design `:311-319` 明确「宿主保留、v1 客户端无读取通道、行为固定」，与 `normalizeConfig()` 及 `sessionRewindHost.status().config` 一致 |

**r2 遗留观察（均为 low / info，非缺陷，不阻断安装，供发布说明取舍）**：

- **O-1（low，可选清理）**：`peerDependencies` 中的 `@deepseek-ai/dsh-client-ui-slots` 不会被 `require`（只经注入的 `ctx.slots` 使用）。design 已定性为版本契约，且与已安装参考插件同形；若追求最小化可删，但**删除会改变清单 hash 与已验收契约文本**，本轮按指令保持三件不动。
- **O-2（low，文档措辞）**：`lib/client.js:17` 与 `:1105` 的注释仍提到 `@deepseek-ai/dsh-client-ui-primitives`（说明“不依赖”它），属历史说明文字，不影响加载；若担心静态扫描误报可改写措辞。
- **O-3（info）**：任务描述期望的 `host.js` 模块级 `name`/`inject` 导出并不存在（见 V-3）。当前写法符合 Cordis 契约并通过自检；若后续要求“模块级声明依赖”，需在 `apply` 之外补 `export const inject = ['sessionController']`，届时重跑本报告。

## 7. 安装步骤（**需用户显式确认，本次未执行**）

> 安装会改变整个 `desktop` profile 的插件集（影响该 profile 的所有会话），需 `danger-full-access`。插件本身不写会话日志、不改 profile 的 `cordis.patch.yml`。

1. 确认未安装：`plugin_manager(action="list_bundles")` / `list_plugins`，结果中应无 `dsh-session-rewind`。
2. 安装（任选其一，本地路径形态）：
   - 工具：`plugin_manager(action="install_bundle", target="link:C:/Users/i_xie_tv/.dsh/plugins/dsh-session-rewind")`
   - UI：插件页 →「添加插件」→ 填绝对路径 `C:\Users\i_xie_tv\.dsh\plugins\dsh-session-rewind` →「安装」
   - CLI：`dsh plugin add C:/Users/i_xie_tv/.dsh/plugins/dsh-session-rewind`
3. 期望落地：`profiles/desktop/package.json` 的 `dependencies` 出现 `"dsh-session-rewind": "link:C:/Users/i_xie_tv/.dsh/plugins/dsh-session-rewind"`，`dsh.profile.bundles` 追加 `"dsh-session-rewind"`。
4. 生效：无 HMR 时工具返回 `restart-required`（`restartReason:"no-hmr"`）→ 重启 DSH 桌面端，再刷新 Web GUI `http://127.0.0.1:53859`。
5. 安装后自证：宿主日志出现 `[session-rewind] host ready`（若为 `host disabled: <reason>` 按 design §4.5 排查）；UI 出现 turnTail「回退到此回合之前」与输入区「回退」按钮；再按 design §7 AC-1/AC-2/AC-11 各跑一次。

## 8. 卸载 / 回滚步骤（同样需用户确认）

1. 首选：`plugin_manager(action="remove_bundle", target="dsh-session-rewind")`；或 UI 插件页「卸载」；临时关闭用 `plugin_manager(action="set_plugin", target="session-rewind", enabled=false)`。
2. 刷新页面 → 四个 UI 条目消失，既有会话不受影响。
3. 数据面**无残留**：不写会话事件、不建索引、不改父会话；回退产生的子会话是普通官方会话（可正常打开/删除）；`profiles/desktop/cordis.patch.yml` 未被本插件改动，回滚无需编辑它。
4. 彻底清除：确认 `profiles/desktop/package.json` 已无 `dsh-session-rewind` 依赖与 bundles 条目后，删除插件目录。

## 9. 复现命令与 r1 历史

```bash
# 契约两条（必须分开执行）
cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js
test -f plugins/dsh-session-rewind/package.json \
  && test -f plugins/dsh-session-rewind/cordis.patch.yml \
  && test -f plugins/dsh-session-rewind/docs/design.md

# 清单 / 补丁契约（10 项）
cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node checks-manifest.mjs

# 加载自检（14 项）
cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node load-sim.mjs

# 字节指纹
cd C:/Users/i_xie_tv/.dsh && sha256sum plugins/dsh-session-rewind/package.json \
  plugins/dsh-session-rewind/cordis.patch.yml plugins/dsh-session-rewind/lib/host.js \
  plugins/dsh-session-rewind/lib/client.js plugins/dsh-session-rewind/docs/design.md
```

两个 `.mjs` 是只读验证脚手架（不属交付物、不被安装、不改 profile），位于 `.probe/x/verify`。

**r1（t6）历史**：r1 在旧字节（`lib/host.js` `4d6419e6…`、`lib/client.js` `4561e4b4…`、`docs/design.md` `79ba213f…`）上同样 `node --check` exit 0、清单契约 10/10、加载自检 12/12，并给出 4 条 low 缺陷（D-1…D-4，已于 r2 关闭）。该裁决**不覆盖 t8 之后的字节**，由本报告顶替。

---

## 10. 断言变更记录（“primitives 假阳性”溯源，r2 后补）

t9 评审复跑加载自检时见到 `12/13` 且失败项为「bundle still references primitives」。**这是验证脚手架的假阳性，不是当前字节的问题**，事实如下：

1. **成因**：r1 版本的断言对 `lib/client.js` **全文**扫 `/\bprimitives\b/`。而 t8 修复后该文件 `:17-18` 与 `:1105` 保留了说明性注释（“本文件同样不 require `@deepseek-ai/dsh-client-ui-primitives`…／不依赖官方 primitives 包”）。注释命中 → 断言失败，与可执行代码无关。
2. **修复（已在我的 r2 运行前落地，`load-sim.mjs` mtime 22:53）**：断言改为两条互补判据，都不再做全文扫描：
   ```js
   // 1) require 列表（只在 require( … ) 调用上下文内取 specifier）
   const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
   assert(requires.length === 1 && requires[0] === 'react', `requires=${JSON.stringify(requires)}`);
   // 2) primitives 只扫可执行代码（剥离 /* */ 与行首 // 注释）
   const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
   assert(!code.includes('@deepseek-ai/dsh-client-ui-primitives'), 'executable code still references the primitives specifier (comments excluded)');
   assert(!/\bprimitives\b/.test(code), 'executable code still touches primitives (comments excluded)');
   ```
3. **当前复跑结果（14/14，exit 0）**：
   ```
   PASS  client: zero Harness Client package dependency (r2 F1: primitives removed)
         requires=["react"] toast=dshrw-toast registrations=4

   14/14 checks passed
   [exit code: 0]
   ```
4. **对照实验（证明判据真的在区分注释与代码）**：
   ```
   require hits: ["react"]
   primitives in full source: true        ← 仅注释命中
   primitives in executable code: false   ← 可执行代码干净
   ```
5. **结论**：真实要求「`client.js` 的 require 列表只剩 `react`」**已满足并通过断言**；全文里出现 `primitives` 字样仅来自注释，不构成依赖。§3 V-5 与 §6 的 PASS 结论因此不变，**不撤回**。若其它评审仍见 `12/13`，请确认所用脚本是 `.probe/x/verify/load-sim.mjs` 最新版本（含上述 4 行注释剥离逻辑），磁盘上不存在第二份旧副本。

> 该文件 `docs/verification.md` 本轮补写后 hash 会变化，以 §1 的复算命令重取为准备份；被验证的实现文件（`lib/host.js` `4accfb43…`、`lib/client.js` `c03ea562…`、`package.json`、`cordis.patch.yml`、`docs/design.md` `70bc12d4…`）在 r2 裁决后**未再改动**。

---

# r3 复验（task `t16`，绑定 t13/t14/t15 之后的当前字节）

## 11. r3 —— 双端验证：构建 + 跨端 `turn=` 契约 + 无 fork 残留

### 11.1 字节绑定（r3 裁决覆盖的文件）

| 文件 | 大小 / 行数 | sha256（当前盘上字节） | 与 r2 基线对比 |
|---|---|---|---|
| `lib/host.js` | 19411 B / 521 行 | `89df1df98d9c83d1277a6838788ebab2383808dcef26b8426fa26ef991b8bb20` | **t13 整体重写**（r2: `4accfb43…`） |
| `lib/client.js` | 34877 B / 870 行 | `136bbd6dfcbd8746640b502b49ed2513e6895061355c019b10ca7c791531d2d8` | **t14 整体重写**（r2: `c03ea562…`） |
| `docs/design.md` | 421 行 | `8f683a4f1854042b5a6d53dd15b48c1bd981611838ae7dd0bcb2eaf237918bec` | **t12 重裁 + t15 修订**（r2: `70bc12d4…`） |
| `package.json` | 602 B | `8135cea0d50fd4c6d45901754a083f2b8bf3665e19fa5d54f549335f31ae8881` | version `0.1.0`→`0.2.0`，`config` 删 `increaseTitle`/`firstTurnConfirm` 留 `autoResend`（design:364） |
| `cordis.patch.yml` | 424 B | `53a4e5db30de76360c8c34829cf9eaa2b7c07f6b61207c92ec5ff816d00df617` | **逐字节未变**（三版一致） |

形态翻转（r2 → r3）：**fork 新会话 + 三入口 picker** → **同会话 surface replace + `/rewind` 命令 + 单按钮 + DOM 隐藏器**。因此 §3/§5 中所有 fork 相关断言在 r3 已不适用（见 11.6）。

### 11.2 构建与清单（契约两条 + checks-manifest）

```
$ ( cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js ); echo "exit=$?"
exit=0

$ ( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node checks-manifest.mjs )
PASS  manifest: identity and module type            dsh-session-rewind@0.2.0 type=module private=true
PASS  manifest: main and exports are self-consistent and point at real files
      exports={".":"./lib/host.js","./client":"./lib/client.js","./cordis.patch.yml":"./cordis.patch.yml","./package.json":"./package.json"}
PASS  manifest: dsh.bundle.patch and dsh.client.platform satisfy the loaders
      dsh={"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"}}
PASS  manifest: files field ships the host, the client bundle and the patch   ["lib","cordis.patch.yml"]
PASS  manifest: peerDependencies match design §6.1 and gate no DSH runtime requirement
      peers={"@deepseek-ai/cordis":"*","@deepseek-ai/dsh-client-ui-slots":"*","react":"^18.2.0"} runtime=0.2.1-rc.2 unmet={}
PASS  patch: one insert row whose id/name bind the package      id=session-rewind name=dsh-session-rewind bytes=424
PASS  patch: entry binding covers both halves (bare package name row)
PASS  client bundle: module id equals the package name (factory key)          id=dsh-session-rewind
PASS  client bundle: no ESM syntax and no imports beyond declared clients     requires=["react"]
PASS  host bundle: zero third-party imports (design §4.5-1)                   bytes=19411

10/10 checks passed
[exit code: 0]
```

`require ⊆ peers`：实际只 `require('react')`；`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-client-ui-slots` 是**版本契约声明**（代码经注入的 `ctx` 使用 `ctx.commands` / `ctx.slots`，不在运行时 require），design 已明写。

### 11.3 跨端 `turn=<n>` 契约（本轮核心，脚本实证）

两端字面量（逐字取自当前字节）：

- 宿主 `lib/host.js:337`（notice 构造）：`` `Rewound to before turn=${boundary.turn}: ${removed} message(s) removed from this conversation.` `` → 输出形如 `Rewound to before turn=1: 3 messages removed from this conversation.`，**`=` 两侧无空格、数字紧跟 `=`**。
- 客户端 `lib/client.js:679`（`checkpointTurn`）：`const m = /\bturn=(\d+)\b/.exec(text);` → 从同一段文本解析 `cutTurn`。

**不是自述**：harness 让宿主真的走完 `apply → commands.register → handler → session.append`，把 append 的 `{type, data, surfaceOp}` 组装成 wire 形态事件，再交给客户端 `checkpointTurn` 解析（`rewind-e2e.mjs` 中 `cross-half` 两项）：

```
PASS  host: /rewind 1 folds turn 1 tail and emits turn=<n> notice
      text="Rewound to before turn=1: 3 messages removed from this conversation."
      surfaceOp={"op":"replace","startSeq":4,"endSeq":6} sourceEventSeqs=[4,5,6]
PASS  host: turn=0 boundary also emits a parseable turn=<n>
      text="Rewound to before turn=0: 3 messages removed from this conversation." parsed=0
PASS  cross-half: client checkpointTurn parses the host-produced notice verbatim
      host text -> client {cutTurn:1, startSeq:4, endSeq:6}
PASS  cross-half: both halves use the identical /\bturn=(\d+)\b/ token
      regex literal present in both halves; probe parses 7
```

`parsed=7` 证明该正则也能解析任意数字（不是靠单一样本硬编码）。含 `\b` 边界 ⇒ `turn = 1`（带空格）或 `turn==1` 不会被误解析，与 t15 写入的“等号两侧不得加空格”约束互为校验（`host` 项另有 `!/turn = \d/ && !/turn= \d/` 断言）。

### 11.4 无 r1/r2 残留 + 单飞与错误文本

```
PASS  client: no r1 residue (fork/openSession/waitFor/turnTail/picker/clipboard)
      scanned lib/host.js,lib/client.js,package.json × 7 needles → 0 hits
PASS  client: package export is a single Module Loader factory requiring only react
      inject=["slots","sessions","uiConversation","remote.commands","locale"] requires=["react"]
PASS  host: apply registers exactly one command named "rewind"
      name=rewind definitionId=dsh-session-rewind hint="[<turn>]"
PASS  host: exports name/inject and injects commands only
      name=session-rewind inject=["commands"]
PASS  host: error texts are the design §3.1 set
      usage/noSuchTurn/busy verified behaviourally; keys=usage,busy,noSuchTurn,nothingToRewind,surfaceUnexpected,systemProtected,persistFailed
PASS  host: single-flight returns BUSY for a concurrent second rewind
      second.text="Rewind is unavailable while this conversation is running, or another rewind is in flight."
PASS  host: missing/failing store flush reports PERSIST_FAILED after the in-memory append
      no store -> "The conversation was rewound in memory b…" ; flush throw -> same text; appends happened before failure
```

独立 grep 复核（不依赖 harness）：

```
$ grep -rn "sessions.fork\|openSession\|waitFor\|session-rewind-turn\|session-rewind-picker" \
      plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json
[no matches]  exit=1（grep 无命中）
$ grep -c "require(" plugins/dsh-session-rewind/lib/client.js   → 1（唯一 'react'）
```

错误文本表逐字（`lib/host.js:68-77`）：`Usage: /rewind [<turn>]`、`Rewind is unavailable while this conversation is running, or another rewind is in flight.`、`That turn is not in this conversation.`、`Nothing to rewind before that turn.`，另有 `surfaceUnexpected` / `systemProtected` / `persistFailed` 三条。

单飞机制：模块级 `const ACTIVE = new Set()`（`lib/host.js:87`），同名 sessionId 第二次调用直接 BUSY；`finally` 清键。harness 用一个永不 resolve 的 append 验证了并发拒绝。

> **键名如实记录**：任务与设计用 `USAGE / BUSY / NO_SUCH_TURN / NOTHING_TO_REWIND` 指代四类错误，实现里的键是 camelCase —— `ERROR_TEXT = { usage, busy, noSuchTurn, nothingToRewind, surfaceUnexpected, systemProtected, persistFailed }`（`lib/host.js:68-77`）。**四类语义与文本逐字一致**（`Usage: /rewind [<turn>]` / `Rewind is unavailable while…` / `That turn is not in this conversation.` / `Nothing to rewind before that turn.`），差异仅在键名风格，非缺陷；`grep -n "USAGE\|BUSY\|NO_SUCH_TURN\|NOTHING_TO_REWIND" lib/host.js` 只命中注释 `:396`，以键名文本反向检索会空手，评审请按语义对照。

### 11.5 r3 harness 全量（11/11，exit 0）

```
11/11 checks passed
[exit code: 0]
```

脚本：`.probe/x/verify/rewind-e2e.mjs`（只读脚手架，非交付物）。它用真实 `import()` 装载 `lib/host.js`、按官方 Module Loader 契约执行 `lib/client.js` 工厂，stub 出 `ctx.get('commands'|'logger'|'sessions')`、`session{log, surface.nodes, append, commit}`，并在 log 首部植入受保护的 `session/start`（node0）以贴近真实会话。

### 11.6 已退役的旧断言（避免误判为回归）

`load-sim.mjs`（r1/r2 时代）**不再适用**：它断言 fork 形态（要求 `inject` 含 `uiWorkspace`、四个 list 槽、`sessionRewindHost`、`primitives` 相关 toast、`ctx.inject(['sessionController'])`）。在 r3 形态下必然 `5/14`，**这是脚手架过期，不是实现回归**，已被 `rewind-e2e.mjs` 取代。§3 V-5 与 §10 的记录仅对 r2 字节有效。

### 11.7 未验证项（r3）

| # | 未验证项 | 原因 |
|---|---|---|
| U-1 | 真实 `pnpm add` / `dsh plugin add`、profile 依赖解析、Loader 按包名 `import` | 属部署动作，需用户显式确认；本任务禁止（In scope 仅 verification.md） |
| U-2 | 浏览器交互：`assistant-actions` 按钮渲染、hover 显隐、点击回退、DOM 隐藏器实际生效、草稿回填 | 无浏览器自动化；属人工验收（design §7 AC-*） |
| U-3 | **真实 `surfaceOp` 效果**：模型侧 `deriveMessages()` 是否立即看不到被折叠节点、重启后是否仍生效 | 需真实会话 + 真实 SessionStore；harness 只验证 append 的参数形状（`op/startSeq/endSeq/sourceEventSeqs`）与调用顺序，不模拟官方 surface 投影 |
| U-4 | `ctx.commands.register` 在真实 Cordis 4.0.5 中的挂载与 `/rewind` 在 UI 命令面板中的可发现性 | `@deepseek-ai/cordis` 只在 app.asar 内，Node 无法直接 import；用等价 ctx stub 覆盖调用契约 |
| U-5 | 跨页面重建：`conversation.chat.node` 新 key（rewind-mark）+ `visibility:'hidden'` 在真实 ui-renderer 中是否被接受 | 仅静态对齐官方 practices.md 与 4 个内置第三方插件先例；真实 keyDomain 行为待浏览器验证 |
| U-6 | `PERSIST_FAILED` 之后会话的真实不一致窗口（内存已折叠、磁盘未落盘） | 需要可控的写盘失败注入；只验证了分支存在与文本 |
| U-7 | compaction 之后回退的真实行为（`turnStartSeq` 与存活 surface 节点的位置关系） | 需真实 compaction；本轮只按 design §5 B4 的实测语义核对，未复现 |

### 11.8 r3 安装 / 卸载（**未执行，需用户确认**）

与 §7/§8 相同命令，差异只在**安装后的 UI 期望**：

- 安装后自证：宿主日志 `[session-rewind] host ready`；assistant 消息动作行（hover 显示）出现回退图标；命令面板可输入 `/rewind` 与 `/rewind 2`。
- 验收抽样：`/rewind 1` → 提示 `Rewound to before turn=1: N message(s) removed…`；该回合及之后的聊天行消失（DOM 隐藏）；模型下一轮不复述被回退内容；侧栏不新增会话；无需刷新页面。
- 卸载：`plugin_manager(action="remove_bundle", target="dsh-session-rewind")` 或 `set_plugin(session-rewind, enabled=false)`。**注意**：卸载不会撤销已写入的 surface replace 事件（那是官方会话日志内容），必要时用官方会话删除/新建会话处理。

### 11.9 r3 复现命令

```bash
cd C:/Users/i_xie_tv/.dsh

# 契约两条（分开执行）
( cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js )

# 清单 / 补丁契约（10 项）
( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node checks-manifest.mjs )

# 双端 harness（11 项，含跨端 turn= 互解）
( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node rewind-e2e.mjs )

# 残留扫描
grep -rn "sessions.fork\|openSession\|waitFor\|session-rewind-turn\|session-rewind-picker" \
  plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json

# 字节指纹
sha256sum plugins/dsh-session-rewind/{package.json,cordis.patch.yml} \
          plugins/dsh-session-rewind/lib/{host.js,client.js} plugins/dsh-session-rewind/docs/design.md
```

---

# r4 复验（task `t22`，绑定 t19/t20/t21 之后的当前字节）

## 12. r4 —— `turn=`/`upto=` 双标记契约 + F1 闭区间独立回归

### 12.1 字节绑定

| 文件 | 大小 / 行数 | sha256（r4） | r3 → r4 变化 |
|---|---|---|---|
| `lib/host.js` | 22195 B / 590 行 | `e8c0ac1bd958c6d7e4a62262eccdbab5011eb91f9bbb72af85b9c99d24627e77` | t19 整体重写（r3: `89df1df9…` / 19411 B / 521 行） |
| `lib/client.js` | 41005 B / 984 行 | `efe9bb277390a27a5a0aefb9fc82266f90fe9d86217e20a155d6bb2ddd1399a3` | t20 整体重写（r3: `136bbd6d…` / 34877 B / 870 行） |
| `package.json` | 559 B / 23 行 | `97ceeea9936fd0bfbb7bae63ee657035ee558ec789364d89c31c072af2093b86` | t19 F5 删除整个 `config` 段（r3: `8135cea0…` / 602 B） |
| `docs/design.md` | 45199 B / 457 行 | `8a4a53b938c73f3efe73f1e79dca4a42a95c6055cd09df77ee72b2501d949fed` | t21 勘误 r2.1（r3: `8f683a4f…` / 421 行） |
| `cordis.patch.yml` | 424 B | `53a4e5db30de76360c8c34829cf9eaa2b7c07f6b61207c92ec5ff816d00df617` | **四版逐字节未变** |

### 12.2 构建与清单（契约两条）

```
$ ( cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js ); echo "check exit=$?"
check exit=0

$ ( cd .probe/x/verify && node checks-manifest.mjs ) | tail -4
PASS  host bundle: zero third-party imports (design §4.5-1)
      bytes=22195 peers untouched

10/10 checks passed
```

清单 10 项逐条（r4 全量）：

```
PASS  manifest: identity and module type            dsh-session-rewind@0.2.0 type=module private=true
PASS  manifest: main and exports are self-consistent and point at real files
      exports={".":"./lib/host.js","./client":"./lib/client.js","./cordis.patch.yml":"./cordis.patch.yml","./package.json":"./package.json"}
PASS  manifest: dsh.bundle.patch and dsh.client.platform satisfy the loaders
      dsh={"bundle":{"patch":"./cordis.patch.yml"},"client":{"platform":"web"}}
PASS  manifest: files field ships the host, the client bundle and the patch   ["lib","cordis.patch.yml"]
PASS  manifest: peerDependencies match design §6.1 and gate no DSH runtime requirement
      peers={"@deepseek-ai/cordis":"*","@deepseek-ai/dsh-client-ui-slots":"*","react":"^18.2.0"} runtime=0.2.1-rc.2 unmet={}
PASS  patch: one insert row whose id/name bind the package      id=session-rewind name=dsh-session-rewind bytes=424
PASS  patch: entry binding covers both halves (bare package name row)   single bare-name row (host half) + dsh.client (browser half)
PASS  client bundle: module id equals the package name (factory key)     id=dsh-session-rewind
PASS  client bundle: no ESM syntax and no imports beyond declared clients  requires=["react"]
PASS  host bundle: zero third-party imports (design §4.5-1)     bytes=22195 peers untouched
```

### 12.3 跨端 `turn=<n> upto=<m>` 契约

**宿主产出（真跑 `apply → commands.register → handler → session.append`，非文本断言）**

```
PASS  host: /rewind 1 folds turn 1 tail and emits turn=<n> upto=<m> notice
      text="Rewound to before turn=1 upto=1: 3 messages removed from this conversation."
      surfaceOp={"op":"replace","startSeq":4,"endSeq":6} sourceEventSeqs=[4,5,6]
PASS  host: turn=0 boundary reports turn=0 upto=<last turn of the log>
      text="Rewound to before turn=0 upto=1: 6 messages removed from this conversation." parsed={turn:0, upto:1}
PASS  host: upto= upper bound is the pre-rewind max turn, never below turn=
      turn=2 upto=3 (4-turn log, cut in the middle)
```

- `/rewind`（末回合，2 回合日志）→ `turn=1 upto=1`；`/rewind 0` → `turn=0 upto=1`；4 回合日志 `/rewind 2` → `turn=2 upto=3`。**`upto` 恒等于回退前日志视图里的最大 turn**，与 t21 的派生量定义一致。
- 反向断言（每条都跑）：`!/turn = \d/`、`!/turn= \d/`、`!/upto = \d/`、`!/upto= \d/`；且 `!/undefined|NaN/`（兜底不得打印非法值）。
- 代码位置：`lib/host.js:389` 模板 `` `Rewound to before turn=${boundary.turn} upto=${upperTurn}: …` ``；`maxTurnOf` 见 `:310-321`（含 `Array.isArray` 守卫）。

**客户端解析（真跑的 append 事件回灌 `checkpointTurn`）**

```
PASS  cross-half: client checkpointTurn parses the host-produced notice verbatim
      host text -> client {cutTurn:1, shadedUpto:1, startSeq:4, endSeq:6}
PASS  cross-half: client withholds an invalid upto= instead of trusting it
      missing->{cutTurn:3,shadedUpto:null}; inverted->{cutTurn:5,shadedUpto:null}; spaced "turn = 3"->{cutTurn:null}
PASS  cross-half: both halves use the identical /\bturn=(\d+)\b/ and /\bupto=(\d+)\b/ tokens
      regex literals in client; host template `turn=<n> upto=<m>`; probes parse 7 / 9; rendered text has no padded "="
```

语义要点（`lib/client.js:785-793`）：`upto=` 缺失或倒挂时**不臆造上界**，返回 `shadedUpto: null` 交给消费方退化为「只隐藏 cutTurn」；带空格的 `turn = 3` 完全不匹配（契约外的拼写不会被误读）。

### 12.4 F1 回归 —— 独立复现（不引用 t20 自述）

新增独立 harness `.probe/x/verify/rewind-f1.mjs`：**不复用 t20 的测试**，用 `node:vm` 装载交付的 `lib/client.js`，配手写 fake DOM（行对象 = `{ attrs:{'data-chat-turn':n}, hidden }` + `getAttribute`；`MutationObserver` 与 `setInterval` 是可手动触发的桩），因此两条 reconcile 路径都能确定性驱动。

```
13/13 checks passed
[exit=0]
```

关键三项（原始输出）：

```
PASS  F1 regression: cut=3 upto=5 hides exactly turns 3, 4, 5
      rows: 0:shown 1:shown 2:shown 3:hidden 4:hidden 5:hidden
PASS  F1 regression (observer path): appended turns 6 and 7 stay visible
      after MutationObserver: 0:shown 1:shown 2:shown 3:hidden 4:hidden 5:hidden 6:shown 7:shown
PASS  F1 regression (1s fallback): rows added without a mutation stay visible
      after 1s reconcile: 0:shown 1:shown 2:shown 3:hidden 4:hidden 5:hidden 6:shown 7:shown 8:shown
PASS  F1 regression (1s fallback): a cleared `hidden` on 3/4/5 is re-applied
      after in-place clear + tick: 0:shown 1:shown 2:shown 3:hidden 4:hidden 5:hidden 6:shown 7:shown 8:shown
```

即：`turn=3 upto=5` 隐藏 3/4/5（闭区间上界生效，且 0/1/2 不受影响）；**observer 路径**下追加 turn 6、7 后两行可见；**1s 兜底路径**下（不触发 observer）追加 turn 8 仍可见；React 原地抹掉 `hidden` 后兜底会重新施加。F1（回退后新回合被吞掉）在两条路径上都不再出现。

`normalizeMark` 收敛（每条都断言「只有 cutTurn 被隐藏」，并另留 4..8 可见以证不退化成 `turn>=cut`）：

```
PASS  normalizeMark: missing upto hides only the cut turn (no open-ended tail)
      cut=3, upto=undefined -> hidden [3] (rows 4..8 stayed visible)
PASS  normalizeMark: non-integer upto (NaN / "5" / 4.5) converges to the cut turn
      NaN->[3] ; string "5"->[3] ; 4.5->[3] ; null->[3]
PASS  normalizeMark: inverted upto (2 < cut 3) converges to the cut turn
      cut=3, upto=2 -> hidden [3]; turns 4..8 visible (would be hidden by turn>=cut)
PASS  normalizeMark: invalid cut turn clears the interval instead of hiding everything
      cut=undefined -> nothing hidden
```

另外三条收尾断言：清标记恢复全部行（`setHiderCutTurn(null,…)`）、`stopHider()` 恢复全部行且计时器 `alive=0`、异会话 `sessionB` 无法清除会话 A 的标记（多会话互不撤销）。

### 12.5 t19 的 F4 / F6 独立覆盖

```
PASS  host: flush resolving false is PERSIST_FAILED, not a silent success (t19 F4)
      flush()===false -> "The conversation was rewound in memory b…"; warn="flush reported no durable write; the in-memory fold is unsaved"
PASS  host: single-flight key falls back to the agent id when session.id is empty (t19 F6)
      two empty session ids + different agent ids -> both rewinds accepted (no false BUSY)
PASS  host: missing/failing store flush reports PERSIST_FAILED after the in-memory append
      no store -> "The conversation was rewound in memory b…" ; flush throw -> same text; appends happened before failure
```

F3（`already has active work` 归入 BUSY）与 F5（`config` 段删除）为静态证据，见 §12.6。

### 12.6 残留 / 依赖 / 死键

```
$ grep -rn "sessions\.fork\|openSession\|waitFor\|session-rewind-turn\|session-rewind-picker" \
      plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json
(无输出)  exit=1

$ grep -c "require(" plugins/dsh-session-rewind/lib/client.js
1

$ grep -rn "autoResend" plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json \
      plugins/dsh-session-rewind/cordis.patch.yml
(无输出)  exit=1
```

`package.json` 现无 `config` 键（全文 23 行 / 559 B：name, version, private, type, main, exports×4, files, dsh（bundle + client）, peerDependencies×3；`grep -c config` → 0），符合 t19 F5 与 design:364 的“删 fork 专用键、`autoResend` 一并删除”结论。F3 静态证据：`lib/host.js:462-470` 匹配 `'already has active work'` 并注明来源 `dsh-agent-loop/lib/agent-loop.js:823`。

### 12.7 与 r3 的差异（为什么必须重验）

| 维度 | r3 | r4 |
|---|---|---|
| 成功文本 | `… turn=<n>: …` | `… turn=<n> upto=<m>: …`（双标记，`=` 无空格） |
| 隐藏判据 | `turn >= cutTurn`（开区间） | `cutTurn <= turn <= shadedUpto`（闭区间，F1 修复） |
| 持久化 | `flush` 异常才算失败 | 额外把 `flush()===false` 判为 `PERSIST_FAILED` |
| 单飞键 | `session.id ?? ''` | `session.id → agent.id → 'default'` |
| `package.json` | 含 `config.autoResend` | `config` 段整体删除 |
| 验证资产 | `rewind-e2e.mjs` 11 项 | `rewind-e2e.mjs` **15 项** + 新增 `rewind-f1.mjs` **13 项** |

### 12.8 缺陷清单与观察

**本次未发现缺陷。** 两条 non-blocking 观察（不需要改代码，仅记录）：

| # | 位置 | 现象 | 严重度 | 建议 |
|---|---|---|---|---|
| O-4 | `lib/client.js:129-131`（`markCache` 用 `-1` 作“已读但没有”哨兵） | `isObject(-1)` 为 false，缓存命中哨兵后每次仍回落到 `sessionStorage` 读取；语义正确，仅一次多余 `JSON.parse` | low | 可接受；若日后加缓存统计需区分“缺失/哨兵” |
| O-5 | `.probe/x/verify/load-sim.mjs`（r1/r2 fork 时代脚手架） | r3/r4 形态下必然部分失败（断言 `uiWorkspace`、4 个 list 槽、`sessionRewindHost`） | low（非交付物） | 已在 §11.6 标注退役；r4 由 `rewind-e2e.mjs` + `rewind-f1.mjs` 取代，评审勿据其判 FAIL |

r3 报告未遗留未关闭缺陷；r2 的 D-1…D-4 已关闭，O-1…O-3 中的 O-3（`host.js` 缺模块级 `name`/`inject`）已由 t13 修复（`lib/host.js:37`、`:40`，harness 断言 `name=session-rewind inject=["commands"]`）。

### 12.9 仍未验证（r4 边界）

| # | 未验证项 | 原因 |
|---|---|---|
| U-1 | 真实 `pnpm add` / `dsh plugin add`、profile 依赖解析、Loader 按包名 `import` | 部署动作需用户显式确认，本任务禁止（In scope 仅 `verification.md` + `.probe/x/verify`） |
| U-2 | 浏览器交互：`assistant-actions` 按钮渲染/hover、点击回退、DOM 隐藏器在真实 React 树上、草稿回填 | 无浏览器自动化；属人工验收（design §7 AC-*） |
| U-3 | **真实 `surfaceOp` 的模型侧效果与重启持久性**（`deriveMessages()` 是否立即看不到被折叠节点） | 需真实会话 + 真实 SessionStore；harness 只验 append 参数形状与调用顺序 |
| U-4 | 真实 Cordis 4.0.5 中 `ctx.commands.register` 的挂载与 `/rewind` 可发现性 | `@deepseek-ai/cordis` 只在 app.asar 内，Node 无法直接 import；用等价 ctx stub 覆盖契约 |
| U-5 | 跨页面重建：`conversation.chat.node` 新 key 与 `visibility:'hidden'` 是否被真实 ui-renderer 接受；`buildViewNode.data` 携带 `{cutTurn, shadedUpto}` 后的刷新恢复 | 仅静态对齐官方 practices 与先例；需真实浏览器 |
| U-6 | `PERSIST_FAILED` 之后会话的真实不一致窗口（内存已折叠、磁盘未落盘） | 需可控写盘失败注入；只验证分支与文本 |
| U-7 | compaction 之后回退的真实行为（`turnStartSeq` 与存活 surface 节点位置关系） | 需真实 compaction 会话；本轮按 design §5 B4 语义核对，未复现 |

### 12.10 安装 / 卸载（**未执行，需用户确认**）

命令与 r3 相同（`plugin_manager install_bundle` / `dsh plugin add` 本地绝对路径 / UI 添加插件），差异只在**安装后的 UI 期望**：

- 自证：宿主日志 `[session-rewind] host ready`；assistant 消息动作行 hover 出现回退图标；命令面板可 `/rewind` 与 `/rewind 2`。
- 验收抽样：`/rewind 1` → 提示 `Rewound to before turn=1 upto=1: N message(s) removed…`；该回合及之后的聊天行消失，**且回退后继续对话产生的新回合必须可见**（F1）；侧栏不新增会话；无需刷新。
- 卸载：`plugin_manager(action="remove_bundle", target="dsh-session-rewind")` 或 `set_plugin("session-rewind", enabled=false)`；卸载不撤销已写入的 surface replace 事件（那是官方会话日志内容）。

### 12.11 r4 复现命令

```bash
cd C:/Users/i_xie_tv/.dsh

# 契约两条（分开执行）
( cd plugins/dsh-session-rewind && node --check lib/host.js && node --check lib/client.js )
( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node checks-manifest.mjs )   # 10/10

# 双端契约（15 项：host 真跑 + client 解析回灌）
( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node rewind-e2e.mjs )       # 15/15

# F1 回归独立复现（13 项：fake DOM，observer + 1s 兜底）
( cd C:/Users/i_xie_tv/.dsh/.probe/x/verify && node rewind-f1.mjs )        # 13/13

# 残留 / 依赖 / 死键
grep -rn "sessions.fork\|openSession\|waitFor\|session-rewind-turn\|session-rewind-picker" \
  plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json
grep -c "require(" plugins/dsh-session-rewind/lib/client.js
grep -rn "autoResend" plugins/dsh-session-rewind/lib plugins/dsh-session-rewind/package.json \
  plugins/dsh-session-rewind/cordis.patch.yml

# 字节指纹
sha256sum plugins/dsh-session-rewind/{package.json,cordis.patch.yml} \
          plugins/dsh-session-rewind/lib/{host.js,client.js} plugins/dsh-session-rewind/docs/design.md
```


