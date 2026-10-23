/**
 * 宿主半边回归（tests/ 私有，不随包发布）。
 *
 * 覆盖评审清单里两条宿主项与硬约束：
 * - **H-1**：目标回合的 surface 节点若已被此前回退折叠，拒绝二次回退；
 * - **H-1 的边界（design §5 B4）**：尾部只剩 *compaction* checkpoint 时必须**允许**
 *   折叠 —— 这正是"任何 replace-origin 都拒绝"的写法会回归掉的用例；
 * - **H-2**：store 缺失时在 append **之前**拒绝，不再把成功的折叠误报成
 *   `PERSIST_FAILED`；日志保持 append-only；不调 `session.commit()`。
 *
 * 命令一律经真实 `apply()` → 注册的 definition → handler 调用，不直接打内部函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  makeSession,
  makeHostContext,
  pushCompactionCheckpoint,
  SYSTEM_NODE_SEQ,
} from './helpers/session.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');

const host = await import(pathToFileURL(resolve(ROOT, 'lib/host.js')).href);
const hostSource = readFileSync(resolve(ROOT, 'lib/host.js'), 'utf8');

/** 跑一遍 apply() 并把注册到的 `/rewind` definition 取出来。 */
function mount() {
  const ctx = makeHostContext();
  host.apply(ctx, undefined);
  assert.equal(ctx.registered.length, 1, 'apply() 应恰好注册一个命令');
  return { ctx, definition: ctx.registered[0] };
}

/** 调 handler。 */
function rewind(definition, rawInput, session, agentExtra = {}) {
  return definition.handler({
    rawInput,
    agent: { status: 'idle', session, ...agentExtra },
  });
}

/** 断言日志前半段逐字节未变（append-only 硬约束）。 */
function expectAppendOnly(before, session) {
  const snapshot = JSON.parse(before);
  const now = JSON.parse(JSON.stringify(session.log)).slice(0, snapshot.length);
  assert.deepEqual(now, snapshot, '既有事件的 seq/payload 被改动，违反 append-only');
}

/* ------------------------------------------------------------------ */
/* 1. 契约与导出面                                                      */
/* ------------------------------------------------------------------ */

test('host: 导出 name / inject，inject 含 commands 与 sessions（H-2）', () => {
  assert.equal(host.name, 'session-rewind');
  assert.deepEqual(host.inject, ['commands', 'sessions']);
});

test('host: apply 注册名为 rewind 的命令并打 host ready', () => {
  const { ctx, definition } = mount();
  assert.equal(definition.name, 'rewind');
  assert.equal(definition.definitionId, 'dsh-session-rewind');
  assert.equal(typeof definition.handler, 'function');
  assert.deepEqual(definition.input, { hint: '[<turn>]' });
  assert.ok(ctx.logs.some((line) => line.includes('[session-rewind] host ready')));
});

/* ------------------------------------------------------------------ */
/* 2. H-1：二次回退必须被拒绝                                            */
/* ------------------------------------------------------------------ */

test('H-1: 首次 /rewind 1 成功折叠尾部并发出 turn=/upto= notice', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 3 });
  const before = JSON.stringify(session.log);

  const result = await rewind(definition, '1', session);

  assert.equal(result.kind, 'success', JSON.stringify(result));
  // 3 回合会话：surface.nodes = [0,2,3,5,6,8,9]，turn 1 从 seq 4 起 → span [5,6,8,9]
  const call = session.appended[0];
  assert.equal(call.type, 'user/message');
  assert.deepEqual(call.options.surfaceOp, { op: 'replace', startSeq: 5, endSeq: 9 });
  assert.deepEqual(call.options.sourceEventSeqs, [5, 6, 8, 9]);
  assert.match(call.data.content[0].text, /Rewound to before turn=1 upto=2: 4 messages removed/);
  expectAppendOnly(before, session);
  assert.equal(session.committed, 0, '不得调用 session.commit()');
  // 折叠后 surface = [0,2,3,<checkpoint>]
  assert.equal(session.surface.nodes[SYSTEM_NODE_SEQ], SYSTEM_NODE_SEQ);
  assert.equal(session.surface.nodes.length, 4);
});

test('H-1: 对同一回合二次回退被拒绝，且不写日志', async () => {
  const { ctx, definition } = mount();
  const session = makeSession({ turnCount: 3 });

  const first = await rewind(definition, '1', session);
  assert.equal(first.kind, 'success', JSON.stringify(first));
  const appendsAfterFirst = session.appended.length;
  const before = JSON.stringify(session.log);
  const surfaceBefore = session.surface.nodes.slice();

  const second = await rewind(definition, '1', session);

  assert.equal(second.kind, 'error', JSON.stringify(second));
  assert.equal(second.text, host.internals.ERROR_TEXT.alreadyRewound);
  assert.equal(session.appended.length, appendsAfterFirst, '被拒绝的回退不应再写事件');
  expectAppendOnly(before, session);
  assert.deepEqual(session.surface.nodes, surfaceBefore, '被拒绝的回退不应改动 surface');
  assert.equal(session.committed, 0);
  assert.ok(
    ctx.logs.some((line) => line.includes('already folded away')),
    `应有守卫告警日志：${JSON.stringify(ctx.logs)}`,
  );
});

test('H-1: 无参 /rewind（最后一个回合）同样拒绝空折叠', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 2 });

  assert.equal((await rewind(definition, '1', session)).kind, 'success');
  // 此刻 turn 1 的尾部只剩 checkpoint；无参 /rewind 取最大 turn = 1 → 同一处
  const again = await rewind(definition, '', session);

  assert.equal(again.kind, 'error', JSON.stringify(again));
  assert.equal(again.text, host.internals.ERROR_TEXT.alreadyRewound);
});

test('H-1: 回退后继续对话（B6），新尾部可再次回退到更早处', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 3 });

  assert.equal((await rewind(definition, '2', session)).kind, 'success');
  const afterFirst = session.appended.length;

  // B6：回退后又有新对话 —— 新回合编号必然大于上一次 upto（design §4.3.1）。
  session.append('turn/start', { turn: 3 });
  const userSeq = session.append('user/message', { content: [{ type: 'text', text: 'new question' }], source: { kind: 'user' } }, { surfaceOp: 'append' }).seq;
  session.append('assistant/message', { content: [{ type: 'text', text: 'new answer' }], source: { kind: 'assistant' } }, { surfaceOp: 'append' });

  const second = await rewind(definition, '1', session);
  assert.equal(second.kind, 'success', `B6 应允许回退到更早处：${JSON.stringify(second)}`);
  assert.ok(session.appended.length > afterFirst);
  assert.match(session.appended.at(-1).data.content[0].text, /turn=1 upto=3/);
  assert.ok(Number.isSafeInteger(userSeq));
});

/* ------------------------------------------------------------------ */
/* 2b. H-1 的第二判据：吞掉"更晚切点"的旧 checkpoint 会让旧隐藏行复发    */
/* ------------------------------------------------------------------ */

/** 回退一次后继续对话，产出 turn 8、9 两条新消息（8 回合会话 turnCount=8 的后继）。 */
function continueConversation(session) {
  for (const turn of [8, 9]) {
    session.append('turn/start', { turn });
    session.append('user/message', { content: [{ type: 'text', text: `u${turn}` }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    session.append('assistant/message', { content: [{ type: 'text', text: `a${turn}` }] }, { surfaceOp: 'append' });
  }
}

test('H-1 幽灵路径：回退到被藏区间内部的更晚回合被拒绝', async () => {
  const { ctx, definition } = mount();
  const session = makeSession({ turnCount: 8 }); // turns 0..7

  const first = await rewind(definition, '2', session); // 藏起 [2..7]，checkpoint1
  assert.equal(first.kind, 'success', JSON.stringify(first));
  continueConversation(session); // turn 8、9 可见

  const appendsBefore = session.appended.length;
  const before = JSON.stringify(session.log);
  const surfaceBefore = session.surface.nodes.slice();

  // turn 4 的 turn/start 仍躺在 append-only 日志里，且尾部带着 8、9 的真实内容，
  // 第一判据（纯 checkpoint 尾部）拦不住它；没有第二判据时它会放行并吞掉
  // checkpoint1，客户端区间塌缩成 [4,9]，turn 2、3 的旧行解隐成幽灵。
  const ghost = await rewind(definition, '4', session);

  assert.equal(ghost.kind, 'error', `区间内部的目标必须被拒绝：${JSON.stringify(ghost)}`);
  assert.equal(ghost.text, host.internals.ERROR_TEXT.alreadyRewound);
  assert.equal(session.appended.length, appendsBefore, '被拒绝的回退不应再写事件');
  expectAppendOnly(before, session);
  assert.deepEqual(session.surface.nodes, surfaceBefore, '被拒绝的回退不应改动 surface');
  assert.ok(
    ctx.logs.some((line) => line.includes('already folded away')),
    `应有守卫告警日志：${JSON.stringify(ctx.logs)}`,
  );
});

test('H-1 放行侧：同一切点重切吞旧 checkpoint，新区间仍覆盖旧域', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 8 });

  assert.equal((await rewind(definition, '2', session)).kind, 'success');
  continueConversation(session);

  // 切点与旧 checkpoint 相同（c == targetTurn）：新 notice [2,9] ⊇ 旧 [2,7]，
  // 不会解隐任何旧行，必须放行。
  const again = await rewind(definition, '2', session);
  assert.equal(again.kind, 'success', `同一切点重切应允许：${JSON.stringify(again)}`);
  assert.match(session.appended.at(-1).data.content[0].text, /turn=2 upto=9/);
});

test('H-1 放行侧：回退到比新回合更早、但仍在旧区间之外的切点', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 8 });

  assert.equal((await rewind(definition, '5', session)).kind, 'success'); // 藏 [5..7]
  continueConversation(session); // 8、9 —— 注意替身直接续到 turn 8，跳过 6/7 的重号歧义

  // 目标 8 == 新回合本身：span 从 turn 8 起，旧 checkpoint(seq 更小)不在 span 里，
  // 回退只砍新内容，合法。
  const fold8 = await rewind(definition, '8', session);
  assert.equal(fold8.kind, 'success', JSON.stringify(fold8));
  assert.match(session.appended.at(-1).data.content[0].text, /turn=8 upto=9/);
});

/* ------------------------------------------------------------------ */
/* 3. H-1 的边界：B4 compaction checkpoint 必须仍可折叠                */
/* ------------------------------------------------------------------ */

test('B4: 尾部只剩 compaction checkpoint 时仍允许折叠（H-1 不得误伤）', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 2 });
  // surface.nodes = [0,2,3,5,6]；官方 compaction 折叠 turn 1 的两条消息 → checkpoint seq 7
  pushCompactionCheckpoint(session, 5, 6);
  assert.deepEqual(session.surface.nodes, [0, 2, 3, 7]);

  const result = await rewind(definition, '1', session);

  assert.equal(result.kind, 'success', `compaction checkpoint 应可随区间折叠：${JSON.stringify(result)}`);
  const call = session.appended.at(-1);
  assert.deepEqual(call.options.surfaceOp, { op: 'replace', startSeq: 7, endSeq: 7 });
  // 折叠后 surface = [0,2,3,<rewind checkpoint>]
  assert.equal(session.surface.nodes.length, 4);
});

test('B4: isRewindCheckpoint 区分自家 checkpoint 与 compaction checkpoint', () => {
  const { isRewindCheckpoint } = host.internals;
  const ours = {
    seq: 9,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
    data: { content: [{ type: 'text', text: 'Rewound to before turn=1 upto=2: 4 messages removed from this conversation.' }], source: { kind: 'user' } },
  };
  const compaction = {
    seq: 9,
    type: 'user/message',
    surfaceOp: { op: 'replace', startSeq: 5, endSeq: 8 },
    data: { content: [{ type: 'text', text: 'Conversation compacted. Earlier messages are summarized.' }], source: { kind: 'compact-checkpoint' } },
  };
  assert.equal(isRewindCheckpoint(ours), true, '自家 checkpoint 必须被识别');
  assert.equal(isRewindCheckpoint(compaction), false, 'compaction checkpoint 不得被当成已回退');

  // 三重判据缺一不可：同类型同 origin，只改 source.kind 或只改文本都不应误判。
  assert.equal(isRewindCheckpoint({ ...ours, data: { ...ours.data, source: { kind: 'compact-checkpoint' } } }), false, 'source.kind 必须参与判别');
  assert.equal(isRewindCheckpoint({ ...ours, data: { ...ours.data, content: [{ type: 'text', text: 'no contract tokens here' }] } }), false, 'notice 契约必须参与判别');
  assert.equal(isRewindCheckpoint({ ...ours, type: 'assistant/message' }), false, '事件类型必须参与判别');
  assert.equal(isRewindCheckpoint({ ...ours, surfaceOp: 'append' }), false, 'append-origin 不是 checkpoint');
  assert.equal(isRewindCheckpoint(undefined), false);
});

/* ------------------------------------------------------------------ */
/* 4. H-2：store 缺失的降级                                              */
/* ------------------------------------------------------------------ */

test('H-2: store 缺失时在 append 之前拒绝，文案不谎称已回退', async () => {
  const { ctx, definition } = mount();
  const session = makeSession({ turnCount: 2 });
  ctx.sessions = undefined; // 两条解析路径都拿不到 store
  const before = JSON.stringify(session.log);

  const result = await rewind(definition, '1', session);

  assert.equal(result.kind, 'error', JSON.stringify(result));
  assert.equal(result.text, host.internals.ERROR_TEXT.storeMissing);
  assert.equal(session.appended.length, 0, 'store 缺失必须发生在任何写入之前');
  expectAppendOnly(before, session);
  assert.equal(session.committed, 0);
  // 文案必须诚实：会话根本没被改，不能像 PERSIST_FAILED 那样声称"已在内存回退"。
  assert.doesNotMatch(result.text, /was rewound/i, 'storeMissing 不得声称已回退');
  assert.match(result.text, /Nothing was changed/);
  assert.notEqual(result.text, host.internals.ERROR_TEXT.persistFailed);
  assert.ok(ctx.logs.some((line) => line.includes('not mounted')));
});

test('H-2: flush resolve false 仍报 PERSIST_FAILED（此时确实已写入内存）', async () => {
  const ctx = makeHostContext({ flush: async () => false });
  host.apply(ctx, undefined);
  const definition = ctx.registered[0];
  const session = makeSession({ turnCount: 2 });

  const result = await rewind(definition, '1', session);

  assert.equal(result.kind, 'error');
  assert.equal(result.text, host.internals.ERROR_TEXT.persistFailed);
  assert.equal(session.appended.length, 1, 'flush 失败发生在 append 之后');
  assert.match(result.text, /was rewound in memory but could not be saved/);
});

test('H-2: flush 抛错报 PERSIST_FAILED，不静默成功', async () => {
  const ctx = makeHostContext({ flush: async () => { throw new Error('disk full'); } });
  host.apply(ctx, undefined);
  const definition = ctx.registered[0];
  const session = makeSession({ turnCount: 2 });

  const result = await rewind(definition, '1', session);

  assert.equal(result.kind, 'error');
  assert.equal(result.text, host.internals.ERROR_TEXT.persistFailed);
});

test('H-2: resolveStore 走 ctx.sessions 直接读与 ctx.get 软探测两条路径', () => {
  const { resolveStore } = host.internals;
  const store = { flush: async () => true };
  assert.equal(resolveStore({ sessions: store, get: () => undefined }), store, '直接读应命中');
  assert.equal(resolveStore({ get: (name) => (name === 'sessions' ? store : undefined) }), store, '软探测应命中');
  assert.equal(resolveStore({ get: () => undefined }), undefined, '无 store 返回 undefined');
  assert.equal(resolveStore({ sessions: {}, get: () => undefined }), undefined, '没有 flush 的 store 不算');
  assert.equal(resolveStore(null), undefined);
});

/* ------------------------------------------------------------------ */
/* 5. 既有错误文本与单飞（防回归）                                        */
/* ------------------------------------------------------------------ */

test('host: 错误文本集合与设计 §3.1 一致', async () => {
  const { definition } = mount();
  const texts = host.internals.ERROR_TEXT;
  assert.equal(texts.usage, 'Usage: /rewind [<turn>]');
  assert.equal(texts.busy, 'Rewind is unavailable while this conversation is running, or another rewind is in flight.');
  assert.equal(texts.noSuchTurn, 'That turn is not in this conversation.');
  assert.equal(texts.nothingToRewind, 'Nothing to rewind before that turn.');

  const bad = await rewind(definition, 'x', makeSession());
  assert.deepEqual(bad, { kind: 'error', text: texts.usage });

  const missing = await rewind(definition, '9', makeSession({ turnCount: 2 }));
  assert.equal(missing.text, texts.noSuchTurn);

  const running = await rewind(definition, '', makeSession(), { status: 'running' });
  assert.equal(running.text, texts.busy);
});

test('host: 并发第二次回退报 BUSY，单飞键按 session.id 区分', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 2 });
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const original = session.append.bind(session);
  session.append = (...args) => {
    const event = original(...args);
    return gate.then(() => event);
  };

  const first = rewind(definition, '1', session);
  const second = await rewind(definition, '0', session);
  release();
  const firstResult = await first;

  assert.equal(firstResult.kind, 'success', JSON.stringify(firstResult));
  assert.equal(second.text, host.internals.ERROR_TEXT.busy);
});

test('host: session.id 为空时按 agent.id 区分，不误报 BUSY', async () => {
  const { definition } = mount();
  const a = makeSession({ turnCount: 2, sessionId: '' });
  const b = makeSession({ turnCount: 2, sessionId: '' });
  let release;
  const gate = new Promise((resolvePromise) => { release = resolvePromise; });
  const original = a.append.bind(a);
  a.append = (...args) => {
    const event = original(...args);
    return gate.then(() => event);
  };

  const first = rewind(definition, '1', a, { id: 'agent-a' });
  const second = await rewind(definition, '1', b, { id: 'agent-b' });
  release();
  const firstResult = await first;

  assert.equal(firstResult.kind, 'success', JSON.stringify(firstResult));
  assert.equal(second.kind, 'success', `不同 agent 不应被误判 BUSY：${JSON.stringify(second)}`);
});

test('B1: 回退第一个回合是允许的，node 0 系统提示被保留', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 2 });
  assert.deepEqual(session.surface.nodes, [0, 2, 3, 5, 6]);

  const result = await rewind(definition, '0', session);

  // design §5 B1：turn 0 的 turn/start 是 log-only，不在 surface 里，所以
  // span = [2,3,5,6] 从 index 1 起 —— 不含受保护的 node 0，回退成立。
  assert.equal(result.kind, 'success', `B1 应允许回退第一个回合：${JSON.stringify(result)}`);
  assert.match(result.text, /turn=0 upto=1: 4 messages removed/);
  assert.equal(session.surface.nodes[0], SYSTEM_NODE_SEQ, 'node 0 必须存活');
  assert.equal(session.surface.nodes.length, 2, 'surface 应只剩 node 0 + checkpoint');
});

test('保护分支: span 含 node 0 时 computeSpan 返回 protected', () => {
  // 防御性分支：真实日志里 node 0 恒为 system/message，`turn/start` 不会是 seq 0，
  // 因此这条只能直接打代数函数来覆盖（SYSTEM_PROTECTED 的语义是"意外包含 node 0"）。
  const { computeSpan } = host.internals;
  const nodes = [0, 1, 2, 3];
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 0 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: {} },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: {} },
    { seq: 3, type: 'turn/start', data: { turn: 1 } },
  ];
  assert.deepEqual(computeSpan(nodes, 0, events), { kind: 'protected' });
  // 尾部连续性与空尾部的两条既有分支
  assert.deepEqual(computeSpan(nodes, 4, events), { kind: 'nothing' });
  // `unexpected` 只在 span 之后还挂着低 seq 节点时成立（surface 乱序 = 历史被
  // 并发改动，design §5 B11）。注意 span 本身是 `filter(seq >= turnStartSeq)`，
  // 所以"乱序"必须是把小 seq 排到尾部之后，否则连续性计数依然通过。
  assert.equal(computeSpan([0, 2, 3, 1], 2, events).kind, 'unexpected');
  assert.equal(computeSpan(nodes, 1, events).kind, 'ok');
});

/* ------------------------------------------------------------------ */
/* 6. 跨端文本契约 + 硬约束（静态）                                       */
/* ------------------------------------------------------------------ */

test('契约: notice 模板逐字保留 turn=<n> upto=<m>，两侧无空格', async () => {
  const { definition } = mount();
  const session = makeSession({ turnCount: 4 });
  const result = await rewind(definition, '2', session);
  assert.equal(result.kind, 'success');

  const text = session.appended[0].data.content[0].text;
  assert.match(text, /\bturn=(\d+)\b/);
  assert.match(text, /\bupto=(\d+)\b/);
  assert.equal(Number(/\bturn=(\d+)\b/.exec(text)[1]), 2);
  assert.equal(Number(/\bupto=(\d+)\b/.exec(text)[1]), 3);
  assert.doesNotMatch(text, /turn\s+=|turn=\s+/);
  assert.doesNotMatch(text, /upto\s+=|upto=\s+/);
  assert.doesNotMatch(text, /undefined|NaN/);
  // 顺序固定 turn= 在前、upto= 在后
  assert.ok(text.indexOf('turn=') < text.indexOf('upto='));
  assert.ok(hostSource.includes('turn=${boundary.turn} upto=${upperTurn}'), 'host 模板缺少两个契约 token');
});

test('硬约束: 宿主半边不新增 RPC/端点/状态文件，不写 commit', () => {
  // 只扫**代码**：模块头的注释本来就在声明"不碰 .jsonl / 不 commit"，
  // 连注释一起扫会产生假阳性，把契约说明当成违规。
  const code = hostSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:"'\\])\/\/[^\n]*/g, '$1');

  const banned = [
    'session.commit(',
    '.commit()',
    'createServer',
    'writeFileSync',
    'appendFileSync',
    '.jsonl',
    'ctx.router',
    'ctx.middleware',
    'ctx.provide',
  ];
  for (const needle of banned) {
    assert.ok(!code.includes(needle), `lib/host.js 代码中出现被禁用的 ${needle}`);
  }
  assert.ok(!/^\s*import\s/m.test(code), '宿主半边不得 import 任何运行时包');
  // 唯一的写入口仍是 session.append + store.flush
  assert.ok(code.includes('session.append(MESSAGE_EVENT_TYPE'), 'append 调用形态改变');
  assert.ok(code.includes('store.flush(session)'), 'flush 调用形态改变');
});
