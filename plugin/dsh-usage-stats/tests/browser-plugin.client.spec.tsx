// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import * as React from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { loadBrowserModule, usePinnedBrowserLanguages } from './browser-fixtures.ts'
import { zh } from '../src/client/locales.ts'
import type { UsageStatsLocaleKey } from '../src/client/locales.ts'
import type { UsageStatsSummary } from '../src/types.ts'
import sourceStyles from '../src/client/UsageStatsSection.module.css'

type ListResult =
  | { readonly ok: true, readonly value: UsageStatsSummary }
  | { readonly ok: false, readonly error: { readonly code: string, readonly message: string } }

/** Execute the BUILT browser factory with the loader's explicit imports. */
function loadBuiltClient(imports: Record<string, unknown>): { inject: string[], apply: (ctx: Context) => Promise<() => Promise<void>> } {
  const require = createRequire(import.meta.url)
  const builtPath = resolve(__dirname, '../lib/client.js')
  let factory: ((require: (id: string) => unknown) => Record<string, unknown>) | undefined
  // The REAL jsdom window carries the loader hook: closures built inside the
  // vm keep their lexical scope, and the section's focus listener needs the
  // genuine window.addEventListener at call time.
  const holder = window as unknown as { __ModuleLoader__?: unknown }
  const previous = holder.__ModuleLoader__
  holder.__ModuleLoader__ = { load: (entry: { factory: typeof factory }) => { factory = entry.factory } }
  try {
    runInNewContext(readFileSync(builtPath, 'utf8'), {
      navigator, document, localStorage, console, setTimeout, clearTimeout, queueMicrotask, window,
    })
  } finally {
    if (previous === undefined) delete holder.__ModuleLoader__
    else holder.__ModuleLoader__ = previous
  }
  if (!factory) throw new Error('Missing browser factory in lib/client.js')
  return factory((id) => {
    if (!(id in imports)) throw new Error(`Missing browser import: ${id}`)
    return imports[id]
  }) as { inject: string[], apply: (ctx: Context) => Promise<() => Promise<void>> }
}

// The locale and renderer packages ship loader-format browser bundles; run
// their published factories with the loader's exact explicit imports.
vi.mock('@deepseek-ai/dsh-client-locale/client', async () => {
  const { loadBrowserModule } = await import('./browser-fixtures.ts')
  return loadBrowserModule('@deepseek-ai/dsh-client-locale/client', {
    'react': await import('react'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
    '@deepseek-ai/dsh-client-store': await import('@deepseek-ai/dsh-client-store'),
  })
})
vi.mock('@deepseek-ai/dsh-client-ui-renderer/client', async () => {
  const { loadBrowserModule } = await import('./browser-fixtures.ts')
  return loadBrowserModule('@deepseek-ai/dsh-client-ui-renderer/client', {
    'react': await import('react'),
    'react-dom': await import('react-dom'),
    'react-dom/client': await import('react-dom/client'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    '@deepseek-ai/cordis': await import('@deepseek-ai/cordis'),
    '@deepseek-ai/dsh-client-ui-slots': await import('@deepseek-ai/dsh-client-ui-slots'),
  })
})

usePinnedBrowserLanguages('zh-CN')

afterEach(() => {
  cleanup()
  document.querySelectorAll('style[data-plugin="dsh-usage-stats"]').forEach(tag => tag.remove())
  vi.restoreAllMocks()
})

const SUMMARY: UsageStatsSummary = {
  totalTokens: 1_000, peakTokens: 100, longestChatMs: 1, currentStreakDays: 1, longestStreakDays: 1,
  activeDays: 1, firstDate: '2026-09-01', lastDate: '2026-09-01', speedTokensPerSec: 10,
  avgCallMs: 60_000, cacheHitRate: 0.5, calls: 1, generatedAt: Date.now(),
}

/** Cordis bench: real SlotRegistry + LocaleRuntime + a remote namespace. */
async function bench(withNamespace: boolean) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const summary = vi.fn(async (): Promise<ListResult> => ({ ok: true, value: SUMMARY }))
  const daily = vi.fn(async () => ({ days: [] }))
  const activity = vi.fn(async () => ({ mode: 'daily', cells: [], maxTotal: 0 }))
  const breakdown = vi.fn(async () => ({ dim: 'model', total: 0, slices: [] }))
  const quality = vi.fn(async () => ({ models: [] }))
  const namespace = { summary, daily, activity, breakdown, quality }
  const mount = vi.fn(async () => {
    if (withNamespace) return async (): Promise<void> => {}
    ctx.provide('remote.usageStats', namespace)
    return async (): Promise<void> => {}
  })
  class RemoteService extends Service {
    $mount = mount
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  if (withNamespace) ctx.provide('remote.usageStats', namespace)
  const slots = ctx.get('slots') as unknown as SlotRegistry
  const declare = (): () => void => slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  return { ctx, slots, locale, declare, namespace, mount }
}

/** The built client module under the loader's exact import posture. */
async function builtModule() {
  return loadBuiltClient({
    'react': await import('react'),
    'react/jsx-runtime': await import('react/jsx-runtime'),
    '@deepseek-ai/dsh-client-ui-primitives': await import('@deepseek-ai/dsh-client-ui-primitives'),
  })
}

describe('dsh-usage-stats browser plugin (built client)', () => {
  it('declares exactly the services the client half consumes', async () => {
    const built = await builtModule()
    expect(built.inject).toEqual(['slots', 'locale', 'remote'])
  })

  it('registers the settings section with the real SlotRegistry and unloads with its fiber', async () => {
    const b = await bench(true)
    b.declare()
    const built = await builtModule()
    const fiber = b.ctx.plugin({ inject: [...built.inject], apply: built.apply })
    await fiber.await()

    const entry = b.slots.entries('settings.section').find(item => item.options.id === 'usage-stats')!
    expect(entry).toBeDefined()
    expect(entry.options).toMatchObject({ id: 'usage-stats', order: 11 })
    expect(resolveSlotLabel(entry.options.label)).toBe('使用统计')
    expect(typeof entry.component).toBe('function')

    // HMR dispose analog: dropping the fiber removes the section entry.
    await b.ctx.fiber.dispose()
    expect(b.slots.entries('settings.section').some(item => item.options.id === 'usage-stats')).toBe(false)
  })

  it('mounts its Remote namespace when the assembly has not selected it', async () => {
    const b = await bench(false)
    b.declare()
    const built = await builtModule()
    await b.ctx.plugin({ inject: [...built.inject], apply: built.apply }).await()
    expect(b.mount).toHaveBeenCalledOnce()
    expect(b.ctx.get('remote.usageStats')).toBeDefined()
    await b.ctx.fiber.dispose()
  })

  it('unwraps RemoteOutcome payloads and surfaces failures through the face', async () => {
    const b = await bench(true)
    b.declare()
    const built = await builtModule()
    await b.ctx.plugin({ inject: [...built.inject], apply: built.apply }).await()
    const entry = b.slots.entries('settings.section').find(item => item.options.id === 'usage-stats')!
    const injected = entry.inject as unknown as () => { face: { summary(): Promise<UsageStatsSummary> }, t: (key: UsageStatsLocaleKey) => string, lang: () => string }
    const props = injected()
    await expect(props.face.summary()).resolves.toEqual(SUMMARY)
    expect(props.t('nav')).toBe('使用统计')
    expect(props.lang()).toBe('zh') // pinned zh-CN browser languages
    b.namespace.summary.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'down' } })
    await expect(props.face.summary()).rejects.toThrow('REMOTE_ERROR: down')
    await b.ctx.fiber.dispose()
  })

  it('injects the plugin stylesheet and renders with hashed classes only', async () => {
    const b = await bench(true)
    b.declare()
    const built = await builtModule()
    await b.ctx.plugin({ inject: [...built.inject], apply: built.apply }).await()
    const entry = b.slots.entries('settings.section').find(item => item.options.id === 'usage-stats')!

    const style = document.querySelector('style[data-plugin="dsh-usage-stats"]')
    expect(style).not.toBeNull()
    const css = style!.textContent ?? ''
    expect(css).toContain('@container')
    // Every local class the source module knows has a hashed rule in the
    // built stylesheet — the P0 “raw class names never match” guard.
    for (const key of Object.keys(sourceStyles)) {
      expect(css).toMatch(new RegExp(`\\.[\\w-]+_${key}\\b`))
    }
    // …and the bundle carries no raw usage* class strings at all.
    const bundle = readFileSync(resolve(__dirname, '../lib/client.js'), 'utf8')
    expect(bundle).not.toMatch(/usage(Heat|Trend|Donut|Quality|Tip|Slice|Legend)/)

    const injected = entry.inject as unknown as () => { face: unknown, t: (key: UsageStatsLocaleKey) => string, lang: () => 'zh' }
    const props = injected()
    const t = props.t
    const face = {
      summary: async () => SUMMARY,
      daily: async () => ({ days: [] }),
      activity: async () => ({ mode: 'daily', cells: [], maxTotal: 0 }),
      breakdown: async () => ({ dim: 'model', total: 0, slices: [] }),
      quality: async () => ({ models: [] }),
    }
    const Component = entry.component as React.FunctionComponent<Record<string, unknown>>
    render(React.createElement(Component, { face, t, lang: () => 'zh' }))
    await waitFor(() => expect(screen.getByText('正在读取统计…')).toBeTruthy())
    const root = document.querySelector('section')!
    expect(root.className).not.toContain('usage')
    for (const cls of root.className.split(/\s+/)) {
      expect(css).toContain(`.${cls}`)
    }
    await b.ctx.fiber.dispose()
  })
})
