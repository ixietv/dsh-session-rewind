# dsh-session-rewind

**Rewind the conversation you are in — same session, no fork, no new tab.**

[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0-2F6BFF)](https://github.com/deepseek-dsh/dsh-desktop) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)

---

DSH's official flow for "undo a few turns" is either a new fork or hand-editing state. `dsh-session-rewind` adds a single command — `/rewind` — that folds the tail of the **current** conversation away in place. The `sessionId` never changes, the event log stays append-only, and the model genuinely forgets the folded turns on its next request.

This is not a fork. Nothing is deleted from disk, no `.jsonl` is rewritten, no new session appears in the sidebar.

## Why rewind?

| Scenario | Before | With dsh-session-rewind |
|---|---|---|
| Bad turn, want a clean retry | Start a new session, lose context | `/rewind 1`, keep everything before it |
| Prompt went sideways mid-thread | Fork and re-explain | `/rewind 3`, continue in place |
| Trim a long exploration | Manual pruning | One click in the turn action row |

## Key Features

- **In-place fold** — `session.append('user/message', checkpoint, { surfaceOp: 'replace' })`; `sessionId` unchanged.
- **Append-only log** — every earlier event keeps its seq; the only write is one checkpoint event.
- **Model-visible** — folded nodes drop out of `deriveMessages()`, so the next request really lacks them.
- **Two entry points** — `/rewind [<turn>]` command, plus an icon button in the official `conversation.chat.assistant-actions` row.
- **Safe by default** — refused while the agent is running, single-flight per session, and a failed persist reports `PERSIST_FAILED` instead of pretending success.
- **Zero extra runtime deps** — Host half imports nothing; Client half requires only `react`.

## Install

```bash
git clone https://github.com/ixietv/dsh-session-rewind.git "$HOME/.dsh/plugins/dsh-session-rewind"
```

Then restart DeepSeek Harness. The Loader picks up `cordis.patch.yml` and inserts the Host row; the Web shell loads `lib/client.js` via `dsh.client.platform: "web"`.

## Usage

| Entry | Syntax | Behaviour |
|---|---|---|
| Command | `/rewind` | Rewind past the most recent turn |
| Command | `/rewind 3` | Rewind to before turn 3 |
| UI | Turn action-row icon | Hover a turn, click to rewind to it |

## How It Works

```
User: /rewind <turn>
   │
   ▼
Host (lib/host.js) ── validate turn, agent idle, no rewind in flight
   │
   ▼
Locate target turn/start seq ── collect every surface node up to the tail
   │
   ▼
session.append('user/message', checkpoint, { surfaceOp: 'replace', sourceEventSeqs })
   │
   ▼
ctx.sessions.flush(session) ── persist; failure → PERSIST_FAILED
   │
   ▼
Client (lib/client.js) ── hide folded DOM rows, mark via sessionStorage
```

## Architecture

```text
dsh-session-rewind
├── lib/host.js            # Host half: register /rewind, compute cut point, append checkpoint
├── lib/client.js          # Web client half: action-row button, DOM hiding, rewind marks
├── cordis.patch.yml       # Loader patch: insert one Host row (no override/isolate)
├── docs/design.md         # Round-2 contract: semantics, decisions DEC-1..DEC-12
├── docs/research.md       # Surface-primitive and command-system research
├── docs/research-truncate.md  # Truncation / tool-pairing semantics
└── docs/verification.md   # Verification log and acceptance evidence
```

| Module | Responsibility |
|---|---|
| `lib/host.js` | Owns the command, the cut point and the single `surfaceOp: replace` append |
| `lib/client.js` | Owns the trigger surface and the visual disappearance of folded rows |
| `cordis.patch.yml` | Composes next to official modules instead of replacing them |

## Design Notes

- **Cut point is a turn boundary** — satisfies tool-pairing balance without patching.
- **Checkpoint source is `{ kind: 'user' }`** — inside the closed `MessageSourceMap`; it is not rendered as a user bubble because replace checkpoints are not "append surface" events.
- **No restore/undo-of-rewind** — a second rewind can only go further back, since the folded nodes are already gone from the surface.

## Development

```bash
node --check lib/host.js
node --check lib/client.js
```

## FAQ

**Does this create a new session?** No. The whole point is that it does not.

**Is history deleted from disk?** No. Events stay; only the derived surface stops exposing them.

**Can I undo a rewind?** Not in-place. The folded nodes are no longer on the surface.

## License

MIT
