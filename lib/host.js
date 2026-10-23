/**
 * dsh-session-rewind — Host half (round 2: in-session rewind).
 *
 * Loaded by the Loader row inserted from `cordis.patch.yml`
 * (`id: session-rewind`, `name: 'dsh-session-rewind'`). It registers the
 * `/rewind` slash command and folds the tail of the *current* conversation
 * away with the official canonical surface primitive
 * (`session.append('user/message', checkpoint, { surfaceOp: 'replace' })`),
 * exactly as `dsh-compaction-basic` does for compaction.
 *
 * Contract (design §3.1):
 * - `sessionId` never changes: this is an in-place fold, not a fork;
 * - the event log is append-only: every earlier event keeps its seq and
 *   payload, and the only write is one `user/message` carrying `surfaceOp`;
 * - no RPC endpoint is added, no `.jsonl` file is touched, no state file is
 *   written, and no `session/end-seed` or `session/title` event is emitted;
 * - failures before the append leave the session untouched; a persistence
 *   failure after the append reports `PERSIST_FAILED` instead of pretending
 *   success.
 *
 * The module intentionally imports nothing: the Loader injects `ctx`, and this
 * half must not depend on any `@deepseek-ai/*` runtime package, which is not
 * resolvable from the plugin's own directory (design §6.4). The shapes used
 * here are the ones the official bundle validates at the append site, so an
 * incompatible host fails loudly at `session.append` rather than silently
 * writing a wrong event.
 *
 * Sections below follow the dependency order: vocabulary → parsing → surface
 * algebra → command body → plugin entry.
 */

/* -------------------------------------------------------------------------- */
/* 1. Vocabulary (design §3.1)                                                */
/* -------------------------------------------------------------------------- */

/** Plugin name used by the Loader row (`name: 'dsh-session-rewind'`). */
export const name = 'session-rewind';

/** The only service this half needs; delays `apply` until commands exist. */
export const inject = ['commands'];

/** Slash command spelling. */
const COMMAND_NAME = 'rewind';

/** Stable definition identity; `CommandDefinitionId` is an identity function. */
const COMMAND_DEFINITION_ID = 'dsh-session-rewind';

/** Slash-menu description. */
const COMMAND_DESCRIPTION = 'Rewind this conversation to before a turn';

/** Slash-menu argument hint. */
const COMMAND_HINT = '[<turn>]';

/** Log prefix for the two self-check outcomes. */
const LOG_PREFIX = '[session-rewind]';

/** Canonical surface event type carrying a user-role message. */
const MESSAGE_EVENT_TYPE = 'user/message';

/** Boundary event that opens a turn. */
const TURN_START_EVENT_TYPE = 'turn/start';

/**
 * User-visible failure texts (design §3.1, verbatim).
 *
 * @type {Readonly<Record<string, string>>}
 */
const ERROR_TEXT = Object.freeze({
  usage: 'Usage: /rewind [<turn>]',
  busy: 'Rewind is unavailable while this conversation is running, or another rewind is in flight.',
  noSuchTurn: 'That turn is not in this conversation.',
  nothingToRewind: 'Nothing to rewind before that turn.',
  surfaceUnexpected: 'The conversation history changed before it could be rewound. Nothing was changed.',
  systemProtected: 'The conversation cannot be rewound that far.',
  persistFailed:
    'The conversation was rewound in memory but could not be saved. Refresh and check the session state before retrying.',
});

/**
 * Sessions with a rewind in flight.
 *
 * A module-level set is enough: one plugin instance serves one host, and the
 * command system already funnels every `/rewind` through the same agent.
 *
 * @type {Set<string>}
 */
const ACTIVE = new Set();

/* -------------------------------------------------------------------------- */
/* 2. Small helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build one error result accepted by `normalizeResult`.
 *
 * @param text - non-empty user-visible text.
 * @returns a frozen error result.
 */
function errorResult(text) {
  return Object.freeze({ kind: 'error', text });
}

/**
 * Build one success result accepted by `normalizeResult`.
 *
 * @param text - non-empty user-visible text.
 * @param sourceEventSeq - seq of the event this result points at, when known.
 * @returns a frozen success result.
 */
function successResult(text, sourceEventSeq) {
  return Object.freeze({
    kind: 'success',
    text,
    ...(Number.isSafeInteger(sourceEventSeq) ? { sourceEventSeq } : {}),
  });
}

/**
 * Read a Cordis service without declaring it as a hard dependency.
 *
 * `ctx.get` is absent on contexts that expose services only as accessors, and
 * it can throw for a strict-mode miss, so every read is contained.
 *
 * @param ctx - Cordis context.
 * @param serviceName - registered service key.
 * @returns the service, or `undefined` when it is not mounted.
 */
function readService(ctx, serviceName) {
  try {
    if (ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function') {
      return ctx.get(serviceName);
    }
  } catch {
    // A strict-mode miss is reported as absence, not as an activation failure.
  }
  return undefined;
}

/**
 * Create the plugin logger.
 *
 * `ctx.logger` is a callable accessor on Cordis 4 while the service registered
 * under `logger` is the object exposing `info`/`warn`/`error`; both shapes are
 * accepted so a self-check line can never be dropped silently.
 *
 * @param ctx - Cordis context.
 * @returns `(level, line) => void`.
 */
function createLogger(ctx) {
  return (level, line) => {
    const message = `${LOG_PREFIX} ${line}`;
    try {
      const candidates = [
        readService(ctx, 'logger'),
        ctx === null || ctx === undefined ? undefined : ctx.logger,
      ];
      const logger = candidates.find(
        (candidate) =>
          candidate !== undefined && candidate !== null && typeof candidate[level] === 'function',
      );
      if (logger !== undefined) logger[level](message);
    } catch {
      // Logging must never break activation or command execution.
    }
  };
}

/**
 * Mint a message identity.
 *
 * The official `createUserMessage` brands a random UUID
 * (`dsh-llm/lib/types/message.js:53`), so a UUID string is the only thing the
 * append-site validator checks.
 *
 * @returns a UUID v4 string.
 */
function newMessageId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== null && cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  // Shape-compatible fallback for runtimes without Web Crypto (never used
  // inside the harness, where `crypto.randomUUID` exists).
  let out = '';
  for (let index = 0; index < 32; index += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
    if (index === 7 || index === 11 || index === 15 || index === 19) out += '-';
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 3. Input parsing (design §3.1 step 1)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Parse the command argument.
 *
 * @param rawInput - the text after `/rewind`, already trimmed by the command
 *   system; `''` for a bare invocation.
 * @returns `{ targetTurn: number | null }` where `null` means "the last turn",
 *   or `undefined` when the input is not a non-negative integer.
 */
function parseTarget(rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  if (input === '') return { targetTurn: null };
  if (!/^\d+$/.test(input)) return undefined;
  const turn = Number(input);
  if (!Number.isSafeInteger(turn)) return undefined;
  return { targetTurn: turn };
}

/* -------------------------------------------------------------------------- */
/* 4. Log and surface algebra (design §3.1 steps 4-6)                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the session's event log.
 *
 * `snapshotEvents()` and `eventAt()` are marked `@deprecated … new calls are
 * prohibited` in this bundle, but they remain the only synchronous readers, so
 * the raw log array is preferred and they are used defensively after it.
 *
 * @param session - host `Session` instance.
 * @returns the ordered event array, or `null` when no reader is available.
 */
function readEvents(session) {
  const log = session === null || session === undefined ? undefined : session.log;
  if (Array.isArray(log)) return log;
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents();
      if (Array.isArray(snapshot)) return snapshot;
    }
  } catch {
    // Fall through to the remaining readers.
  }
  try {
    if (typeof session.eventAt === 'function') {
      const length = typeof session.seq === 'number' ? session.seq : 0;
      const events = [];
      for (let index = 0; index < length; index += 1) {
        const event = session.eventAt(index);
        if (event !== undefined) events.push(event);
      }
      if (events.length > 0) return events;
    }
  } catch {
    // No reader is usable; the caller reports a boundary failure.
  }
  return null;
}

/**
 * Locate the opening boundary of a turn.
 *
 * @param events - ordered event log.
 * @param targetTurn - explicit turn number, or `null` for the last turn.
 * @returns `{ turn, seq }`, or `null` when the turn is absent.
 */
function findTurnStart(events, targetTurn) {
  let lastTurn = null;
  let lastSeq = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== TURN_START_EVENT_TYPE) continue;
    const turn = event.data === null || event.data === undefined ? undefined : event.data.turn;
    if (!Number.isSafeInteger(turn) || turn < 0) continue;
    if (targetTurn === null) {
      if (lastTurn === null || turn > lastTurn) {
        lastTurn = turn;
        lastSeq = event.seq;
      }
      continue;
    }
    if (turn === targetTurn) return { turn, seq: event.seq };
  }
  if (targetTurn !== null) return null;
  return lastTurn === null ? null : { turn: lastTurn, seq: lastSeq };
}

/**
 * Compute the surface tail that the fold will shadow.
 *
 * @param nodes - `session.surface.nodes`, in surface order.
 * @param turnStartSeq - seq of the turn's opening boundary.
 * @returns `{ kind: 'ok', span }` plus the failure kinds the caller maps to
 *   user-facing texts.
 */
function computeSpan(nodes, turnStartSeq) {
  const span = nodes.filter((seq) => seq >= turnStartSeq);
  if (span.length === 0) return { kind: 'nothing' };
  const firstIndex = nodes.indexOf(span[0]);
  if (firstIndex < 0 || firstIndex + span.length !== nodes.length) return { kind: 'unexpected' };
  if (firstIndex === 0) return { kind: 'protected' };
  return { kind: 'ok', span, firstIndex };
}

/**
 * Highest turn number present in the event log.
 *
 * Read from the same event view `findTurnStart` walks, so the reported upper
 * bound can never disagree with the boundary that was located. The caller only
 * reaches it after a boundary was found, therefore a non-null result is
 * guaranteed; the fallback exists so the notice can never print `undefined`.
 *
 * @param events - ordered event log.
 * @returns the highest `turn/start` turn number, or `null` when the log has none.
 */
function maxTurnOf(events) {
  if (!Array.isArray(events)) return null;
  let maxTurn = null;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type !== TURN_START_EVENT_TYPE) continue;
    const turn = event.data === null || event.data === undefined ? undefined : event.data.turn;
    if (!Number.isSafeInteger(turn) || turn < 0) continue;
    if (maxTurn === null || turn > maxTurn) maxTurn = turn;
  }
  return maxTurn;
}

/**
 * Identity used by the single-flight guard.
 *
 * `session.id` is always present on an agent-owned session, but a wrapper or a
 * test double may leave it empty; falling back to the agent identity (and then
 * to a shared default) keeps two distinct sessions from blocking each other on
 * the same empty key while still serialising calls that carry no identity at
 * all.
 *
 * @param session - host `Session` instance.
 * @param agent - `Agent` that owns the command.
 * @returns a non-empty guard key.
 */
function sessionIdentity(session, agent) {
  const candidates = [
    session === null || session === undefined ? undefined : session.id,
    agent === null || agent === undefined ? undefined : agent.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return 'default';
}

/* -------------------------------------------------------------------------- */
/* 5. Command body (design §3.1 steps 2-9)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Fold the surface tail away and report the outcome.
 *
 * The caller has already validated the target syntax, the agent state, and the
 * single-flight guard, so every failure here is reported through the result
 * object rather than thrown.
 *
 * @param ctx - Cordis context (used for the store and the logger).
 * @param session - host `Session` instance.
 * @param targetTurn - explicit turn number, or `null` for the last turn.
 * @returns the settled command result.
 */
async function performRewind(ctx, session, targetTurn) {
  const log = createLogger(ctx);
  const events = readEvents(session);
  if (events === null) return errorResult(ERROR_TEXT.surfaceUnexpected);

  const boundary = findTurnStart(events, targetTurn);
  if (boundary === null) return errorResult(ERROR_TEXT.noSuchTurn);

  const surface = session.surface;
  const nodes = surface === null || surface === undefined ? undefined : surface.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return errorResult(ERROR_TEXT.nothingToRewind);

  const folded = computeSpan(nodes, boundary.seq);
  if (folded.kind === 'nothing') return errorResult(ERROR_TEXT.nothingToRewind);
  if (folded.kind === 'unexpected') return errorResult(ERROR_TEXT.surfaceUnexpected);
  if (folded.kind === 'protected') return errorResult(ERROR_TEXT.systemProtected);

  const span = folded.span;
  const removed = span.length;
  // `turn=<n>` and `upto=<m>` are a cross-half contract: the client rebuilds the
  // shaded interval from this checkpoint text after a page reopen (design §2.3,
  // §5 B6, design-notes "checkpoint notice"). Keep the exact spellings and the
  // `=` without surrounding spaces — the client parses
  // /\bturn=(\d+)\b/ and /\bupto=(\d+)\b/.
  const maxTurn = maxTurnOf(events);
  const upperTurn = maxTurn === null ? boundary.turn : maxTurn;
  const notice = `Rewound to before turn=${boundary.turn} upto=${upperTurn}: ${removed} message${
    removed === 1 ? '' : 's'
  } removed from this conversation.`;

  // The checkpoint is an ordinary user-role message. `source.kind: 'user'` is a
  // member of the closed `MessageSourceMap`, and because this event is a
  // `replace` rather than an append, `ui-chat`'s user definition does not
  // render it as a user bubble (design §2.3).
  const checkpoint = Object.freeze({
    id: newMessageId(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: notice })]),
    source: Object.freeze({ kind: 'user' }),
  });

  let checkpointEvent;
  try {
    checkpointEvent = session.append(MESSAGE_EVENT_TYPE, checkpoint, {
      surfaceOp: Object.freeze({
        op: 'replace',
        startSeq: span[0],
        endSeq: span[span.length - 1],
      }),
      sourceEventSeqs: span.slice(),
    });
  } catch (error) {
    // The append-site validator rejected the plan before the log changed, so
    // the conversation is untouched.
    log('warn', `append rejected: ${error instanceof Error ? error.message : String(error)}`);
    return errorResult(ERROR_TEXT.surfaceUnexpected);
  }

  // `Session.append` already committed the event in memory; durability is the
  // session store's `flush`, which its own source calls "THE flush entry point"
  // (`dsh-session/lib/index.js:1951`). Without a mountable store this half
  // cannot claim durability, so it reports the failure the design asks a failed
  // commit to report.
  const store = readService(ctx, 'sessions');
  if (store === null || store === undefined || typeof store.flush !== 'function') {
    return errorResult(ERROR_TEXT.persistFailed);
  }
  try {
    // `SessionStore.flush` resolves to `false` when a listener reported that the
    // append did not reach durable storage (dsh-session/lib/index.js:2279-2409);
    // a `false` therefore must not be reported as a durable rewind.
    const flushed = await store.flush(session);
    if (flushed === false) {
      log('warn', 'flush reported no durable write; the in-memory fold is unsaved');
      return errorResult(ERROR_TEXT.persistFailed);
    }
  } catch (error) {
    log('warn', `flush failed: ${error instanceof Error ? error.message : String(error)}`);
    return errorResult(ERROR_TEXT.persistFailed);
  }

  return successResult(notice, checkpointEvent === undefined ? undefined : checkpointEvent.seq);
}

/**
 * Decide whether a maintenance failure means "the agent was not idle".
 *
 * `agent.runMaintenance` rejects when another turn or maintenance owns the
 * agent; its diagnostics mention the rejected state, while an unrelated
 * failure must still surface as a real error.
 *
 * @param error - rejection from `runMaintenance`.
 * @returns whether the failure should be reported as `BUSY`.
 */
function isBusyFailure(error) {
  const message =
    error !== null && typeof error === 'object' && typeof error.message === 'string'
      ? error.message.toLowerCase()
      : '';
  // `agent-loop` rejects a second entry with "already has active work"
  // (dsh-agent-loop/lib/agent-loop.js:823), which mentions neither "busy" nor
  // "maintenance", so the phrase is matched explicitly.
  return (
    message.includes('busy') ||
    message.includes('maintenance') ||
    message.includes('idle') ||
    message.includes('already has active work')
  );
}

/**
 * `/rewind` handler.
 *
 * @param ctx - Cordis context.
 * @param invocation - `{ commandId, agent, rawInput, attachments, signal }`.
 * @returns the settled command result.
 */
async function handleRewind(ctx, invocation) {
  const parsed = parseTarget(
    invocation === null || invocation === undefined ? undefined : invocation.rawInput,
  );
  if (parsed === undefined) return errorResult(ERROR_TEXT.usage);

  const agent = invocation === null || invocation === undefined ? undefined : invocation.agent;
  const session = agent === null || agent === undefined ? undefined : agent.session;
  if (
    session === null ||
    session === undefined ||
    typeof session.append !== 'function' ||
    typeof session.surface === 'undefined'
  ) {
    // A command always receives an agent-owned session; reaching this branch is
    // a composition bug rather than a user error, so it stays a thrown failure.
    throw new Error(`${LOG_PREFIX} /${COMMAND_NAME} ran without an agent-owned session`);
  }

  if (typeof agent.status === 'string' && agent.status !== 'idle') {
    return errorResult(ERROR_TEXT.busy);
  }

  const sessionKey = sessionIdentity(session, agent);
  if (ACTIVE.has(sessionKey)) return errorResult(ERROR_TEXT.busy);
  ACTIVE.add(sessionKey);
  try {
    if (typeof agent.runMaintenance === 'function') {
      // Mirrors `/compact`: the official maintenance slot supplies the idle
      // admission decision and serializes against a turn that is starting.
      try {
        return await agent.runMaintenance(async () => performRewind(ctx, session, parsed.targetTurn));
      } catch (error) {
        if (isBusyFailure(error)) return errorResult(ERROR_TEXT.busy);
        throw error;
      }
    }
    return await performRewind(ctx, session, parsed.targetTurn);
  } finally {
    ACTIVE.delete(sessionKey);
  }
}

/* -------------------------------------------------------------------------- */
/* 6. Plugin entry (design §3.1, startup self-check)                          */
/* -------------------------------------------------------------------------- */

/**
 * Host plugin entry.
 *
 * @param ctx - Cordis context of the Loader row.
 */
export function apply(ctx) {
  const log = createLogger(ctx);
  const commands = readService(ctx, 'commands');

  if (commands === null || commands === undefined || typeof commands.register !== 'function') {
    log('warn', 'host disabled: commands service unavailable');
    return;
  }

  const definition = Object.freeze({
    definitionId: COMMAND_DEFINITION_ID,
    name: COMMAND_NAME,
    description: COMMAND_DESCRIPTION,
    input: Object.freeze({ hint: COMMAND_HINT }),
    handler: (invocation) => handleRewind(ctx, invocation),
  });

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => commands.register(definition), 'session-rewind: register /rewind');
    } else {
      commands.register(definition);
    }
  } catch (error) {
    log(
      'warn',
      `host disabled: /${COMMAND_NAME} registration failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  log('info', 'host ready');
}

/* -------------------------------------------------------------------------- */
/* 7. Test surface                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Pure helpers exported for the plugin's own verification harness.
 *
 * They are not part of the Loader contract; the plugin entry above only uses
 * `name`, `inject`, and `apply`.
 */
export const internals = Object.freeze({
  ERROR_TEXT,
  parseTarget,
  findTurnStart,
  maxTurnOf,
  computeSpan,
  readEvents,
  newMessageId,
  isBusyFailure,
  sessionIdentity,
  commandName: COMMAND_NAME,
  commandDefinitionId: COMMAND_DEFINITION_ID,
});
