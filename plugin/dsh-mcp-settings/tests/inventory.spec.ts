import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import McpManagerService, { MCP_SETTINGS_NAMESPACE } from '../src/manager.ts'
import McpInventoryGateway from '../src/inventory.ts'

// The mcp-client package is replaced by a config-aliased stand-in (tests/mcp-client-fake.ts).
import { connections, resetFake } from './mcp-client-fake.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function harness(): Promise<{ ctx: Context; inventory: McpInventoryGateway }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  await ctx.plugin(McpManagerService)
  await ctx.plugin(McpInventoryGateway)
  return { ctx, inventory: ctx.get('mcpInventory') as McpInventoryGateway }
}

describe('McpInventoryGateway', () => {
  it('publishes one direct list method under the mcpInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'mcpInventory',
      namespace: 'mcpInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
    ])
  })

  it('projects the manager snapshot across a live compose, without a second cache', async () => {
    const { ctx, inventory } = await harness()
    expect(inventory.list()).toEqual({ servers: [] })

    await ctx.settings.update(MCP_SETTINGS_NAMESPACE, {
      servers: [
        { transport: 'stdio', serverName: 'one', command: 'echo' },
        { transport: 'streamable-http', serverName: 'two', enabled: false, url: 'http://localhost/mcp' },
      ],
    })

    await vi.waitFor(() => { expect(connections).toHaveLength(1) })
    await vi.waitFor(() => {
      expect(inventory.list()).toEqual({
        servers: [
          { serverName: 'one', transport: 'stdio', enabled: true, connection: 'connected', toolCount: 1 },
          { serverName: 'two', transport: 'streamable-http', enabled: false, connection: null, toolCount: 0 },
        ],
      })
    })
  })
})
