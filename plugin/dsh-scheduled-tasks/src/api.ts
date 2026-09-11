/**
 * dsh-scheduled-tasks, Typert registration row — the `scheduled-tasks-api`
 * line. Registers the strict Host descriptors so `/api/scheduledTasks/*`
 * stays routable under assembled runtimes; the service itself lives in the
 * core row (./index.ts) and the page in the browser half.
 * @module dsh-scheduled-tasks/api
 */

import type { Context } from '@deepseek-ai/cordis'
import TYPERT_HOST from './typert.host.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-scheduled-tasks/api'

/** Hard dependencies: the registry plus the service being advertised. */
export const inject = ['typert', 'scheduledTasks']

/** Structural shape of the registry's register method, instance-agnostic. */
interface TypertRegister {
  register(contribution: typeof TYPERT_HOST): () => void | Promise<void>
}

/** Register the strict Remote endpoints; the disposer withdraws them. */
export function apply(ctx: Context): (() => void | Promise<void>) {
  const typert = ctx.get('typert') as TypertRegister | undefined
  if (typert === undefined) throw new Error(`${name}: typert registry service is not mounted`)
  return typert.register(TYPERT_HOST)
}
