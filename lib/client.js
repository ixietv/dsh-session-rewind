/**
 * dsh-session-rewind — Web 客户端半边（design round 2 §3.2 / §4 / §8）。
 *
 * 语义：回退 = **同会话** surface replace。客户端不再 fork、不再切会话：
 *  - 唯一触发面 = 官方 `conversation.chat.assistant-actions` 里的一个图标按钮，
 *    渲染进官方 `MessageIconActions` 动作行；显隐由官方
 *    `[data-actions-reveal=hover]` CSS 决定（历史回合默认不可见）。
 *  - 动作只经官方命令通道：`ctx.remote.commands.execute(sessionId, '/rewind <turn>', [])`。
 *    命令由宿主插件注册，结果文本由官方 adapter 渲染成会话流节点。
 *  - 旧消息的视觉消失只能靠 DOM `hidden`（官方聊天行没有"删行"扩展点，replace
 *    事件不生成行、也不移除旧行）；`[data-chat-turn]` 是官方行属性，官方布局用
 *    `:not([hidden])` 判定可见性，因此隐藏与官方折叠语义同构。
 *  - 标记持久化：内存 Map + `sessionStorage`（同标签页刷新存活）；跨页面重开时
 *    由 `rewind-mark` Conversation Definition 从 replace checkpoint 事件重建
 *    （S-1 结论：第三方可注册 `conversation.chat.node` 的新 key，证据见报告）。
 *
 * 打包方式：Module Loader 包（`window.__ModuleLoader__.load({ id, factory })`），
 * 由 Host 的 client-bundle 服务按 package.json 的 `exports["./client"]` 直接投递；
 * 无额外 bundler 步骤，`node --check` 即语法闸门。运行时只 require `react`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-rewind',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const h = React.createElement;

    /* ------------------------------------------------------------------ */
    /* 1. 常量                                                            */
    /* ------------------------------------------------------------------ */

    const NS = 'session-rewind';
    const STYLE_ID = 'dsh-session-rewind-style';
    /** 唯一触发面：官方动作行里的追加按钮（ownerProps 只有 messageId）。 */
    const SLOT_ACTIONS = 'conversation.chat.assistant-actions';
    /** 保留为 render-null 逻辑组件，只消费 inputActions 做草稿回填。 */
    const SLOT_DOCK = 'conversation.input.dock';
    /** 标记节点渲染器（visibility:'hidden'，不产生可见行）。 */
    const SLOT_NODE = 'conversation.chat.node';
    const ACTIONS_ID = 'session-rewind-rewind';
    const DOCK_ID = 'session-rewind-dock';
    const NODE_KEY = 'rewind-mark';
    const NODE_ID = 'session-rewind-mark';
    const COMMAND = '/rewind';
    const STORAGE_PREFIX = 'dsh-session-rewind:';
    /** React 重渲染冲掉 hidden 时的兜底重放周期。 */
    const RECONCILE_MS = 1000;
    /** 按钮错误态的停留时间。 */
    const ERROR_MS = 2600;

    /* ------------------------------------------------------------------ */
    /* 2. 小工具                                                          */
    /* ------------------------------------------------------------------ */

    function isObject(value) {
      return typeof value === 'object' && value !== null;
    }

    function isTurn(value) {
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    }

    /** 把 NodeList / 数组统一成普通数组；非类数组返回空数组。 */
    function rowList(rows) {
      if (Array.isArray(rows)) return rows;
      if (isObject(rows) && typeof rows.length === 'number') {
        try {
          return Array.prototype.slice.call(rows);
        } catch (error) {
          return [];
        }
      }
      return [];
    }

    /** 读取一个可能缺失的服务，不抛错。 */
    function readService(ctx, name) {
      try {
        if (typeof ctx?.get === 'function') return ctx.get(name);
      } catch (error) {
        return undefined;
      }
      return undefined;
    }

    /** 极小的外部 store（React.useSyncExternalStore 订阅）。 */
    function createStore(initial) {
      let state = initial;
      const listeners = new Set();
      return {
        get: () => state,
        set(next) {
          if (Object.is(next, state)) return;
          state = next;
          for (const listener of Array.from(listeners)) {
            try {
              listener();
            } catch (error) {
              /* 单个订阅者异常不影响其他订阅者 */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.get, store.get);
    }

    /** 没有真实会话 hook 时的稳定替身。 */
    function useStatic(selector) {
      return selector(EMPTY_SESSION);
    }

    const EMPTY_SESSION = Object.freeze({ sessionId: null, running: false, subagent: null });

    /** 用户消息文本：只取 text 块，保留原始换行（草稿回填用）。 */
    function textOfContent(content) {
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          parts.push(block.text);
        }
      }
      return parts.join('\n');
    }

    /* ------------------------------------------------------------------ */
    /* 3. 回退标记（内存 + sessionStorage）                                */
    /* ------------------------------------------------------------------ */

    /**
     * sessionId -> 回退标记的负/正缓存。
     *
     * 值有三种：`{cutTurn, shadedUpto}`（有标记）、`null`（已读过、确实没有标记）、
     * 以及"键不存在"（还没读过）。存在性判断必须走 `Map.has` —— 负缓存的 `null`
     * 是合法命中，用真值判断会把它当成未命中而反复读存储。
     */
    const markCache = new Map();
    const marksStore = createStore(0);

    function storage() {
      try {
        if (typeof window === 'undefined' || !window.sessionStorage) return null;
        return window.sessionStorage;
      } catch (error) {
        return null;
      }
    }

    /**
     * 回退标记的规范形状：cutTurn 是第一个被隐藏的回合，shadedUpto 是闭区间上界。
     * 缺失/非法/倒挂的 shadedUpto 一律收敛为 cutTurn（只隐藏切点自身），
     * 绝不放大成"隐藏到无穷"——那正是 F1（回退后新回合全空）的成因。
     */
    function normalizeMark(cutTurn, shadedUpto) {
      if (!isTurn(cutTurn)) return null;
      const upTo = isTurn(shadedUpto) && shadedUpto >= cutTurn ? shadedUpto : cutTurn;
      return { cutTurn, shadedUpto: upTo };
    }

    /**
     * 当前可见 data-chat-turn 的最大值；用于宿主未给 upto 时的应用期兜底。
     *
     * 作用域限定在调用方会话自己的容器里（design §4.3 步 1）：多会话视图同时挂载时，
     * `document` 级扫描会把另一个会话的最大 turn 当成本会话的上界，进而把别的会话的
     * 回合一起藏掉。容器读不到时不猜全局值，直接返回 `null`，让调用方按既有安全方向
     * 退化为「只隐藏 cutTurn」。
     *
     * @param scope - 可选容器替身；缺省时取当前会话绑定的容器。
     * @param owner - 可选会话 id；缺省时只看隐藏器当前唯一的活跃区间。
     * @returns 可见的最大回合号，或 `null`。
     */
    function visibleMaxTurn(scope, owner) {
      if (!hiderEnabled()) return null;
      const container = isObject(scope) ? scope : containerOf(owner);
      if (!isObject(container) || typeof container.querySelectorAll !== 'function') return null;
      let max = null;
      const rows = rowList(container.querySelectorAll('[data-chat-turn]'));
      for (const row of rows) {
        if (!isObject(row) || row.hidden === true) continue;
        const raw = typeof row.getAttribute === 'function' ? row.getAttribute('data-chat-turn') : null;
        const turn = raw === null ? NaN : Number(raw);
        if (!Number.isFinite(turn) || turn < 0) continue;
        if (max === null || turn > max) max = turn;
      }
      return max;
    }

    function readMark(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined;
      // 命中判定用 `Map.has` 而不是取值：`null` 哨兵（已读过、确实没有标记）是合法的
      // 缓存命中，必须让它短路。早先用 `get()` + 真值判断的写法会把哨兵当成未命中，
      // 于是每次 readMark 都重新读一遍 sessionStorage —— 负缓存写了却从不生效。
      if (markCache.has(sessionId)) {
        const cached = markCache.get(sessionId);
        if (cached === null) return undefined;
        if (isObject(cached)) return { cutTurn: cached.cutTurn, shadedUpto: cached.shadedUpto };
      }
      const store = storage();
      if (store !== null) {
        try {
          const raw = store.getItem(STORAGE_PREFIX + sessionId);
          if (typeof raw === 'string' && raw !== '') {
            const parsed = JSON.parse(raw);
            if (isObject(parsed) && isTurn(parsed.cutTurn)) {
              const mark = normalizeMark(parsed.cutTurn, parsed.shadedUpto);
              markCache.set(sessionId, mark);
              return { cutTurn: mark.cutTurn, shadedUpto: mark.shadedUpto };
            }
          }
        } catch (error) {
          /* 损坏的存储值按"没有标记"处理 */
        }
      }
      markCache.set(sessionId, null);
      return undefined;
    }

    function writeMark(sessionId, cutTurn, shadedUpto) {
      const mark = normalizeMark(cutTurn, shadedUpto);
      if (typeof sessionId !== 'string' || sessionId === '' || mark === null) return;
      const cached = markCache.get(sessionId);
      if (isObject(cached) && cached.cutTurn === mark.cutTurn && cached.shadedUpto === mark.shadedUpto) return;
      markCache.set(sessionId, mark);
      const store = storage();
      if (store !== null) {
        try {
          store.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(mark));
        } catch (error) {
          /* 隐私模式/配额：内存标记仍然有效 */
        }
      }
      marksStore.set(marksStore.get() + 1);
    }

    /**
     * 清除一个会话的回退标记（内存缓存 + sessionStorage），并通知订阅者。
     *
     * **外部 API**：模块内部不调用它，它只通过 `module.exports.clearMark` 暴露给
     * 其它插件与测试 harness（design §3.2 的"供其它插件/测试调用"）。删缓存键而非
     * 写 `null` 哨兵，是为了让下一次 `readMark` 重新读一遍存储——清除之后存储里
     * 理应什么都没有，重读得到的 `undefined` 才是权威答案。
     *
     * 注意它只清 UI 标记，**不撤销 DOM 隐藏**：隐藏区间的恢复由 `setHiderCutTurn(null, owner)`
     * / `stopHider()` 负责（DEC-12 回退不可逆，清标记不等于恢复历史）。
     *
     * @param sessionId - 会话 id；非字符串或空串直接忽略。
     */
    function clearMark(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return;
      markCache.delete(sessionId);
      const store = storage();
      if (store !== null) {
        try {
          store.removeItem(STORAGE_PREFIX + sessionId);
        } catch (error) {
          /* 忽略 */
        }
      }
      marksStore.set(marksStore.get() + 1);
    }

    /* ------------------------------------------------------------------ */
    /* 4. DOM 隐藏器（design §4.3 五步算法）                               */
    /* ------------------------------------------------------------------ */

    /** 我们自己的隐藏标记：容器 -> 该容器绑定的隐藏区间。 */
    const bindings = new Map();
    /** owner sessionId -> 该会话当前绑定的容器（用于 upto 兜定的作用域）。 */
    const owners = new Map();
    /** 每个隐藏区间各自记录自己藏过哪些行，撤销时只撤自己的。 */
    const hiddenByUs = new WeakMap();
    const hider = {
      owner: null,
      cutTurn: null,
      shadedUpto: null,
      container: null,
      observer: null,
      timer: null,
    };

    function hiderEnabled() {
      return typeof document !== 'undefined' && isObject(document.body);
    }

    function findContainer() {
      if (!hiderEnabled()) return null;
      const first = document.querySelector('[data-chat-turn]');
      const parent = isObject(first) ? first.parentElement : null;
      return isObject(parent) ? parent : null;
    }

    /**
     * 该 owner 会话作用域内**可见**的聊天流容器（design §4.3 步 1）。
     *
     * 官方 DOM 上没有 sessionId 属性，所以"哪个容器属于哪个会话"只能由观察证实：
     * 容器里存在 `data-chat-turn >= cutTurn` 的未隐藏行，说明该会话的回合还渲染在它
     * 里面。返回 `null` 时调用方一律按"读不到"处理并退化为只隐藏 cutTurn —— 少隐藏
     * 是可见的偏差，拿错容器（另一个会话的最大 turn）会把别人的回合藏掉。
     */
    function containerForOwner(owner) {
      if (!hiderEnabled()) return null;
      const cutTurn = owner === null || owner === undefined ? hider.cutTurn : owners.get(owner);
      if (!isTurn(cutTurn)) return null;
      let fallback = null;
      for (const [container, binding] of bindings) {
        if (!isObject(container) || typeof container.querySelectorAll !== 'function') continue;
        if (binding !== null && binding !== undefined && binding.cutTurn === cutTurn) return container;
        if (fallback !== null) continue;
        const rows = rowList(container.querySelectorAll('[data-chat-turn]'));
        for (const row of rows) {
          if (!isObject(row) || row.hidden === true) continue;
          const raw = typeof row.getAttribute === 'function' ? row.getAttribute('data-chat-turn') : null;
          const turn = raw === null ? NaN : Number(raw);
          if (Number.isFinite(turn) && turn >= cutTurn) {
            fallback = container;
            break;
          }
        }
      }
      return fallback;
    }

    /** owner 缺省时取隐藏器当前活跃区间对应的容器。 */
    function containerOf(owner) {
      if (owner !== null && owner !== undefined) return containerForOwner(owner);
      return isObject(hider.container) ? hider.container : containerForOwner(hider.owner);
    }

    /** 对单个容器套用/撤销规则；只动我们自己设过的 hidden。 */
    function reconcileContainer(container, binding) {
      if (!isObject(container) || typeof container.querySelectorAll !== 'function') return;
      // 「我们藏过哪些行」与「现在该藏哪个区间」是两件独立的事，必须分开读。
      // 清除标记正是把 binding 置 null，而撤销隐藏靠的是 hiddenByUs 里的记录：
      // 若像早先那样用 binding 门控这份记录，清除区间就永远撤不回自己藏过的行，
      // 页面会一直停在"假装已回退"的状态（stopHider 的注释承诺的行为落空）。
      const hidden = hiddenByUs.get(container);
      const cutTurn = isObject(binding) ? binding.cutTurn : null;
      const shadedUpto = isObject(binding) ? binding.shadedUpto : null;
      const rows = rowList(container.querySelectorAll('[data-chat-turn]'));
      for (const row of rows) {
        const raw = typeof row.getAttribute === 'function' ? row.getAttribute('data-chat-turn') : null;
        const turn = raw === null ? NaN : Number(raw);
        if (!Number.isFinite(turn)) continue;
        // F1 修复：闭区间 [cutTurn, shadedUpto]。回退后继续对话产生的新 turn 编号恒大于
        // shadedUpto（turn 号单调递增且 turn/start 是 log-only、不遮蔽），必须保持可见。
        const inRange = isTurn(cutTurn) && isTurn(shadedUpto) && turn >= cutTurn && turn <= shadedUpto;
        if (inRange) {
          if (row.hidden !== true) {
            row.hidden = true;
            if (hidden) hidden.add(row);
          }
        } else if (hidden && hidden.has(row) && row.hidden === true) {
          row.hidden = false;
          hidden.delete(row);
        }
      }
    }

    /**
     * 遍历所有已知聊天流容器（live + 已绑定），各按自己绑定的区间重放（M-3）。
     * 活跃区间之外的绑定仍会被持续重放，因此另一个会话的视图不会互相踩；
     * 而一个已经没有任何可见行的绑定，其 `rows` 为空，循环本身是 no-op。
     */
    function reconcile() {
      if (!hiderEnabled()) return;
      const seen = new Set();
      if (isObject(hider.container)) {
        seen.add(hider.container);
        reconcileContainer(hider.container, isObject(hiderBinding()) ? hiderBinding() : null);
      }
      for (const [container, binding] of bindings) {
        if (seen.has(container)) continue;
        seen.add(container);
        reconcileContainer(container, binding);
      }
      // 官方 React 重建出新的聊天流容器时，把它登记进作用域（只登记，不认领）。
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        for (const row of rowList(document.querySelectorAll('[data-chat-turn]'))) {
          if (!isObject(row)) continue;
          const parent = row.parentElement;
          if (isObject(parent) && !bindings.has(parent) && !seen.has(parent)) {
            bindings.set(parent, null);
            hiddenByUs.set(parent, new WeakSet());
          }
        }
      }
      pruneBindings();
    }

    function hiderBinding() {
      if (!isTurn(hider.cutTurn)) return null;
      return { cutTurn: hider.cutTurn, shadedUpto: hider.shadedUpto };
    }

    /** 容器已从 DOM 消失时释放它的绑定与 owner 记录，避免 Map 无限增长。 */
    function pruneBindings() {
      for (const [container, binding] of bindings) {
        if (container === hider.container) continue;
        // 释放的唯一判据是"容器已脱离 DOM"（`parentElement` 没了）。
        // 不能因为 binding 暂时为 null 就释放：容器可能仍在屏幕上、hiddenByUs 里
        // 还留着我们藏过的行，提前丢掉记录会让那些行永远撤不回来。
        if (isObject(container.parentElement)) continue;
        bindings.delete(container);
        hiddenByUs.delete(container);
        if (binding !== null && binding !== undefined) {
          owners.forEach((bound, owner) => {
            if (bound === container) owners.delete(owner);
          });
        }
      }
      if (bindings.size === 0 && hider.cutTurn === null) owners.clear();
    }

    /**
     * 选型说明（S-5）：`MutationObserver(childList+subtree)` 覆盖"React 重建行"，
     * 1s 周期重放覆盖"React 原地改掉 hidden 属性"（后者不会触发 childList）。
     * 不 observe `attributes`，否则我们自己的写入会自激。计时器只在有标记时运行，
     * 页面不可见时暂停，且随 session effect 清理。
     */
    function startHider() {
      if (!hiderEnabled()) return;
      if (hider.observer === null) {
        hider.observer = new MutationObserver(() => {
          if (hider.cutTurn === null) return;
          const container = findContainer();
          if (container !== null) adoptContainer(container);
          reconcile();
        });
      }
      const container = findContainer();
      if (container !== null) adoptContainer(container);
      if (hider.timer === null) {
        hider.timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          if (hider.cutTurn === null) return;
          const ticked = findContainer();
          if (ticked !== null) adoptContainer(ticked);
          reconcile();
        }, RECONCILE_MS);
      }
    }

    /**
     * 把隐藏区间认领到 container。
     *
     * 只有"当前没有任何区间"或"同一个容器"两种情况会写入 `hider.container`。
     * 其它视图的容器只登记进 `bindings`（值 `null` = 无区间），由 reconcile 各按
     * 自己绑定的区间重放，因此 `document.querySelector` 命中哪个视图都不影响归属。
     */
    function adoptContainer(container) {
      if (!isObject(container)) return;
      if (!bindings.has(container)) {
        bindings.set(container, null);
        hiddenByUs.set(container, new WeakSet());
      }
      if (!isTurn(hider.cutTurn)) {
        hider.container = container;
        return;
      }
      if (container === hider.container) return;
      const binding = bindings.get(container);
      if (binding !== null && binding !== undefined && binding.cutTurn === hider.cutTurn) {
        hider.container = container;
        return;
      }
      // 该容器里没有本会话的任何可见行：它属于另一个视图，不认领。
      if (containerForOwner(hider.owner) === container) hider.container = container;
    }

    function stopHider() {
      if (hider.timer !== null) {
        clearInterval(hider.timer);
        hider.timer = null;
      }
      // 卸载/关闭标记时把自设的 hidden 全部撤回，避免把页面留在"假装已回退"的状态。
      if (hider.cutTurn !== null) {
        const container = hider.container;
        hider.cutTurn = null;
        hider.shadedUpto = null;
        hider.owner = null;
        if (isObject(container)) {
          bindings.set(container, null);
          owners.forEach((bound, owner) => {
            if (bound === container) owners.delete(owner);
          });
        }
        reconcile();
      }
      if (hider.observer !== null) {
        hider.observer.disconnect();
        hider.observer = null;
      }
      hider.container = null;
    }

    /**
     * 设置当前会话的隐藏区间；cutTurn=null 表示恢复。
     * shadedUpto 缺省时退化为 cutTurn（闭区间只剩一行），绝不退化成开区间。
     *
     * 多会话视图（M-3）：隐藏区间与容器一一绑定。同一个会话的标记换容器时，先撤销
     * 旧容器上自己藏过的行再认领新容器；不同会话的区间不共用 `hider` 槽位之外的状态，
     * 各自在 `bindings` 里按容器重放。官方 DOM 不带 sessionId，所以"哪个容器属于
     * owner"按 `containerForOwner` 的观察判定；判不准时宁可不改（少隐藏可见、错隐藏
     * 会把别的会话藏掉）。
     */
    function setHiderCutTurn(cutTurn, owner, shadedUpto) {
      const mark = normalizeMark(cutTurn, shadedUpto);
      const next = mark === null ? null : mark.cutTurn;
      const nextUpto = mark === null ? null : mark.shadedUpto;
      // 多个会话视图可能同时挂载：只允许当前持有者撤销隐藏，避免 A 会话的清理抹掉 B 会话的标记。
      if (next === null && typeof owner === 'string' && hider.owner !== owner) return;

      if (next === null) {
        hider.owner = null;
        hider.cutTurn = null;
        hider.shadedUpto = null;
        if (isObject(hider.container)) bindings.set(hider.container, null);
        if (typeof owner === 'string' && owner !== '') owners.delete(owner);
        reconcile();
        stopHider();
        return;
      }

      if (typeof owner === 'string' && owner !== '') owners.set(owner, next);
      const sameRange = isTurn(hider.cutTurn) && hider.cutTurn === next && hider.shadedUpto === nextUpto;
      hider.owner = owner ?? null;
      hider.cutTurn = next;
      hider.shadedUpto = nextUpto;

      if (!sameRange) {
        // 区间变化：先清掉旧容器上"上一个区间藏过、新区间不再藏"的行。
        const previous = hider.container;
        if (isObject(previous) && previous !== null) bindings.set(previous, null);
        const target = containerForOwner(owner);
        if (isObject(target)) {
          if (isObject(previous) && previous !== target) bindings.set(previous, null);
          hider.container = target;
        }
      }
      startHider();
      if (isObject(hider.container)) bindings.set(hider.container, { cutTurn: next, shadedUpto: nextUpto });
      reconcile();
    }

    /* ------------------------------------------------------------------ */
    /* 5. 客户端服务（design §3.2：marks / apply / status）                */
    /* ------------------------------------------------------------------ */

    const flights = new Set();

    /** 失败/成功的对外结果只在 apply 里产生；服务自身不抛错。 */
    function outcome(ok, payload) {
      return isObject(payload) ? Object.assign({ ok }, payload) : { ok };
    }

    function usageText() {
      return 'Usage: /rewind [<turn>]';
    }

    /**
     * 宿主 notice 契约（与 t19 并列）：
     *   `Rewound to before turn=<n> upto=<m>: <k> messages removed from this conversation.`
     * cutTurn=turn=<n>，shadedUpto=upto=<m>（被遮蔽旧回合的闭区间上界）。
     */
    function parseRewindNotice(text) {
      if (typeof text !== 'string' || text === '') return null;
      const cut = /\bturn=(\d+)\b/.exec(text);
      const upto = /\bupto=(\d+)\b/.exec(text);
      return {
        cutTurn: cut === null ? null : Number(cut[1]),
        shadedUpto: upto === null ? null : Number(upto[1]),
      };
    }

    /**
     * 计算隐藏区间的上界。
     *
     * 1) 宿主给了合法 upto=（>= cutTurn）→ 直接用；
     * 2) 否则兜底取「此刻 DOM 里可见 data-chat-turn 的最大值」。
     *
     * 兜底为何安全（F1 的关键论证）：命令 resolve 的这一刻后台已经写好遮蔽事件，但 UI 尚未重建
     * （replace 事件不产生新行，旧行仍挂在 DOM 上），所以可见最大值恰等于"被遮蔽旧回合的上界"；
     * 而回退之后新开的回合编号恒大于它（turn 号单调递增，且 turn/start 是 log-only 不遮蔽），
     * 因此这个上界不会把未来的新回合卷进来。若连 DOM 都读不到，则退化为只隐藏 cutTurn 自身。
     */
    function shadedUptoFor(text, cutTurn) {
      const notice = parseRewindNotice(text);
      if (notice !== null && isTurn(notice.shadedUpto) && notice.shadedUpto >= cutTurn) return notice.shadedUpto;
      const visible = visibleMaxTurn();
      if (isTurn(visible) && visible >= cutTurn) return visible;
      return cutTurn;
    }

    function resolveCommands(ctx) {
      const direct = readService(ctx, 'remote.commands');
      if (isObject(direct) && typeof direct.execute === 'function') return direct;
      const remote = readService(ctx, 'remote');
      if (isObject(remote) && isObject(remote.commands) && typeof remote.commands.execute === 'function') {
        return remote.commands;
      }
      return null;
    }

    class SessionRewind {
      constructor(ctx) {
        this.ctx = ctx;
      }

      /** 能力面：槽位 + 命令通道都在才算启用。 */
      enabled() {
        return isObject(this.ctx?.slots) && resolveCommands(this.ctx) !== null;
      }

      marks(sessionId) {
        return readMark(sessionId);
      }

      status(sessionId) {
        const mark = readMark(sessionId);
        return mark === undefined
          ? { rewound: false }
          : { rewound: true, cutTurn: mark.cutTurn, shadedUpto: mark.shadedUpto };
      }

      /**
       * 与按钮同路径：`ctx.remote.commands.execute(sessionId, '/rewind <turn>', [])`。
       * 校验顺序：turn 合法 → 单飞 → 命令通道 → 宿主结果。
       */
      async apply(input) {
        const sessionId = isObject(input) && typeof input.sessionId === 'string' ? input.sessionId : '';
        const turn = isObject(input) ? input.turn : undefined;
        if (sessionId === '') {
          return outcome(false, { code: 'REJECTED', text: 'No active conversation.' });
        }
        if (!isTurn(turn)) {
          return outcome(false, { code: 'REJECTED', text: usageText() });
        }
        if (flights.has(sessionId)) {
          return outcome(false, { code: 'BUSY', text: 'A rewind is already in progress in this conversation.' });
        }
        const commands = resolveCommands(this.ctx);
        if (commands === null) {
          return outcome(false, { code: 'RPC_FAILED', text: 'The command channel is unavailable.' });
        }
        flights.add(sessionId);
        try {
          const response = await commands.execute(sessionId, COMMAND + ' ' + turn, []);
          if (!isObject(response) || response.ok !== true) {
            const detail = isObject(response) && isObject(response.error) && typeof response.error.message === 'string'
              ? response.error.message
              : 'the command was refused';
            return outcome(false, { code: 'RPC_FAILED', text: detail });
          }
          const result = isObject(response.value) && isObject(response.value.result) ? response.value.result : null;
          if (result === null) {
            return outcome(false, { code: 'RPC_FAILED', text: 'The command returned no result.' });
          }
          const text = typeof result.text === 'string' ? result.text : '';
          if (result.kind !== 'success') {
            return outcome(false, { code: 'REJECTED', text: text === '' ? 'The rewind was rejected.' : text });
          }
          writeMark(sessionId, turn, shadedUptoFor(text, turn));
          const mark = readMark(sessionId);
          return outcome(true, {
            cutTurn: turn,
            shadedUpto: mark === undefined ? turn : mark.shadedUpto,
            text,
          });
        } catch (error) {
          const detail = isObject(error) && typeof error.message === 'string' ? error.message : 'the command failed';
          return outcome(false, { code: 'RPC_FAILED', text: detail });
        } finally {
          flights.delete(sessionId);
          flightsStore.set(flightsStore.get() + 1);
        }
      }
    }

    const flightsStore = createStore(0);

    /* ------------------------------------------------------------------ */
    /* 6. 草稿回填队列（按钮 → 隐藏的 dock 逻辑组件）                       */
    /* ------------------------------------------------------------------ */

    const pendingDraftStore = createStore(null);

    function requestDraft(sessionId, turn, text) {
      if (typeof sessionId !== 'string' || sessionId === '' || !isTurn(turn)) return;
      pendingDraftStore.set({ sessionId, turn, text: typeof text === 'string' ? text : '', nonce: Date.now() });
    }

    /* ------------------------------------------------------------------ */
    /* 7. 会话快照读取（只读官方 chat 快照）                               */
    /* ------------------------------------------------------------------ */

    function chatSnapshotOf(ctx, sessionId) {
      try {
        const conversation = readService(ctx, 'uiConversation');
        if (!isObject(conversation) || typeof conversation.binding !== 'function') return null;
        const binding = conversation.binding(sessionId);
        if (!isObject(binding) || typeof binding.target !== 'function') return null;
        const target = binding.target('chat');
        if (!isObject(target) || typeof target.getSnapshot !== 'function') return null;
        return target.getSnapshot();
      } catch (error) {
        return null;
      }
    }

    /** 该 messageId 所属回合号；找不到返回 null（保持返回原始值以稳定比较）。 */
    function turnOfMessage(snapshot, messageId) {
      if (!isObject(snapshot) || typeof messageId !== 'string') return null;
      const turns = isObject(snapshot.timeline) ? snapshot.timeline.turns : null;
      if (isObject(turns) && typeof turns.values === 'function') {
        for (const turn of turns.values()) {
          const data = isObject(turn) && isObject(turn.data) && typeof turn.data.get === 'function'
            ? turn.data.get('turn-tail')
            : undefined;
          const closing = isObject(data) ? data.closing : undefined;
          if (isObject(closing) && isObject(closing.finalNode) && closing.finalNode.messageId === messageId) {
            return isTurn(turn.turn) ? turn.turn : null;
          }
        }
      }
      const nodes = isObject(snapshot.nodes) && typeof snapshot.nodes.values === 'function' ? snapshot.nodes.values() : null;
      if (Array.isArray(nodes)) {
        for (const node of nodes) {
          if (!isObject(node) || node.kind !== 'turn-tail' || !isObject(node.data)) continue;
          const closing = node.data.closing;
          if (!isObject(closing) || !isObject(closing.finalNode) || closing.finalNode.messageId !== messageId) continue;
          const location = node.location;
          if (isObject(location) && (location.kind === 'turn' || location.kind === 'step') && isTurn(location.turn)) {
            return location.turn;
          }
        }
      }
      return null;
    }

    /** 回合里的第一条真实用户消息文本（草稿回填）。 */
    function userTextOfTurn(snapshot, turn) {
      if (!isObject(snapshot) || !isTurn(turn)) return '';
      const locations = isObject(snapshot.locations) ? snapshot.locations : null;
      const nodes = isObject(snapshot.nodes) ? snapshot.nodes : null;
      if (locations === null || nodes === null || typeof locations.getTurn !== 'function' || typeof nodes.get !== 'function') {
        return '';
      }
      let keys = null;
      try {
        keys = locations.getTurn(turn);
      } catch (error) {
        return '';
      }
      if (!Array.isArray(keys)) return '';
      for (const key of keys) {
        const node = nodes.get(key);
        if (isObject(node) && node.kind === 'user' && isObject(node.data)) {
          const text = textOfContent(node.data.content);
          if (text !== '') return text;
        }
      }
      return '';
    }

    /** 该回合是否还有可回退的 surface 内容（有 user 节点即可；宿主仍会二次校验）。 */
    function turnRewindable(snapshot, turn) {
      if (!isObject(snapshot) || !isTurn(turn)) return false;
      const locations = isObject(snapshot.locations) ? snapshot.locations : null;
      const nodes = isObject(snapshot.nodes) ? snapshot.nodes : null;
      if (locations === null || nodes === null || typeof locations.getTurn !== 'function' || typeof nodes.get !== 'function') {
        return true;
      }
      let keys = null;
      try {
        keys = locations.getTurn(turn);
      } catch (error) {
        return true;
      }
      if (!Array.isArray(keys)) return true;
      for (const key of keys) {
        const node = nodes.get(key);
        if (isObject(node) && (node.kind === 'user' || node.kind === 'assistant-step')) return true;
      }
      return false;
    }

    /**
     * 聚合聊天快照里的 rewind-mark 节点 → { cutTurn, shadedUpto }。
     * 多次回退会留下多个标记：cutTurn 取最小（最早切点），shadedUpto 取最大（覆盖全部被遮蔽回合）。
     */
    function collectChatMarks(snapshot) {
      if (!isObject(snapshot) || !isObject(snapshot.nodes) || typeof snapshot.nodes.values !== 'function') return null;
      const nodes = snapshot.nodes.values();
      if (!Array.isArray(nodes)) return null;
      let cutTurn = null;
      let shadedUpto = null;
      for (const node of nodes) {
        if (!isObject(node) || node.kind !== NODE_KEY || !isObject(node.data)) continue;
        const cut = node.data.cutTurn;
        if (!isTurn(cut)) continue;
        if (cutTurn === null || cut < cutTurn) cutTurn = cut;
        const up = isTurn(node.data.shadedUpto) && node.data.shadedUpto >= cut ? node.data.shadedUpto : cut;
        if (shadedUpto === null || up > shadedUpto) shadedUpto = up;
      }
      return cutTurn === null ? null : { cutTurn, shadedUpto };
    }

    /**
     * 跨页面重建入口。刻意返回标量（而不是对象）：
     * useSyncExternalStore 用 Object.is 比较 selector 结果，返回新对象会自激重渲染。
     */
    function readChatCut(snapshot) {
      const mark = collectChatMarks(snapshot);
      return mark === null ? null : mark.cutTurn;
    }

    function readChatUpto(snapshot) {
      const mark = collectChatMarks(snapshot);
      return mark === null ? null : mark.shadedUpto;
    }

    /** 对外保留对象形态（导出/测试用；组件内必须走上面两个标量选择器）。 */
    function readMarkFromChat(snapshot) {
      return collectChatMarks(snapshot);
    }

    /* ------------------------------------------------------------------ */
    /* 8. 组件                                                            */
    /* ------------------------------------------------------------------ */

    const serviceRef = { current: null };

    function serviceOf() {
      return serviceRef.current;
    }

    /** 动作行里的图标按钮（design §4.2）。 */
    function RewindActionButton(props) {
      const { messageId } = isObject(props) ? props : {};
      const useChatHook = typeof props?.useChat === 'function' ? props.useChat : useStatic;
      const useSessionHook = typeof props?.useSession === 'function' ? props.useSession : useStatic;
      const t = typeof props?.t === 'function' ? props.t : null;

      const turn = useChatHook((snapshot) => turnOfMessage(snapshot, messageId));
      const running = useSessionHook((snapshot) => (isObject(snapshot) ? snapshot.running === true : false));
      useStore(flightsStore);
      const [error, setError] = React.useState(null);

      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const service = serviceOf();
      const ctx = service !== null && isObject(service.ctx) ? service.ctx : null;
      const busy = isTurn(turn) && sessionId !== '' && service !== null && flights.has(sessionId);

      const label = typeof t === 'function' ? t('action.label') : '回退到此回合之前';

      React.useEffect(() => {
        if (error === null) return undefined;
        const timer = setTimeout(() => setError(null), ERROR_MS);
        return () => clearTimeout(timer);
      }, [error]);

      if (!isTurn(turn) || sessionId === '' || service === null) return null;
      if (typeof service.enabled === 'function' && !service.enabled()) return null;
      if (running) return null;
      // 快照读不到时保留按钮（宿主会二次校验并给出可见的错误文本）。
      const snapshot = chatSnapshotOf(ctx, sessionId);
      if (snapshot !== null && !turnRewindable(snapshot, turn)) return null;

      const disabled = busy;
      const title = error !== null
        ? (typeof t === 'function' ? t('action.error', { message: error }) : '回退失败：' + error)
        : disabled
          ? (typeof t === 'function' ? t('action.busy') : '回退中…')
          : label;

      const onClick = () => {
        if (disabled) return;
        const text = userTextOfTurn(chatSnapshotOf(ctx, sessionId), turn);
        Promise.resolve(service.apply({ sessionId, turn })).then(
          (result) => {
            if (isObject(result) && result.ok === true) {
              requestDraft(sessionId, turn, text);
              setError(null);
            } else {
              const message = isObject(result) && typeof result.text === 'string' ? result.text : 'unknown error';
              setError(message);
            }
          },
          () => setError('unknown error'),
        );
      };

      return h(
        'button',
        {
          type: 'button',
          className: 'dshrw-action' + (error === null ? '' : ' dshrw-action-error'),
          'data-session-rewind': 'action',
          'data-state': error === null ? (disabled ? 'busy' : 'idle') : 'error',
          title,
          'aria-label': title,
          disabled,
          onClick,
        },
        h('span', { className: 'dshrw-action-icon', 'aria-hidden': 'true' }, busy ? '…' : '↩'),
      );
    }

    /**
     * render-null 逻辑组件：把标记落到 DOM 隐藏器，并消费草稿回填队列。
     * 它必须在 session effect 内做清理（AC-7 / AC-14）。
     */
    function RewindDockBridge(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : '';
      const inputActions = isObject(props?.inputActions) ? props.inputActions : null;
      const useChatHook = typeof props?.useChat === 'function' ? props.useChat : useStatic;
      const markTick = useStore(marksStore);
      const pending = useStore(pendingDraftStore);
      // 标量选择器：两次 hook 共享同一次节点聚合，返回值是 number|null，引用天然稳定。
      const chatCut = useChatHook(readChatCut);
      const chatUpto = useChatHook(readChatUpto);

      const stored = readMark(sessionId);
      const cutTurn = chatCut !== null ? chatCut : stored === undefined ? null : stored.cutTurn;
      const shadedUpto = chatCut !== null ? chatUpto : stored === undefined ? null : stored.shadedUpto;

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined;
        setHiderCutTurn(cutTurn, sessionId, shadedUpto);
        if (chatCut !== null) writeMark(sessionId, chatCut, chatUpto);
        return () => {
          setHiderCutTurn(null, sessionId);
        };
      }, [sessionId, cutTurn, shadedUpto, chatCut, chatUpto]);

      React.useEffect(() => {
        if (!isObject(pending) || pending.sessionId !== sessionId || inputActions === null) return;
        const text = typeof pending.text === 'string' ? pending.text : '';
        if (text !== '') {
          try {
            if (typeof inputActions.setDraft === 'function') inputActions.setDraft(text);
            if (typeof inputActions.persistDraft === 'function') {
              const persisted = inputActions.persistDraft();
              if (isObject(persisted) && typeof persisted.then === 'function') persisted.catch(() => {});
            }
          } catch (error) {
            /* 草稿回填是便利功能，失败不影响已完成的回退 */
          }
        }
        pendingDraftStore.set(null);
      }, [pending, sessionId, inputActions]);

      return null;
    }

    /** 标记节点渲染器：节点是 visibility:'hidden'，这里只做防御性占位。 */
    function RewindMarkView() {
      return null;
    }

    /* ------------------------------------------------------------------ */
    /* 9. Conversation Definition（跨页面重建回调标记）                    */
    /* ------------------------------------------------------------------ */

    function checkpointTurn(event) {
      if (!isObject(event) || event.type !== 'user/message') return null;
      const op = isObject(event.surfaceOp) ? event.surfaceOp : null;
      if (op === null || op.op !== 'replace') return null;
      const data = isObject(event.data) ? event.data : null;
      const source = isObject(data) ? data.source : null;
      // compaction 的 checkpoint 用 compact-checkpoint source；只认我们自己的 user checkpoint。
      if (!isObject(source) || source.kind !== 'user') return null;
      const startSeq = isTurn(op.startSeq) ? op.startSeq : null;
      const endSeq = isTurn(op.endSeq) ? op.endSeq : null;
      if (startSeq === null || endSeq === null || endSeq < startSeq) return null;
      const text = textOfContent(isObject(data) ? data.content : null);
      // 宿主 notice 契约：`Rewound to before turn=<n> upto=<m>: ...`。
      // cutTurn 缺失时节点仍然生成，但 UI 忽略（降级为 sessionStorage 标记）。
      const match = /\bturn=(\d+)\b/.exec(text);
      const cutTurn = match === null ? null : Number(match[1]);
      const uptoMatch = /\bupto=(\d+)\b/.exec(text);
      const rawUpto = uptoMatch === null ? null : Number(uptoMatch[1]);
      const validCut = cutTurn !== null && isTurn(cutTurn) ? cutTurn : null;
      // 重建期不做 DOM 读：此刻 DOM 里可能已经出现"回退之后新开的回合"，用可见最大值会把
      // 新回合一起吞掉（F1 复发）。所以 upto 缺失时宁可不声明上界，由消费方退化为
      // 只隐藏 cutTurn 自身——少隐藏是可见的偏差，多隐藏会让对话看起来凭空消失。
      const shadedUpto = validCut !== null && rawUpto !== null && isTurn(rawUpto) && rawUpto >= validCut ? rawUpto : null;
      return {
        startSeq,
        endSeq,
        cutTurn: validCut,
        shadedUpto,
        text: text.length > 240 ? text.slice(0, 240) : text,
      };
    }

    const rewindDefinition = {
      kind: NODE_KEY,
      target: 'chat',
      match: (event) => {
        try {
          const mark = checkpointTurn(event);
          if (mark === null) return null;
          return { id: String(event.seq), role: 'start' };
        } catch (error) {
          return null;
        }
      },
      start: (_context, matched) => {
        try {
          return checkpointTurn(matched.event);
        } catch (error) {
          return null;
        }
      },
      buildViewNode: (context) => {
        try {
          const start = context.start ?? (Array.isArray(context.matches) ? context.matches[0] : undefined);
          if (!isObject(start)) return null;
          const data = context.state ?? checkpointTurn(start.event);
          if (!isObject(data)) return null;
          return {
            key: context.key,
            kind: NODE_KEY,
            id: context.id,
            target: 'chat',
            anchorSeq: start.event.seq,
            location: start.location,
            visibility: 'hidden',
            data,
          };
        } catch (error) {
          return null;
        }
      },
    };

    /* ------------------------------------------------------------------ */
    /* 10. 文案                                                           */
    /* ------------------------------------------------------------------ */

    const zh = {
      'action.label': '回退到此回合之前',
      'action.busy': '回退中…',
      'action.error': '回退失败：{message}',
      'action.rewound': '此回合之后的历史已从本会话移除',
    };

    const en = {
      'action.label': 'Rewind before this turn',
      'action.busy': 'Rewinding…',
      'action.error': 'Rewind failed: {message}',
      'action.rewound': 'Later history was removed from this conversation',
    };

    /* ------------------------------------------------------------------ */
    /* 11. 样式                                                           */
    /* ------------------------------------------------------------------ */

    const CSS = [
      '.dshrw-action{display:inline-flex;align-items:center;justify-content:center;gap:2px;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#8b9ac4);cursor:pointer;font:inherit;font-size:13px;line-height:1}',
      '.dshrw-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#c3cdee)}',
      '.dshrw-action:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#4c8dff);outline-offset:1px}',
      '.dshrw-action:disabled{cursor:default;opacity:.55}',
      '.dshrw-action-icon{font-size:14px;line-height:1}',
      '.dshrw-action-error{color:var(--dsw-alias-state-error-primary,#ff8080)}',
    ].join('\n');

    function ensureStyle() {
      if (typeof document === 'undefined') return () => {};
      const existing = document.getElementById(STYLE_ID);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        const node = document.getElementById(STYLE_ID);
        if (isObject(node) && isObject(node.parentNode)) node.parentNode.removeChild(node);
      };
    }

    /* ------------------------------------------------------------------ */
    /* 12. 插件入口                                                       */
    /* ------------------------------------------------------------------ */

    const inject = ['slots', 'sessions', 'uiConversation', 'remote.commands', 'locale'];

    function apply(ctx) {
      const slots = isObject(ctx) ? ctx.slots : null;
      if (!isObject(slots)) return;

      const service = new SessionRewind(ctx);
      serviceRef.current = service;

      ctx.effect(() => {
        const releaseStyle = ensureStyle();
        return () => {
          releaseStyle();
          stopHider();
          if (serviceRef.current === service) serviceRef.current = null;
        };
      }, 'session-rewind: style and instance');

      ctx.effect(() => {
        if (isObject(ctx.locale) && typeof ctx.locale.register === 'function') {
          return ctx.locale.register(NS, { en, zh });
        }
        return () => {};
      }, 'session-rewind: dictionaries');

      ctx.effect(() => {
        const reflect = ctx.reflect;
        if (!isObject(reflect) || typeof reflect.provide !== 'function') return () => {};
        try {
          return reflect.provide('sessionRewind', service);
        } catch (error) {
          return () => {};
        }
      }, 'session-rewind: client service');

      if (!service.enabled()) return;

      slots.inject(SLOT_ACTIONS, () =>
        slots.register(
          { name: SLOT_ACTIONS, id: ACTIONS_ID, order: 40, label: zh['action.label'], locale: NS },
          RewindActionButton,
        ),
      );

      slots.inject(SLOT_DOCK, () =>
        slots.register(
          { name: SLOT_DOCK, id: DOCK_ID, order: 200, label: zh['action.label'], locale: NS },
          RewindDockBridge,
        ),
      );

      // 跨页面重建通道（S-1 判定可行）：definition 产出 visibility:'hidden' 节点，
      // 其 data.cutTurn 由 dock 桥与 DOM 隐藏器读取；节点本身不产生可见行。
      const conversation = readService(ctx, 'uiConversation');
      if (isObject(conversation) && isObject(conversation.events) && typeof conversation.events.register === 'function') {
        ctx.effect(() => {
          try {
            return conversation.events.register(rewindDefinition);
          } catch (error) {
            return () => {};
          }
        }, 'session-rewind: conversation definition');
        slots.inject(SLOT_NODE, () =>
          slots.register(
            { name: SLOT_NODE, key: NODE_KEY, locale: NS },
            RewindMarkView,
          ),
        );
      }
    }

    module.exports = {
      inject,
      apply,
      rewindDefinition,
      checkpointTurn,
      readMark,
      writeMark,
      clearMark,
      SessionRewind,
      RewindActionButton,
      RewindDockBridge,
      requestDraft,
      turnOfMessage,
      userTextOfTurn,
      readMarkFromChat,
      setHiderCutTurn,
      stopHider,
    };
    return module.exports;
  },
});
