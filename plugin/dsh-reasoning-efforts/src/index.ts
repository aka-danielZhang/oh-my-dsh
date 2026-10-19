/**
 * dsh-reasoning-efforts, host half: declare reasoning efforts (and their
 * dispatch compat) for hand-declared llm-pi-ai models.
 *
 * A custom OpenAI-compatible route (a sub2api gateway fronting Grok, say)
 * hand-declares its models in `settings.yaml` without `reasoningEfforts`,
 * because no GUI edits that field and no model listing reports reasoning
 * metadata. llm-pi-ai then resolves those models as non-reasoning and the
 * composer hides the effort picker entirely (upstream discussion #843). Some
 * vendors also need compat switches (`supportsReasoningEffort`,
 * `thinkingFormat`) stated explicitly — auto-detection turns them off — or
 * the declared efforts never reach the wire.
 *
 * On mount — and after every `llm-pi-ai` settings commit — this plugin fills
 * the gap: for each model entry whose route/model matches an ordered rule
 * from the composition row's `config`, it writes what the entry lacks. The
 * efforts piece fills only when the raw user layer declares no
 * `reasoningEfforts` AND the live adapter does not already offer efforts
 * (catalog inheritance); the compat piece fills field by field, skipping any
 * switch the entry declares. Never anything else: explicit declarations win
 * over rules, the plugin never removes a key, and removal stays a hand edit.
 *
 * Writes carry the read revision, so a concurrent edit rejects
 * (`SETTINGS_CONFLICT`) instead of being clobbered; the losing fill simply
 * waits for the next `settings/updated`. Fills serialize on one tail per
 * fiber, and the plugin's own write re-triggers a no-op pass — the loop
 * terminates because a filled model is no longer a candidate.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { buildFillOps, collectCandidates, isPlainObject, validateConfig } from './rules.ts'
import type { FillCandidate } from './rules.ts'

export const name = 'dsh-reasoning-efforts'

export const inject = ['settings', 'llm', 'timer']

/** The settings namespace llm-pi-ai's provider profiles live in. */
const NS = 'llm-pi-ai' as SettingsNamespace

/** Startup retries while the namespace has not registered yet. */
const STARTUP_ATTEMPTS = 10
const STARTUP_INTERVAL_MS = 1_000

/** Whether one error is a settings revision conflict (a concurrent write won). */
function isConflictError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = validateConfig(rawConfig)
  if (config.rules.length === 0) return

  let warnedReadonly = false
  let tail: Promise<unknown> = Promise.resolve()

  /** Gate 3: does the live adapter already offer efforts for this route/model? */
  const offersEfforts = async (candidate: FillCandidate): Promise<boolean> => {
    try {
      const info = await ctx.llm.resolveModelInfo(candidate.route, candidate.modelId)
      return info.reasoning !== undefined && info.reasoning.efforts.length > 0
    } catch {
      // The adapter cannot resolve the model — nothing inherited, rules decide.
      return false
    }
  }

  /**
   * One fill pass. Reads the raw user layer (never the schema-resolved view:
   * persisting materialized defaults would bake them into settings.yaml),
   * drops candidates whose route already offers efforts, and writes the rest.
   * @returns whether the namespace was absent (the caller may retry).
   */
  const fillOnce = async (): Promise<boolean> => {
    const settings = ctx.settings
    if (settings.writable !== true) {
      if (!warnedReadonly) {
        warnedReadonly = true
        ctx.logger.warn('dsh-reasoning-efforts: settings provider is read-only; effort declarations skipped')
      }
      return false
    }
    const descriptor = settings.describe().find(entry => entry.ns === NS)
    if (descriptor === undefined) return true
    const rawUser: unknown = descriptor.user
    const providers = isPlainObject(rawUser) && isPlainObject(rawUser.providers)
      ? rawUser.providers
      : undefined
    if (providers === undefined) return false
    const candidates = collectCandidates(providers, config.rules)
    if (candidates.length === 0) return false
    const kept: FillCandidate[] = []
    for (const candidate of candidates) {
      if (candidate.efforts === undefined || (await offersEfforts(candidate))) {
        // The efforts piece is either absent by need or inherited from the
        // catalog (gate 3); it stays untouched either way, while a compat
        // piece — wire format, not capability listing — is still fillable.
        if (candidate.compatFill !== undefined && candidate.efforts === undefined) kept.push(candidate)
        else if (candidate.compatFill !== undefined) kept.push({ ...candidate, efforts: undefined })
        continue
      }
      kept.push(candidate)
    }
    if (kept.length === 0) return false
    const ops = buildFillOps(kept, providers) as SettingsPathOp[]
    try {
      await settings.mutate(NS, ops, descriptor.revision)
    } catch (error) {
      if (isConflictError(error)) {
        ctx.logger.debug(
          'dsh-reasoning-efforts: a concurrent settings write won the revision race; the next settings/updated re-runs the fill',
        )
        return false
      }
      throw error
    }
    ctx.logger.info(
      'dsh-reasoning-efforts: declared reasoning efforts for %d model(s): %s',
      kept.length,
      kept.map(candidate => `${candidate.route}/${candidate.modelId}`).join(', '),
    )
    return false
  }

  /** Chain one fill onto this fiber's serialized tail. */
  const enqueueFill = (): void => {
    tail = tail.then(() => fillOnce()).catch((error: unknown) => {
      ctx.logger.error(
        'dsh-reasoning-efforts: fill failed: %s',
        error instanceof Error ? error.stack ?? error.message : String(error),
      )
    })
  }

  // Startup: the llm-pi-ai namespace registers when its plugin mounts, which
  // needs the llm service and may trail this fiber. Retry briefly, then rely
  // on settings/updated (a section the user edits later re-triggers the fill).
  let attempts = 0
  const attempt = (): void => {
    attempts += 1
    tail = tail
      .then(() => fillOnce())
      .then(absent => {
        if (absent && attempts < STARTUP_ATTEMPTS) ctx.timeout(attempt, STARTUP_INTERVAL_MS)
      })
      .catch((error: unknown) => {
        ctx.logger.error(
          'dsh-reasoning-efforts: startup fill failed: %s',
          error instanceof Error ? error.message : String(error),
        )
        if (attempts < STARTUP_ATTEMPTS) ctx.timeout(attempt, STARTUP_INTERVAL_MS)
      })
  }
  ctx.timeout(attempt, 0)

  ctx.on('settings/document-updated', (ns: string) => {
    if (ns === NS) enqueueFill()
  })
}
