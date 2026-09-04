/** Register OhMyMemo's strict Typert Host descriptors. */

import type { Context } from '@deepseek-ai/cordis'
import TYPERT_HOST from './typert.host.ts'

export const name = 'dsh-ohmymemo-api'
export const inject = ['typert', 'ohMyMemoUi']

interface TypertRegister {
  register(contribution: typeof TYPERT_HOST): () => void | Promise<void>
}

/** Register the package's direct Remote methods with the Host registry. */
export function apply(ctx: Context): (() => void | Promise<void>) {
  const typert = ctx.get('typert') as TypertRegister | undefined
  if (typert === undefined) throw new Error(`${name}: typert registry service is not mounted`)
  return typert.register(TYPERT_HOST)
}
