// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { stubSettingsScope, usePinnedBrowserLanguages } from './browser-fixtures.ts'
import { apply, inject, NS } from '../src/client/index.ts'
import { McpSettingsSection } from '../src/client/McpSettingsSection.tsx'
import type { McpSettingsSectionInjected } from '../src/client/McpSettingsSection.tsx'
import type { McpInventorySnapshot } from '../src/inventory-types.ts'

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
afterEach(cleanup)

const EMPTY: McpInventorySnapshot = { servers: [] }
type ListResult =
  | { readonly ok: true; readonly value: McpInventorySnapshot }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

async function bench(provideInventory = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const list = vi.fn<() => Promise<ListResult>>()
    .mockResolvedValue({ ok: true, value: EMPTY })
  const mount = vi.fn(async () => {
    ctx.provide('remote.mcpInventory', { list })
    return async (): Promise<void> => {}
  })
  class RemoteService extends Service {
    $mount = mount
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  if (provideInventory) ctx.provide('remote.mcpInventory', { list })
  ctx.provide('connection', { api: {}, isLoopback: true })
  const stub = stubSettingsScope<{ servers: never[] }>()
  const bind = vi.fn(() => stub.scope)
  ctx.provide('settingsScope', { bind } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, bind, mount }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-mcp browser plugin', () => {
  it('declares only the services used by the Settings contribution', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'settingsScope'])
  })

  it('mounts its inventory Remote when the standard assembly has not selected it', async () => {
    const b = await bench(false)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.mount).toHaveBeenCalledOnce()
    expect(b.ctx.get('remote.mcpInventory')).toBeDefined()
    const entry = b.slots.entries('settings.section').find(item => item.options.id === 'mcp')!
    const injected = (entry.inject as unknown as () => McpSettingsSectionInjected)()
    await expect(injected.listStatus()).resolves.toEqual(EMPTY)
    await b.ctx.fiber.dispose()
  })

  it('registers a localized section below the Models entry without eager reads', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('settings.section').find(item => item.options.id === 'mcp')!
    expect(entry.component).toBe(McpSettingsSection)
    expect(entry.options).toMatchObject({ id: 'mcp', order: 12 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('MCP')
    expect(b.list).not.toHaveBeenCalled()
    expect(b.mount).not.toHaveBeenCalled()

    const injected = (entry.inject as unknown as () => McpSettingsSectionInjected)()
    await expect(injected.listStatus()).resolves.toEqual(EMPTY)
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'REMOTE_ERROR', message: 'unavailable' } })
    await expect(injected.listStatus()).rejects.toThrow('mcpInventory.list failed: REMOTE_ERROR: unavailable')
    await b.ctx.fiber.dispose()
  })

  it('binds the mcp settings namespace once on the plugin fiber and unloads with it', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.bind).toHaveBeenCalledExactlyOnceWith({ namespace: 'mcp' })
    expect(b.slots.entries('settings.section').some(item => item.options.id === 'mcp')).toBe(true)

    await fiber.dispose()
    expect(b.slots.entries('settings.section').some(item => item.options.id === 'mcp')).toBe(false)
    expect(() => b.locale.register(NS, 'zh', {})).not.toThrow()
    await b.ctx.fiber.dispose()
  })
})
