/**
 * 宿主测试用的 `Session` 替身（tests/ 私有，不随包发布）。
 *
 * 它与旧 harness 里"`surface.nodes` = 全部 seq"的写法不同，按官方 surface 投影的
 * 真实语义重建，因为 H-1 守卫的正确性完全取决于折叠后 surface 长什么样：
 *
 * - `turn/start` 是 **log-only** 事件，不进 surface（design §4.3.1：turn 号是日志
 *   概念，`surfaceOp: 'replace'` 只折叠 surface 节点，既不删日志也不回退计数器）；
 * - 消息事件以 `surfaceOp: 'append'` 进入 surface，seq 追加到 `nodes`；
 * - 折叠事件按 `applySurfacePlan`（`dsh-session/lib/index.js:463-470`）的
 *   `nodes.splice(startIdx, endIdx - startIdx + 1, checkpointSeq)` 执行 ——
 *   被折叠区间由 checkpoint **自己的 seq** 取代，区间内旧节点从 surface 消失，
 *   但日志里的事件一条不少（append-only）。
 *
 * 只有把这三条都做对，"回退一次之后再回退到同一处"才会真实地退化成
 * "尾部只剩上一个 checkpoint"，H-1 守卫才有可测的对象。
 */

/** 受保护的 node 0：官方会话开头的系统节点（design §5 B1，`surface.js:376-391`）。 */
export const SYSTEM_NODE_SEQ = 0;

/**
 * 造一个会话替身。
 *
 * @param options.turnCount - 回合数；每回合产生 turn/start + user + assistant 三条事件。
 * @param options.sessionId - `session.id`；置空串可覆盖单飞键回退到 agent id 的分支。
 * @returns `{ log, surface, appended, flushes, append, commit, ... }`
 */
export function makeSession({ turnCount = 2, sessionId = 'sess-1' } = {}) {
  const log = [];
  const nodes = [];
  let seq = 0;

  const session = {
    id: sessionId,
    log,
    surface: { nodes },
    /** 每次 `append` 的入参留痕，供断言 surfaceOp / sourceEventSeqs。 */
    appended: [],
    /** `commit()` 调用次数；硬约束要求它恒为 0。 */
    committed: 0,

    append(type, data, options) {
      const event = { seq: log.length, type, data };
      const op = options === undefined || options === null ? undefined : options.surfaceOp;
      if (op !== undefined) event.surfaceOp = op;
      log.push(event);
      applySurface(event);
      session.appended.push({ type, data, options });
      return event;
    },

    commit() {
      session.committed += 1;
    },
  };

  /** 把一条已入日志的事件投影到 surface（append / replace 两种形态）。 */
  function applySurface(event) {
    const op = event.surfaceOp;
    if (op === undefined) return; // log-only：turn/start 等
    if (op === 'append') {
      nodes.push(event.seq);
      return;
    }
    if (typeof op === 'object' && op !== null && op.op === 'replace') {
      const startIdx = nodes.indexOf(op.startSeq);
      const endIdx = nodes.indexOf(op.endSeq);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        throw new Error(`invalid replace range ${op.startSeq}..${op.endSeq}`);
      }
      nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
    }
  }

  // node 0：系统提示，受保护，不得被任何回退区间包含。
  push('system/message', { content: [{ type: 'text', text: 'system prompt' }] }, 'append');
  for (let turn = 0; turn < turnCount; turn += 1) {
    push('turn/start', { turn }); // log-only
    push('user/message', { content: [{ type: 'text', text: `user turn ${turn}` }] }, 'append');
    push('assistant/message', { content: [{ type: 'text', text: `assistant turn ${turn}` }] }, 'append');
  }

  function push(type, data, surfaceOp) {
    const event = { seq, type, data };
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
    log.push(event);
    applySurface(event);
    seq += 1;
    return event;
  }

  return session;
}

/**
 * 在会话里插入一个**官方 compaction** checkpoint（design §5 B4）。
 *
 * 它与本插件的 rewind checkpoint 几乎同形：官方判别式
 * `isCompactionCheckpoint`（`ui-chat/lib/types/client/conversation-nodes/message.js`）
 * 是 `type === "user/message"` **且** replace-origin **且**
 * `data.source.kind === "compact-checkpoint"`。也就是说两者的事件类型相同、
 * surfaceOp 形态相同，**唯一的差别是 `source.kind` 与 notice 文本**。
 *
 * 这正是 H-1 守卫必须用三重判据（类型 + source.kind + `turn=<n> upto=<m>` 文本）
 * 而非"任何 replace-origin"来识别自家 checkpoint 的原因：只看 origin 会把
 * compaction checkpoint 一起拒掉，而 B4 实测回退区间会**连同它一起折叠**。
 *
 * @param session - `makeSession` 的产物。
 * @param fromSeq - 折叠区间下界。
 * @param toSeq - 折叠区间上界。
 * @returns checkpoint 事件。
 */
export function pushCompactionCheckpoint(session, fromSeq, toSeq) {
  return session.append(
    'user/message',
    {
      content: [{ type: 'text', text: 'Conversation compacted. Earlier messages are summarized.' }],
      source: { kind: 'compact-checkpoint' },
    },
    { surfaceOp: { op: 'replace', startSeq: fromSeq, endSeq: toSeq }, sourceEventSeqs: range(fromSeq, toSeq) },
  );
}

/** 闭区间 seq 列表。 */
export function range(from, to) {
  const out = [];
  for (let value = from; value <= to; value += 1) out.push(value);
  return out;
}

/**
 * 造一个 Cordis 上下文替身，暴露 commands / sessions / logger。
 *
 * `ctx.sessions` 是**直接读**的形状（`inject` 已声明 `sessions`，健康组合下访问器
 * 已挂载）；`ctx.get('sessions')` 同时保留，覆盖 `resolveStore` 的软探测回退路径。
 *
 * @param options.flush - `sessions.flush` 的实现；缺省记录调用并 resolve `true`。
 * @returns `{ ctx, logs, registered, flushCalls }`
 */
export function makeHostContext({ flush } = {}) {
  const logs = [];
  const registered = [];
  const state = { flushCalls: 0 };

  const logger = {
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
    error: (message) => logs.push(`error:${message}`),
  };

  const ctx = {
    logs,
    registered,
    get flushCalls() {
      return state.flushCalls;
    },
    sessions: undefined,
    get(name) {
      if (name === 'commands') {
        return {
          register: (definition) => {
            registered.push(definition);
            return () => {};
          },
        };
      }
      if (name === 'logger') return logger;
      if (name === 'sessions') return ctx.sessions;
      return undefined;
    },
    effect: (fn) => fn(),
    logger,
  };

  ctx.sessions = {
    flush:
      flush === undefined
        ? async () => {
            state.flushCalls += 1;
            return true;
          }
        : flush,
  };

  return ctx;
}
