/**
 * Host loader entry for the browser implementation exported from `./client`,
 * plus the strict Typert registration that keeps `/api/usageStats/*`
 * routable under assembled runtimes (see ./typert.host.ts). The collector
 * and gateway rows live in ./collector.ts and ./gateway.ts.
 */
import type { Context } from '@deepseek-ai/cordis'
import TYPERT_HOST from './typert.host.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-usage-stats'

/** Hard dependency: the fiber waits for the runtime's typert registry. */
export const inject = ['typert']

/** Structural shape of the registry's register method, instance-agnostic. */
interface TypertRegister {
  register(contribution: typeof TYPERT_HOST): () => void | Promise<void>
}

/**
 * Host plugin body: register the strict Remote endpoints, then stay out of
 * the way — the settings page itself lives in the browser half. The returned
 * disposer withdraws the descriptors when this fiber unloads (HMR included).
 */
export function apply(ctx: Context): (() => void | Promise<void>) | undefined {
  // String-keyed lookup crosses module-instance boundaries (the registry
  // service is owned by the runtime tree's typert package, not this plugin's
  // devDependency copy); absence after inject would be a broken composition.
  const typert = ctx.get('typert') as TypertRegister | undefined
  if (typert === undefined) {
    throw new Error('dsh-usage-stats: typert registry service is not mounted')
  }
  return typert.register(TYPERT_HOST)
}
