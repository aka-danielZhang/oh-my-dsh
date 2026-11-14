/**
 * The generic internal-source registry for queue display filtering (design
 * §7.1).
 *
 * Program-injected inputs sit in the durable inbox until their turn starts;
 * while the agent is busy they would surface as queued rows above the
 * composer. The display filter therefore needs TWO complementary signals:
 *
 * - `presentation === 'internal'` on the message source itself — the forward
 *   contract every new producer declares;
 * - a registered set of source kinds — the legacy compatibility path, so old
 *   durable records (which cannot be rewritten) are filtered without any
 *   migration.
 *
 * Human rows (`source.kind === 'user'`) are NEVER filtered: editing, removal
 * and steering keep their stock behavior. The filter only affects display;
 * the model still receives every queued message in order.
 *
 * This registry ships inside the plugin bundle for now and carries no Quno
 * vocabulary; hoisting it (and the filtering dock entry) into the harness
 * conversation presentation layer via a fork seam is the documented follow-up.
 *
 * @module dsh-quno/client/queue-internal
 */

/** The optional forward flag a producer may declare on its message source. */
type InternalPresentationSource = { readonly presentation?: 'internal' }

/** Structural face of any queued message source the filter inspects. */
export interface QueueSourceLike {
  readonly kind?: string
  readonly presentation?: 'internal'
}

/** Registered legacy source kinds, safest kept tiny and explicit. */
const internalSourceKinds = new Set<string>()

/**
 * Register source kinds that queue display must hide (legacy compatibility).
 * @param kinds - the program source kinds, e.g. `['quno-report', 'quno-notify']`.
 * @returns the disposer removing exactly the given kinds.
 */
export function registerInternalQueueKinds(kinds: readonly string[]): () => void {
  for (const kind of kinds) internalSourceKinds.add(kind)
  return () => {
    for (const kind of kinds) internalSourceKinds.delete(kind)
  }
}

/**
 * Whether one queued row must stay out of user-facing queue display.
 * A declared `presentation: 'internal'` wins; otherwise the kind registry
 * decides. Human messages are never internal, whatever they carry.
 * @param source - the queued message's source.
 * @returns true when the row is display-internal.
 */
export function isInternalQueueSource(source: QueueSourceLike & InternalPresentationSource): boolean {
  if (source.kind === 'user') return false
  if (source.presentation === 'internal') return true
  return source.kind !== undefined && internalSourceKinds.has(source.kind)
}
