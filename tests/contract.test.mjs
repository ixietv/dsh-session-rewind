/**
 * 跨端契约回归（tests/ 私有，不随包发布）。
 *
 * 这是整个插件唯一的跨页面重建依据：宿主写进 checkpoint 的 notice 文本
 * `Rewound to before turn=<n> upto=<m>: <k> messages removed from this conversation.`
 * 必须被客户端的 `/\bturn=(\d+)\b/` 与 `/\bupto=(\d+)\b/` 原样解回闭区间
 * `[cutTurn, shadedUpto]`（design §3.1 格式硬约束、§4.3.1）。
 *
 * 与 host.test.mjs / client.test.mjs 的区别：这里**不用手写的期望字符串**，而是把
 * 宿主 handler 真实产出的那个 event 直接交给客户端解析，并驱动到 DOM 隐藏结果为止。
 * 任何一边改动拼写、`=` 两侧空格或数字格式，本文件立即失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { makeSession, makeHostContext } from './helpers/session.mjs';
import { makeWorld, loadClient, tickIntervals, resetTimers } from './helpers/dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const hostSource = readFileSync(resolve(ROOT, 'lib/host.js'), 'utf8');
const clientSource = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');

const host = await import(pathToFileURL(resolve(ROOT, 'lib/host.js')).href);

/** 真实跑一次 /rewind，返回宿主写入的 checkpoint 事件。 */
async function rewindOnce(turnCount, rawInput) {
  const ctx = makeHostContext();
  host.apply(ctx, undefined);
  const definition = ctx.registered[0];
  const session = makeSession({ turnCount });
  const result = await definition.handler({ rawInput, agent: { status: 'idle', session } });
  assert.equal(result.kind, 'success', `回退应成功：${JSON.stringify(result)}`);
  const call = session.appended.at(-1);
  return {
    result,
    text: call.data.content[0].text,
    event: { seq: session.log.length - 1, type: call.type, data: call.data, surfaceOp: call.options.surfaceOp },
  };
}

/* ------------------------------------------------------------------ */
/* 1. 宿主真实文本 → 客户端解析 → DOM 隐藏结果                            */
/* ------------------------------------------------------------------ */

test('跨端: 宿主 /rewind 2（4 回合）的 notice 被客户端解成 [2,3] 并隐藏 2/3', async () => {
  const { text, event } = await rewindOnce(4, '2');
  assert.match(text, /^Rewound to before turn=2 upto=3: \d+ messages removed from this conversation\.$/);

  resetTimers();
  const world = makeWorld([[0, 1, 2, 3]]);
  const client = loadClient(clientSource, world);

  const mark = client.exports.checkpointTurn(event);
  assert.notEqual(mark, null, '客户端拒绝了宿主刚写的 checkpoint 事件');
  assert.equal(mark.cutTurn, 2);
  assert.equal(mark.shadedUpto, 3);

  client.exports.setHiderCutTurn(mark.cutTurn, 'session-a', mark.shadedUpto);
  tickIntervals();
  assert.deepEqual(world.hiddenIn(0), [2, 3], `跨端隐藏结果不符：${world.state()}`);
});

test('跨端: 宿主 /rewind 0（2 回合）的 notice 解成 [0,1]', async () => {
  const { text, event } = await rewindOnce(2, '0');
  assert.match(text, /turn=0 upto=1/);

  resetTimers();
  const world = makeWorld([[0, 1]]);
  const client = loadClient(clientSource, world);
  const mark = client.exports.checkpointTurn(event);
  assert.equal(mark.cutTurn, 0);
  assert.equal(mark.shadedUpto, 1);

  client.exports.setHiderCutTurn(mark.cutTurn, 'session-a', mark.shadedUpto);
  tickIntervals();
  assert.deepEqual(world.hiddenIn(0), [0, 1], world.state());
});

test('跨端: 单条消息的单数拼写（"1 message removed"）同样可解析', async () => {
  // turnCount=2 回退 turn 1 → span 只有 1 个节点时才是单数；用 3 回合回退 turn 2
  // 得到 2 条，故这里直接验证宿主的单复数分支不破坏 token 契约。
  const ctx = makeHostContext();
  host.apply(ctx, undefined);
  const session = makeSession({ turnCount: 2 });
  // surface.nodes = [0,2,3,5,6]；回退 turn 1 → span [5,6] = 2 条（复数）
  await ctx.registered[0].handler({ rawInput: '1', agent: { status: 'idle', session } });
  const plural = session.appended.at(-1).data.content[0].text;
  assert.match(plural, /: 2 messages removed/);

  // 单数分支：手工构造一个只剩 1 个节点的尾部
  const single = makeSession({ turnCount: 1 });
  single.append('turn/start', { turn: 1 });
  const userSeq = single.append('user/message', { content: [{ type: 'text', text: 'q' }], source: { kind: 'user' } }, { surfaceOp: 'append' }).seq;
  await ctx.registered[0].handler({ rawInput: '1', agent: { status: 'idle', session: single } });
  const singular = single.appended.at(-1).data.content[0].text;
  assert.match(singular, /: 1 message removed from this conversation\.$/);
  assert.match(singular, /\bturn=1 upto=1\b/);
  assert.ok(Number.isSafeInteger(userSeq));
});

/* ------------------------------------------------------------------ */
/* 2. 契约的静态双向锁定                                                 */
/* ------------------------------------------------------------------ */

test('跨端: 两半使用同一对 token 正则，宿主模板顺序固定', () => {
  // 客户端必须持有两条正则字面量
  assert.ok(clientSource.includes('/\\bturn=(\\d+)\\b/'), 'client 缺少 turn= 正则字面量');
  assert.ok(clientSource.includes('/\\bupto=(\\d+)\\b/'), 'client 缺少 upto= 正则字面量');
  // 宿主模板必须两个 token 背靠背、`=` 紧贴数字
  assert.ok(hostSource.includes('turn=${boundary.turn} upto=${upperTurn}'), 'host 模板缺少 `turn=<n> upto=<m>`');

  const probe = 'Rewound to before turn=7 upto=9: 2 messages removed from this conversation.';
  assert.equal(/\bturn=(\d+)\b/.exec(probe)[1], '7');
  assert.equal(/\bupto=(\d+)\b/.exec(probe)[1], '9');
});

test('跨端: 宿主 notice 渲染后 = 两侧无空格、无 undefined/NaN、顺序 turn 在前', async () => {
  const { text } = await rewindOnce(5, '3');
  assert.doesNotMatch(text, /turn\s+=|turn=\s+/, 'turn= 两侧有空格');
  assert.doesNotMatch(text, /upto\s+=|upto=\s+/, 'upto= 两侧有空格');
  assert.doesNotMatch(text, /undefined|NaN/, 'notice 渲染出 undefined/NaN');
  assert.ok(text.indexOf('turn=') < text.indexOf('upto='), '两个 token 顺序必须是 turn= 在前');
  assert.match(text, /\bturn=3\b/, `下界应为目标回合：${text}`);
  assert.match(text, /\bupto=4\b/, `上界应为日志最大回合：${text}`);
});

test('跨端: upto= 上界恒 >= turn= 下界（闭区间不倒挂）', async () => {
  for (const [turnCount, rawInput] of [[2, '0'], [3, '1'], [4, '2'], [6, '0']]) {
    const { text } = await rewindOnce(turnCount, rawInput);
    const cut = Number(/\bturn=(\d+)\b/.exec(text)[1]);
    const upto = Number(/\bupto=(\d+)\b/.exec(text)[1]);
    assert.ok(upto >= cut, `turnCount=${turnCount} input=${rawInput}: upto=${upto} < turn=${cut}`);
  }
});

/* ------------------------------------------------------------------ */
/* 3. 硬约束：无新增 RPC/端点/状态文件，exports 四键形态不变              */
/* ------------------------------------------------------------------ */

test('硬约束: package.json exports 保持四键，files/cordis.patch.yml 不变', () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['.', './client', './cordis.patch.yml', './package.json']);
  assert.equal(pkg.exports['.'], './lib/host.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml');
  assert.equal(pkg.exports['./package.json'], './package.json');
  assert.equal(pkg.main, 'lib/host.js');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.files, ['lib', 'cordis.patch.yml']);
  assert.deepEqual(pkg.dsh, { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } });

  const patch = readFileSync(resolve(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /- insert:/);
  assert.match(patch, /id: session-rewind/);
  assert.match(patch, /name: 'dsh-session-rewind'/);
  // 只扫指令行：文件头的注释本身就在声明"不引入 override/disabled/isolate"，
  // 连注释一起扫会把契约说明当成违规。
  const directives = patch.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(directives, /override|disabled|isolate/, 'patch 指令不得引入 override/disabled/isolate');
  assert.deepEqual(
    directives.split('\n').map((line) => line.trim()).filter(Boolean),
    ['- insert:', '- id: session-rewind', "name: 'dsh-session-rewind'"],
    'cordis.patch.yml 指令形态改变',
  );
});

test('硬约束: 两半都不新增 RPC 端点、状态文件或 session.commit()', () => {
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:"'\\])\/\/[^\n]*/g, '$1');
  const banned = ['createServer', 'writeFileSync', 'appendFileSync', 'mkdirSync', '.jsonl', 'ctx.router', 'ctx.middleware', 'session.end-seed', 'session/title'];
  for (const [file, src] of [['lib/host.js', hostSource], ['lib/client.js', clientSource]]) {
    const code = stripComments(src);
    for (const needle of banned) {
      assert.ok(!code.includes(needle), `${file} 代码中出现被禁用的 ${needle}`);
    }
  }
  // 宿主半边零 import；客户端只 require('react')
  assert.doesNotMatch(stripComments(hostSource), /^\s*import\s/m, 'lib/host.js 不得 import 运行时包');
  assert.deepEqual([...clientSource.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]), ['react']);
});
