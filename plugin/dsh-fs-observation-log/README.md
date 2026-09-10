# dsh-fs-observation-log

Persist the `fs-observation-policy`'s observed-file evidence across process restarts and session forks, and **restore** an observation before `edit`/`write` when — and only when — the file provably did not change.

## The problem

`@deepseek-ai/dsh-fs-observation-policy` keeps its read-before-edit state in a `WeakMap` keyed by the live session object: pure memory, gone with the process. The session transcript, however, is durable. So after

- a desktop relaunch / `dsh web` restart (session resume), or
- a session fork (`subagent_fork`),

the model reads its own history ("I read this file / I just edited it"), follows it, and gets a false

```
Error: edit requires reading "<path>" first — read the file, then retry
```

even though the file never changed. The model cannot see the process boundary, so prompt guidance cannot fix this; each hit costs one wasted read+retry round trip. (Upstream tracks the fork half in discussions #275/#450; the package README lists resume persistence as a deferred limitation.)

## How it heals

1. **Mirror** — every `fs/observed` present-observation is appended to a per-session JSONL sidecar under `$DSH_HOME/fs-observation-log/` (first line is a header carrying the session id and its fork parent; fail-soft on write errors). The filename hashes the full opaque session id (SHA-256), so ids that differ only in separator spelling can never collide, and a sidecar whose header names another session is treated as absent.
2. **Restore** — on `tools/pre-execute` of an `edit`/`write` whose target the acting session has not observed in this process, the plugin consults the session's own sidecar, stats the live file through `ctx.fs`, and re-emits `present` **only if the provider's freshness token is byte-identical to the recorded one** — i.e. the file provably did not change since the remembered observation.
3. Everything else — changed file, deleted file, no evidence — restores nothing. The stock policy keeps demanding a read. `FS_STALE_VERSION`, unique-match, and the sandbox stack are untouched.

**Ancestor healing is deliberately out of scope.** A sidecar records when a read happened, not where in the transcript it sits, so a parent's evidence recorded after the fork cut is indistinguishable from inherited reads — a child could heal an edit its transcript never observed. Until evidence records carry the fork-cut bound, a session heals only from its own sidecar; the header still persists the fork parent (reserved) so a future cut-bound scheme needs no format change.

Net invariant: **the guard never forgets more than the transcript remembers; a file that actually changed still demands a fresh read.** The local backend's version token (`dev:ino:size:mtimeNs:ctimeNs`) is stable across processes for an unchanged file, which is what makes the comparison sound.

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-fs-observation-log
```

The bundle patch installs one process-wide Host row: a single store and a single `tools/pre-execute` listener serve every session in the process (the sidecar store is cross-session by design, and untagged host listeners are admitted into Agent-scoped dispatch). `dsh plugin add` therefore activates the plugin immediately — no per-preset rows required. The plugin contributes no service, needs no realm, and is inert when the stock observation policy is absent.

`DSH_HOME` normalization: unset or blank falls back to `<home>/.dsh`; a leading `~` expands to the user home; a relative path resolves against the process cwd. Sidecars written by older versions (sanitized-id filenames) are ignored — evidence is advisory and re-accumulates as sessions run; the old files are read-only leftovers and can be deleted.

## Config

| field | default | meaning |
|---|---|---|
| `maxEntriesPerSession` | 200 | Per-session sidecar cap on physically stored records (re-observations included); on overflow the file is rewritten keeping the newest half. |
| `maxWriteFailures` | 5 | Consecutive sidecar write failures before the store disables itself (in-memory mirror keeps serving). |

Invalid values fail loud at mount — including the retired `inheritFork`/`maxLineageDepth` fields, so a stale preset that still passes them fails instead of silently keeping unsafe cross-session healing.

## Design notes

- **Zero harness runtime imports** — every `@deepseek-ai/*` import is type-only, so the built bundle cannot drag a second cordis/dsh-fs module instance into the process (the module-instance split class of bugs). Config validation is hand-rolled for the same reason.
- **Evidence is advisory only** — a lost, stale, or corrupt sidecar can only cause the status quo (a re-read), never an unauthorized edit; the restore path re-verifies against the live provider every time.
- **Privacy** — sidecars record target keys (realpaths), display paths, version tokens, and timestamps only. Never file contents. Delete the directory any time; the plugin rebuilds evidence as sessions run.

Decision record: `docs/notes/2026-08-21-fs-observation-log.md` (repo root).
