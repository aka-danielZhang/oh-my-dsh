/**
 * dsh-fs-observation-log, host half: heal the fs-observation-policy's
 * amnesia across process restarts and session forks.
 *
 * The stock policy keys observed-file state by the live session object in a
 * WeakMap, so every new process (desktop relaunch, `dsh web` restart) and
 * every fork starts with an empty guard while the conversation transcript
 * still says the file was read or just edited. The model cannot see the
 * process boundary, follows its own history, and eats a false
 * `FS_NOT_OBSERVED` — one wasted read+retry round trip on a file that never
 * changed (upstream discussions #275/#450 document the fork half).
 *
 * This plugin closes exactly that gap and nothing wider:
 *
 * - it mirrors every `fs/observed` present-observation into a per-session
 *   JSONL sidecar under `$DSH_HOME/fs-observation-log/` (fork lineage in the
 *   file header), fail-soft;
 * - before an `edit`/`write` whose target the acting session has not
 *   observed in this process, it looks the target up in the session's
 *   lineage evidence and stats the live file: only when the provider's
 *   freshness token still equals the recorded one does it re-emit the
 *   observation, letting the stock policy record it and proceed with its
 *   normal CAS guard. A changed file, a missing file, or absent evidence
 *   restores nothing — the read-before-edit demand stands.
 *
 * The plugin is passive-by-construction: it never returns a write/edit
 * intent, never loosens a guard, and never touches the sandbox stack. With
 * the stock policy absent it is inert (an unconditional edit needs no
 * observation). Every harness import is type-only — the built bundle has
 * zero `@deepseek-ai/*` runtime imports, so it cannot drag a second module
 * instance into the process.
 * @module dsh-fs-observation-log
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { validateConfig } from './config.ts'
import { healDecision, sessionLineage, type SessionHeaderView } from './heal.ts'
import { ObservationStore } from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-fs-observation-log'

/** Hard deps: the fs provider for resolve/stat, the tools events for the pre-execute hook. */
export const inject = ['fs', 'tools']

/** The sidecar directory: `<DSH_HOME>/fs-observation-log`.
 *
 * DSH_HOME normalization mirrors the shell semantics users expect: unset or
 * blank falls back to `<home>/.dsh`; a leading `~` expands to the user home;
 * a relative path resolves against the process cwd (plain-Node convention).
 * @param envHome - the raw `DSH_HOME` environment value.
 * @param home - the OS user home directory.
 */
export function observationLogDir(envHome: string | undefined, home: string): string {
  let base: string
  if (envHome === undefined || envHome.trim().length === 0) base = join(home, '.dsh')
  else if (envHome === '~' || envHome.startsWith(`~/`) || envHome.startsWith(`~\\`)) base = join(home, envHome.slice(1))
  else base = isAbsolute(envHome) ? envHome : resolve(envHome)
  return join(base, 'fs-observation-log')
}

/** Minimal structural view of the fs/observed actor (see fs-observation-policy's types.ts precedent). */
interface ActorView {
  agent?: { session?: { header?: SessionHeaderView } }
}

/** Narrow an opaque tool-execution actor to its session header view. */
function headerOf(actor: object | undefined): SessionHeaderView | undefined {
  return (actor as ActorView | undefined)?.agent?.session?.header
}

/** The session cwd a filesystem tool would resolve against (mirrors dsh-tool-fs's session-cwd base case). */
function sessionCwd(exec: ToolExecution): string | undefined {
  const cwd = (exec.agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** Extract a non-empty string file_path from opaque tool arguments. */
function filePathOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const value = (args as { file_path?: unknown }).file_path
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = validateConfig(rawConfig)
  const store = new ObservationStore(config, observationLogDir(process.env.DSH_HOME, homedir()))
  const logger = ctx.logger

  // Mirror every present observation into the sidecar. fs/observed listeners
  // are contractually synchronous side-effect-only recorders; the store's
  // own writes are sync appendFileSync (bounded small), matching that shape.
  ctx.on('fs/observed', (target, observation, actor) => {
    if (observation.kind !== 'present') return
    const header = headerOf(actor)
    const sessionId = header?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    const parent = header?.parentSession
    store.record(
      sessionId,
      target.targetKey,
      target.displayPath,
      observation.version,
      typeof parent === 'string' && parent.length > 0 ? parent : undefined,
    )
  })

  // The healing hook: runs before the tool executes (the pre-execute gate
  // completes before dispatch), so a restored observation is visible to the
  // fs/edit-intent decision the tool makes inside its own execute.
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    if (exec.name !== 'edit' && exec.name !== 'write') return next()
    const header = headerOf(exec)
    const lineage = sessionLineage(header ?? {})
    if (lineage.length === 0) return next()
    const filePath = filePathOf(exec.arguments)
    if (filePath === undefined) return next()
    try {
      const target = await ctx.fs.resolve(filePath, {
        ...sessionCwd(exec) !== undefined ? { cwd: sessionCwd(exec) as string } : {},
        signal: exec.signal,
      })
      // No mirror shortcut here on purpose: this store's mirror reflects the
      // persisted sidecar, which says nothing about the stock policy's
      // in-memory WeakMap (a fresh process loads the mirror but starts the
      // policy empty). The authoritative check is the provider stat below —
      // cheap local metadata — and the re-emitted observation is idempotent.
      const evidence = store.lookup(lineage, target.targetKey)
      if (evidence === undefined) return next()
      const info = await ctx.fs.stat(target, exec.signal)
      const decision = healDecision(undefined, evidence, { version: info?.version })
      // A restore decision implies the stat reported a version (healDecision's
      // own veto chain); the guard keeps the branded-typed emit honest.
      if (decision.kind === 'restore' && info !== undefined) {
        // Re-arm the stock policy exactly as a read would have; its version
        // CAS still guards the mutation that follows.
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        logger.debug(
          `dsh-fs-observation-log: restored observation for ${target.displayPath} (evidence from session ${decision.fromSession})`,
        )
      }
    } catch {
      // Healing is best-effort: any failure leaves the stock policy's answer
      // untouched, which is at worst the status quo without this plugin.
    }
    return next()
  })
}
