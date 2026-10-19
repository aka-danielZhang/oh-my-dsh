import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_THREAD_SETTINGS, type ThreadSettings } from './thread-types.ts'
import TYPERT_HOST from './typert.host.ts'

export const name = 'dsh-thread'
export const inject = ['typert']

interface TypertRegister {
  register(contribution: typeof TYPERT_HOST): () => void | Promise<void>
}

/** The master switch is this entry's own configuration: one volatile fact the settings row edits and every consumer reads live. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_THREAD_SETTINGS.enabled).volatile(),
})

/** Live view over the entry configuration for sibling entries (the gateway). */
export interface ThreadSettingsFace {
  read(): ThreadSettings
  subscribe(listener: () => void): () => void
}

/** Register strict descriptors and share the live master switch. */
export function apply(ctx: Context, config: ThreadSettings & { enabled?: boolean }): (() => void | Promise<void>) {
  const typert = ctx.get('typert') as TypertRegister | undefined
  if (typert === undefined) throw new Error('dsh-thread: typert registry service is not mounted')
  const disposeTypert = typert.register(TYPERT_HOST)

  const listeners = new Set<() => void>()
  const read = (): ThreadSettings => ({ enabled: config.enabled ?? DEFAULT_THREAD_SETTINGS.enabled })
  ctx.provide('threadSettings', {
    read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } satisfies ThreadSettingsFace)
  // Profile-document writes are the only mutation path; re-read the volatile
  // ref and fan out so host-plane consumers track the browser row.
  const disposeWatch = ctx.on('settings/document-updated', (ns: string) => {
    if (ns !== 'dsh-thread') return
    for (const listener of listeners) listener()
  })

  return () => {
    disposeWatch()
    void disposeTypert
  }
}
