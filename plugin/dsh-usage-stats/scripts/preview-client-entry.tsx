import previewCss from '__preview-css__'

/**
 * Dynamic-plugin PREVIEW entry (temporary, not part of the shipped bundle):
 * registers a `settings.section` entry 「使用统计 · 0.1.1 预览」 that renders
 * the REAL redesigned page (./UsageStatsSection) on top of the same requests
 * architecture, but feeds the face through Package-private host.call instead
 * of the Typert Remote — so it can run beside the installed 0.1.0 plugin in
 * one web profile without touching its Remote namespace or locale entries.
 * Built by scripts/build-dynamic-preview.mjs into a plain-JS IIFE for
 * cordis_define's code.client.
 */

import { UsageStatsSection } from '../src/client/UsageStatsSection.tsx'
import type { UsageStatsFace } from '../src/client/UsageStatsSection.tsx'
import type { UsageStatsLocaleKey } from '../src/client/locales.ts'
import { zh } from '../src/client/locales.ts'
import { resolveLang } from '../src/client/format.ts'
import type { UsageStatsLang } from '../src/client/format.ts'

declare const styles: { insert(css: string): () => void }
declare const host: { call(method: string, args?: unknown): Promise<unknown> }

interface Outcome<Value> {
  ok: boolean
  value?: Value
  error?: { code: string, message: string }
}

async function call<Value>(kind: string, params?: Record<string, unknown>): Promise<Value> {
  const outcome = await host.call('usage-stats-preview:query', { kind, ...params }) as Outcome<Value>
  if (!outcome.ok) throw new Error(`${outcome.error?.code ?? 'REMOTE_ERROR'}: ${outcome.error?.message ?? 'unavailable'}`)
  return outcome.value as Value
}

const t = (key: UsageStatsLocaleKey, params?: Record<string, string | number>): string => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

export function install(ctx: { get(name: string): unknown }): () => Promise<void> {
  const slots = ctx.get('slots') as {
    inject(slot: string, register: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  } | undefined
  if (slots === undefined) throw new Error('usage-stats-preview: slots service missing')

  const locale = ctx.get('locale') as { getLocale(): { active: string } } | undefined
  const lang = (): UsageStatsLang => resolveLang(locale === undefined || typeof locale.getLocale().active !== 'string' ? 'zh' : locale.getLocale().active)

  const face: UsageStatsFace = {
    summary: () => call('summary'),
    daily: range => call('daily', { range }),
    activity: mode => call('activity', { mode }),
    breakdown: range => call('breakdown', { range }),
    quality: () => call('quality', {}),
  }

  if (previewCss !== '') styles.insert(previewCss)

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'usage-stats-preview',
    order: 12,
    label: () => t('nav') + ' · 预览',
    inject: () => ({ face, t, lang }),
  }, UsageStatsSection))
  return async () => {}
}
