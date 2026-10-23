/**
 * 客户端半边回归（tests/ 私有，不随包发布）。
 *
 * 覆盖评审清单里的客户端项与跨端契约：
 * - **F1**：隐藏判据必须是闭区间 `[cutTurn, shadedUpto]`；回退后新开的回合恒大于
 *   `shadedUpto`，必须保持可见。observer 路径与 1s 兜底路径都要验。
 * - **normalizeMark**：四类非法上界（缺失 / NaN / 字符串 / 倒挂）一律收敛为
 *   "只隐藏 cutTurn"，绝不放大成开区间。
 * - **M-3**：`visibleMaxTurn` 与 `reconcile` 限定在会话自己的容器作用域内；
 *   两个会话视图同时挂载时不得互踩。
 * - **markCache**：`null` 哨兵靠 `Map.has` 短路，负缓存真正生效（低项 6）。
 * - **契约**：`checkpointTurn` / `parseRewindNotice` 解析宿主 notice 的
 *   `turn=<n> upto=<m>`；非法上界宁可留空也不放大。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeWorld, loadClient, fireObservers, tickIntervals, liveIntervals, resetTimers } from './helpers/dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CLIENT = resolve(ROOT, 'lib/client.js');
const source = readFileSync(CLIENT, 'utf8');

/** 宿主 notice 契约文本（与 host.test.mjs 断言的模板同源）。 */
const NOTICE = 'Rewound to before turn=3 upto=5: 12 messages removed from this conversation.';

/**
 * 把 vm realm 里造出来的对象转成本 realm 的纯对象。
 *
 * 客户端源码在 `createContext` 沙箱里执行，它返回的标记对象带的是那个 realm 的
 * `Object.prototype`；`assert/strict` 的 deepEqual 会比原型，于是"结构相同但不同
 * realm"会误判失败。序列化一趟即可跨 realm 比较。
 */
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 造一个能被 `resolveCommands` 认出的命令通道 ctx（`readService` 只认 `ctx.get`）。 */
function commandsCtx(noticeText) {
  const remote = {
    commands: {
      execute: async () => ({ ok: true, value: { result: { kind: 'success', text: noticeText } } }),
    },
  };
  return { get: (name) => (name === 'remote.commands' ? remote.commands : name === 'remote' ? remote : undefined) };
}

/** 造一个单容器世界 + 装载客户端。 */
function mountSingle(turns = [0, 1, 2, 3, 4, 5]) {
  resetTimers();
  const world = makeWorld([turns]);
  return { world, client: loadClient(source, world) };
}

/* ------------------------------------------------------------------ */
/* 1. 导出面与契约解析                                                  */
/* ------------------------------------------------------------------ */

test('client: 导出隐藏器与标记入口，Module Loader id 正确', () => {
  const { client } = mountSingle();
  assert.equal(client.registration.id, 'dsh-session-rewind');
  for (const name of ['setHiderCutTurn', 'stopHider', 'checkpointTurn', 'readMark', 'writeMark', 'clearMark']) {
    assert.equal(typeof client.exports[name], 'function', `${name} 未导出`);
  }
});

test('client: 只 require react（无其他运行时依赖）', () => {
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['react']);
});

test('契约: checkpointTurn 从宿主 notice 解出 turn=3 upto=5', () => {
  const { client } = mountSingle();
  const mark = client.exports.checkpointTurn({
    seq: 40,
    type: 'user/message',
    data: { content: [{ type: 'text', text: NOTICE }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: 9, endSeq: 33 },
  });
  assert.equal(mark.cutTurn, 3);
  assert.equal(mark.shadedUpto, 5);
  assert.equal(mark.startSeq, 9);
  assert.equal(mark.endSeq, 33);
});

test('契约: 非自家 checkpoint 与非法上界一律不放大', () => {
  const { client } = mountSingle();
  const base = (text, extra = {}) => ({
    seq: 9,
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
    surfaceOp: { op: 'replace', startSeq: 4, endSeq: 6 },
    ...extra,
  });
  // compaction checkpoint：同类型同 origin，但 source.kind 不同 → 不认。
  const compaction = client.exports.checkpointTurn(base('Conversation compacted.', {
    data: { content: [{ type: 'text', text: 'Conversation compacted.' }], source: { kind: 'compact-checkpoint' } },
  }));
  assert.equal(compaction, null, 'compaction checkpoint 不得被当成回退标记');
  // 缺 upto=（r3 旧字节）：只解析下界，上界留空。
  const noUpto = client.exports.checkpointTurn(base('Rewound to before turn=3: 4 messages removed from this conversation.'));
  assert.equal(noUpto.cutTurn, 3);
  assert.equal(noUpto.shadedUpto, null);
  // 倒挂上界：不作为可用上界转发。
  const inverted = client.exports.checkpointTurn(base('Rewound to before turn=5 upto=2: 4 messages removed from this conversation.'));
  assert.equal(inverted.cutTurn, 5);
  assert.equal(inverted.shadedUpto, null);
  // 带空格的拼写在契约之外：整体不解析为标记。
  const spaced = client.exports.checkpointTurn(base('Rewound to before turn = 3 upto = 5: 4 messages removed.'));
  assert.equal(spaced.cutTurn, null);
  assert.equal(spaced.shadedUpto, null);
});

/* ------------------------------------------------------------------ */
/* 2. F1 闭区间回归                                                     */
/* ------------------------------------------------------------------ */

test('F1: cut=3 upto=5 恰好隐藏 3/4/5', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], world.state());
});

test('F1(observer): 回退后新增回合 6/7 保持可见', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  const six = world.addRow(6);
  const seven = world.addRow(7);
  fireObservers();
  assert.equal(six.hidden, false);
  assert.equal(seven.hidden, false);
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], `隐藏区间漂移：${world.state()}`);
});

test('F1(1s 兜底): 未触发 mutation 的新行也不被隐藏', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  const eight = world.addRow(8);
  tickIntervals();
  assert.equal(eight.hidden, false, `兜底把 turn 8 藏了：${world.state()}`);
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], world.state());
});

test('F1(1s 兜底): React 原地抹掉 hidden 后被重新套用', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  for (const turn of [3, 4, 5]) world.byTurn(turn).hidden = false;
  tickIntervals();
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], `重套失败：${world.state()}`);
});

test('F1: normalizeMark 四类非法上界都收敛为只隐藏 cutTurn', () => {
  const { world, client } = mountSingle();
  const cases = [
    ['缺失', undefined],
    ['NaN', NaN],
    ['字符串 "5"', '5'],
    ['小数 4.5', 4.5],
    ['null', null],
    ['倒挂 2', 2],
  ];
  for (const [label, upto] of cases) {
    for (const row of world.allRows()) row.hidden = false;
    client.exports.setHiderCutTurn(3, 'session-a', upto);
    assert.deepEqual(world.hiddenIn(0), [3], `upto=${label} -> 隐藏了 ${JSON.stringify(world.hiddenIn(0))}`);
  }
});

test('F1: cutTurn 非法时清除区间而不是隐藏一切', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  client.exports.setHiderCutTurn(undefined, 'session-a', 5);
  assert.deepEqual(world.hiddenIn(0), [], world.state());
});

test('F1: 清标记与 stopHider 都撤回自设的 hidden', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  client.exports.setHiderCutTurn(null, 'session-a', null);
  assert.deepEqual(world.hiddenIn(0), [], `清标记后仍有隐藏：${world.state()}`);

  client.exports.setHiderCutTurn(2, 'session-a', 4);
  assert.deepEqual(world.hiddenIn(0), [2, 3, 4]);
  client.exports.stopHider();
  assert.deepEqual(world.hiddenIn(0), [], `stopHider 后仍有隐藏：${world.state()}`);
  assert.equal(liveIntervals(), 0, 'stopHider 应清掉兜底计时器');
});

test('F1: 只撤回自己藏过的行，不动外部 hidden', () => {
  const { world, client } = mountSingle();
  const row4 = world.byTurn(4);
  row4.hidden = true; // 模拟别人（或 React）先藏了 turn 4
  client.exports.setHiderCutTurn(3, 'session-a', 3); // 区间只含 3
  tickIntervals();
  assert.equal(row4.hidden, true, 'turn 4 是外部隐藏的，撤销时不应被放开');
  client.exports.setHiderCutTurn(null, 'session-a', null);
  assert.equal(row4.hidden, true, '清标记后仍不应动外部的 hidden');
});

/* ------------------------------------------------------------------ */
/* 3. M-3：多会话视图作用域隔离                                          */
/* ------------------------------------------------------------------ */

test('M-3: 外部会话的清除请求不得抹掉本会话标记', () => {
  const { world, client } = mountSingle();
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  client.exports.setHiderCutTurn(null, 'session-b', null);
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], `外部会话抹掉了标记：${world.state()}`);
});

test('M-3: 两个会话视图同时挂载时互不干扰', () => {
  resetTimers();
  // 容器 0 = 会话 A（turn 0..5），容器 1 = 会话 B（turn 0..5）
  const world = makeWorld([[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5]]);
  const client = loadClient(source, world);

  client.exports.setHiderCutTurn(3, 'session-a', 5);
  tickIntervals();

  // A 认领的容器里 3/4/5 被隐藏；B 的容器必须一行都不动。
  const hiddenA = world.hiddenIn(0);
  const hiddenB = world.hiddenIn(1);
  assert.deepEqual(hiddenA, [3, 4, 5], `A 的容器：${world.state()}`);
  assert.deepEqual(hiddenB, [], `B 的容器被 A 的区间踩了：${world.state()}`);

  // 清掉 A，B 仍然完好（本来就没被藏过）。
  client.exports.setHiderCutTurn(null, 'session-a', null);
  assert.deepEqual(world.hiddenIn(0), [], world.state());
  assert.deepEqual(world.hiddenIn(1), [], world.state());
});

test('M-3: upto= 缺失时兜底只读本会话容器，不取全局最大值', async () => {
  resetTimers();
  // 容器 0 = 会话 A（turn 0..5）；容器 1 = 另一个会话视图（turn 0..9，更长）。
  // 若 visibleMaxTurn 仍是 document 级扫描，兜底上界会是 9 而不是 5。
  const world = makeWorld([[0, 1, 2, 3, 4, 5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  const client = loadClient(source, world);

  // 先让 A 认领容器 0（藏 1/2，留下 3/4/5 可见 → A 容器可见最大值 = 5）。
  client.exports.setHiderCutTurn(1, 'session-a', 2);
  tickIntervals();
  assert.deepEqual(world.hiddenIn(0), [1, 2], world.state());
  assert.deepEqual(world.hiddenIn(1), [], world.state());

  // 走真实回退路径：宿主返回**旧格式** notice（无 upto=），迫使客户端走 DOM 兜底。
  const legacyNotice = 'Rewound to before turn=3: 4 messages removed from this conversation.';
  const rewind = new client.exports.SessionRewind(commandsCtx(legacyNotice));
  const outcome = await rewind.apply({ sessionId: 'session-a', turn: 3 });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.shadedUpto, 5, `兜底上界应为 A 容器的 5，不是全局 9：${world.state()}`);
  assert.deepEqual(plain(client.exports.readMark('session-a')), { cutTurn: 3, shadedUpto: 5 });
  assert.deepEqual(world.hiddenIn(1), [], 'B 的容器不得被 A 的兜底上界波及');
});

test('M-3: 容器读不到时兜底退化为只隐藏 cutTurn，不猜全局值', async () => {
  resetTimers();
  const world = makeWorld([[0, 1, 2, 3, 4, 5]]);
  const client = loadClient(source, world);
  // 不先认领容器：hider.container 为 null 且 owners 无记录 → visibleMaxTurn 返回 null。
  const legacyNotice = 'Rewound to before turn=3: 4 messages removed from this conversation.';
  const rewind = new client.exports.SessionRewind(commandsCtx(legacyNotice));
  const outcome = await rewind.apply({ sessionId: 'session-orphan', turn: 3 });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.shadedUpto, 3, '读不到容器时必须收敛为 cutTurn，绝不放大');
});

test('M-3: 宿主给了 upto= 时不读 DOM，避免重建期吞掉新回合', () => {
  resetTimers();
  const world = makeWorld([[0, 1, 2, 3, 4, 5]]);
  const client = loadClient(source, world);
  // 重建期 DOM 里可能已出现回退之后的新回合（turn 9）
  world.addRow(9);
  client.exports.setHiderCutTurn(3, 'session-a', 5);
  tickIntervals();
  assert.deepEqual(world.hiddenIn(0), [3, 4, 5], `上界应来自 upto= 而非可见最大值：${world.state()}`);
  assert.equal(world.byTurn(9).hidden, false);
});

/* ------------------------------------------------------------------ */
/* 4. markCache 哨兵（低项 6）                                           */
/* ------------------------------------------------------------------ */

test('markCache: null 哨兵靠 Map.has 短路，负缓存真正生效', () => {
  resetTimers();
  // 带一个可计数的 sessionStorage：验证"读过一次就不再读"。
  const world = makeWorld([[0, 1, 2]]);
  const client = loadClient(source, world);
  let reads = 0;
  client.sandbox.window.sessionStorage = {
    getItem: () => {
      reads += 1;
      return null; // 存储里确实没有标记
    },
    setItem: () => {},
    removeItem: () => {},
  };

  assert.equal(client.exports.readMark('sess-x'), undefined, '首次读取应为 undefined');
  assert.equal(reads, 1);
  assert.equal(client.exports.readMark('sess-x'), undefined, '第二次仍为 undefined');
  assert.equal(reads, 1, `负缓存未生效，存储被重复读了 ${reads} 次`);
  assert.equal(client.exports.readMark('sess-y'), undefined, '不同会话独立');
  assert.equal(reads, 2, '另一个会话应各自读一次');
});

test('markCache: clearMark 是外部 API，删键后重新读存储', () => {
  resetTimers();
  const world = makeWorld([[0, 1, 2]]);
  const client = loadClient(source, world);
  const backing = new Map();
  let reads = 0;
  client.sandbox.window.sessionStorage = {
    getItem: (key) => {
      reads += 1;
      return backing.get(key) ?? null;
    },
    setItem: (key, value) => backing.set(key, value),
    removeItem: (key) => backing.delete(key),
  };

  client.exports.writeMark('sess-z', 3, 5);
  assert.deepEqual(plain(client.exports.readMark('sess-z')), { cutTurn: 3, shadedUpto: 5 });
  const before = reads;
  client.exports.clearMark('sess-z');
  assert.equal(client.exports.readMark('sess-z'), undefined, '清除后应读不到标记');
  assert.ok(reads > before, 'clearMark 删的是键，下一次 readMark 应重新读存储');
  assert.equal(backing.size, 0, 'sessionStorage 里的键应被移除');
  // 非法入参直接忽略，不抛错
  client.exports.clearMark('');
  client.exports.clearMark(null);
});

/* ------------------------------------------------------------------ */
/* 5. 硬约束（静态）                                                     */
/* ------------------------------------------------------------------ */

test('硬约束: 客户端不 fork、不 openSession、只保留 turn=/upto= 解析', () => {
  const banned = ['sessions.fork', '.fork(', 'openSession', 'session-rewind-turn', 'session-rewind-picker', 'clipboard'];
  for (const needle of banned) {
    assert.ok(!source.includes(needle), `lib/client.js 出现被禁用的 ${needle}`);
  }
  // 跨端契约的正则字面量必须原样保留
  assert.ok(source.includes('/\\bturn=(\\d+)\\b/'), 'client 缺少 turn= 正则字面量');
  assert.ok(source.includes('/\\bupto=(\\d+)\\b/'), 'client 缺少 upto= 正则字面量');
});
