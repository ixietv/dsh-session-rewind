/**
 * 客户端测试用的 fake DOM + Module Loader 装载器（tests/ 私有，不随包发布）。
 *
 * 客户端半边是 `window.__ModuleLoader__.load({id, factory})` 形态，只能在 vm 里
 * 执行源码、捕获 registration、再 `factory(require)` 取导出。DOM 侧按官方隐藏器
 * 真正读取的三个入口造替身：
 *
 * - `document.querySelector('[data-chat-turn]')` → 第一行（`findContainer` 用它的
 *   `parentElement` 认领容器）；
 * - `document.querySelectorAll('[data-chat-turn]')` → 全部行（`reconcile` 登记新容器）；
 * - `container.querySelectorAll('[data-chat-turn]')` → 该容器自己的行（M-3 作用域隔离）。
 *
 * 支持**多容器**是为了测 M-3：两个会话视图同时挂载时，A 的隐藏区间不得影响 B 的容器。
 * `MutationObserver` 与 `setInterval` 都是被捕获的 stub，`fireObservers()` /
 * `tickIntervals()` 手动驱动，于是 observer 路径与 1s 兜底路径都能确定性复现。
 */
import { createContext, runInContext } from 'node:vm';

/** 一行聊天消息：plain object 携带 data-chat-turn 与 hidden 标志。 */
function makeRow(turn) {
  const attrs = { 'data-chat-turn': String(turn) };
  return {
    turn,
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
  };
}

/** 一个聊天流容器：持有自己的行，暴露 querySelectorAll。 */
function makeContainer(turns) {
  const rows = turns.map((turn) => makeRow(turn));
  const container = {
    rows,
    parentElement: null, // 稍后指向 body，模拟"仍在 DOM 中"
    querySelectorAll(selector) {
      return selector === '[data-chat-turn]' ? rows.slice() : [];
    },
  };
  for (const row of rows) row.parentElement = container;
  return container;
}

/**
 * 造一个多容器世界。
 *
 * @param containerTurns - 每个元素是一个容器的 turn 列表，如 `[[0,1,2,3,4,5]]`
 *   表示单容器；`[[0..5],[0..5]]` 表示两个会话视图各一屏。
 * @returns world（含 containers / allRows / addRow / byTurn / state）
 */
export function makeWorld(containerTurns = [[0, 1, 2, 3, 4, 5]]) {
  const body = {};
  const containers = containerTurns.map((turns) => {
    const container = makeContainer(turns);
    container.parentElement = body;
    return container;
  });
  const world = { body, containers };

  world.allRows = () => containers.flatMap((container) => container.rows);
  world.byTurn = (turn, containerIndex = 0) =>
    containers[containerIndex].rows.find((row) => row.turn === turn) ?? null;
  /** 第 containerIndex 个容器当前隐藏了哪些 turn。 */
  world.hiddenIn = (containerIndex = 0) =>
    containers[containerIndex].rows.filter((row) => row.hidden === true).map((row) => row.turn);
  world.state = () =>
    containers
      .map(
        (container, index) =>
          `c${index}[${container.rows.map((row) => `${row.turn}:${row.hidden ? 'H' : 'v'}`).join(' ')}]`,
      )
      .join(' ');
  /** 往指定容器追加一行（模拟回退后新回合渲染）。 */
  world.addRow = (turn, containerIndex = 0) => {
    const container = containers[containerIndex];
    const row = makeRow(turn);
    row.parentElement = container;
    container.rows.push(row);
    return row;
  };
  return world;
}

const observers = [];
const intervals = [];

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    observers.push(this);
  }
  observe() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  fire() {
    if (this.connected) this.callback([]);
  }
}

/** 触发所有已连接的 MutationObserver。 */
export function fireObservers() {
  for (const observer of observers) observer.fire();
}

/** 触发所有未清除的 1s 兜底 interval。 */
export function tickIntervals() {
  for (const entry of intervals) if (!entry.cleared) entry.callback();
}

/** 当前仍存活的 interval 数。 */
export function liveIntervals() {
  return intervals.filter((entry) => !entry.cleared).length;
}

/** 完整的 react stub（客户端只 require('react')）。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ __el: type, props: props ?? null, children }),
    Fragment: Symbol.for('react.fragment'),
    useSyncExternalStore: (subscribe, get) => get(),
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    useState: (v) => [v, () => {}],
  };
}

/**
 * 在 vm 里执行客户端源码并取回导出面。
 *
 * @param source - `lib/client.js` 的文本。
 * @param world - `makeWorld` 的产物。
 * @returns `{ exports, registration, sandbox }`
 */
export function loadClient(source, world) {
  let registration = null;
  const allRows = world.allRows;
  const documentStub = {
    body: world.body,
    head: { appendChild() {} },
    visibilityState: 'visible',
    getElementById: () => ({ textContent: '' }),
    createElement: () => ({ setAttribute() {}, appendChild() {}, textContent: '' }),
    querySelector(selector) {
      if (selector === '[data-chat-turn]') return allRows()[0] ?? null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-chat-turn]') return allRows().slice();
      return [];
    },
  };
  const sandbox = {
    console,
    window: {
      __ModuleLoader__: { load: (def) => { registration = def; } },
      sessionStorage: null,
      location: { href: 'http://127.0.0.1:53859/' },
      addEventListener() {},
      removeEventListener() {},
    },
    document: documentStub,
    MutationObserver: FakeMutationObserver,
    setInterval(callback) {
      const entry = { callback, cleared: false };
      intervals.push(entry);
      return entry;
    },
    clearInterval(entry) {
      if (entry) entry.cleared = true;
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    queueMicrotask,
    navigator: {},
    globalThis: null,
  };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(source, context, { filename: 'lib/client.js' });
  if (registration === null) throw new Error('client bundle 未注册 Module Loader factory');
  const exports = registration.factory((spec) => {
    if (spec !== 'react') throw new Error(`意外 require("${spec}")`);
    return reactStub();
  });
  return { exports, registration, sandbox };
}

/** 清空 observer / interval 记录（每个测试文件开头调一次，避免跨用例串味）。 */
export function resetTimers() {
  observers.length = 0;
  intervals.length = 0;
}
