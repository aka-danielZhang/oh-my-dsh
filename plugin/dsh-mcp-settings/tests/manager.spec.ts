/**
 * Tests for the settings-driven composition: spawn per enabled entry, merged
 * snapshot rows (disabled included), diff-driven respawn/removal, duplicate
 * refusal, load-failure isolation, and unload disposing every spawned fiber.
 * Isolated file so vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

// ---- mcp-client stand-in (config-aliased, see tests/mcp-client-fake.ts) ----
import { connections, receivedConfigs, resetFake } from './mcp-client-fake.ts'

// vi.mock is hoisted above static imports, so the modules under test see the
// mocked SDK even through a static import.
import McpManagerService, { MCP_SETTINGS_NAMESPACE, type McpSettings } from '../src/manager.ts'

// ---- Helpers ----

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

/** Minimal writable credential provider for projection tests. */
class MemoryCredentials extends CredentialProvider {
  protected readonly values = new Map<CredentialRef, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values.has(ref), source: 'memory', writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    this.notifyUpdated(ref)
    return Promise.resolve()
  }

  readRecord() {
    return Promise.resolve(undefined)
  }

  describeRecord() {
    return Promise.resolve({ configured: false, writable: true })
  }

  listRecords() {
    return Promise.resolve([])
  }

  async modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ) {
    return mutate(undefined)
  }

  deleteRecord() {
    return Promise.resolve()
  }
}

function stdioEntry(serverName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { transport: 'stdio', serverName, command: 'echo', ...extra }
}

async function boot(config?: McpSettings): Promise<{ ctx: Context; managerFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryCredentials)
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const managerFiber = ctx.plugin(McpManagerService, config)
  await managerFiber.await()
  return { ctx, managerFiber }
}

async function writeServers(ctx: Context, servers: unknown[]): Promise<void> {
  await ctx.settings.update(MCP_SETTINGS_NAMESPACE, { servers })
}

/** Capture the manager's logger error lines on one context. */
function captureErrors(ctx: Context): string[] {
  const errors: string[] = []
  ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  return errors
}

// ---- Tests ----

describe('mcp-manager composition base', () => {
  it('composes profile-defined servers and exposes them through the settings section', async () => {
    vi.clearAllMocks()
    resetFake()
    const { ctx } = await boot({
      servers: [{
        transport: 'stdio', serverName: 'profile-server', enabled: true,
        command: 'echo', args: [], env: {}, cwd: '', toolCallTimeoutMs: 60_000,
      }],
    })

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })
    expect(ctx.settings.describe().find(section => section.ns === MCP_SETTINGS_NAMESPACE)?.value)
      .toMatchObject({ servers: [expect.objectContaining({ serverName: 'profile-server' })] })
    await ctx.fiber.dispose()
  })
})

describe('mcp-manager composition', () => {
  let ctx: Context
  let managerFiber: Fiber

  beforeEach(async () => {
    vi.clearAllMocks()
    resetFake()
    ;({ ctx, managerFiber } = await boot())
  })

  it('spawns one fiber per enabled entry and reports supervisor status', async () => {
    await writeServers(ctx, [stdioEntry('srv')])

    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()).toEqual([
        { serverName: 'srv', transport: 'stdio', enabled: true, connection: 'connected', toolCount: 1 },
      ])
    })
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    expect(connections).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('shows a disabled entry with a null connection and composes nothing', async () => {
    await writeServers(ctx, [stdioEntry('srv', { enabled: false })])

    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()).toEqual([
        { serverName: 'srv', transport: 'stdio', enabled: false, connection: null, toolCount: 0 },
      ])
    })
    expect(connections).toHaveLength(0)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('releases the fiber and the row when the entry leaves the document', async () => {
    await writeServers(ctx, [stdioEntry('srv')])
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })

    await writeServers(ctx, [])

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()).toEqual([]) })
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('re-spawns a changed entry, replacing the previous fiber', async () => {
    await writeServers(ctx, [stdioEntry('srv')])
    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })

    await writeServers(ctx, [stdioEntry('srv', { command: 'echo2' })])

    await vi.waitFor(() => { expect(connections).toHaveLength(2) })
    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()).toEqual([
        { serverName: 'srv', transport: 'stdio', enabled: true, connection: 'connected', toolCount: 1 },
      ])
    })
    await ctx.fiber.dispose()
  })

  it('keeps an unchanged entry on its live fiber across unrelated edits', async () => {
    await writeServers(ctx, [stdioEntry('one'), stdioEntry('two')])
    await vi.waitFor(() => { expect(connections).toHaveLength(2) })

    await writeServers(ctx, [stdioEntry('one'), stdioEntry('two', { command: 'echo2' })])

    await vi.waitFor(() => { expect(connections).toHaveLength(3) })
    // 'one' kept its fiber; only 'two' was re-spawned.
    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot().map(row => row.serverName)).toEqual(['one', 'two'])
    })
    await ctx.fiber.dispose()
  })

  it('refuses a duplicated serverName without disposing the manager', async () => {
    const errors = captureErrors(ctx)
    await writeServers(ctx, [stdioEntry('srv'), stdioEntry('srv', { command: 'echo2' })])

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('appears more than once'))).toBe(true)
    })
    await vi.waitFor(() => {
      for (const row of ctx.mcpManager.snapshot()) {
        expect(row.connection).toBe('failed')
        expect(row.toolCount).toBe(0)
      }
    })
    expect(connections).toHaveLength(0)
    await writeServers(ctx, [])
    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()).toEqual([]) })
    await ctx.fiber.dispose()
  })

  it('records a load failure from mcp-client validation and keeps serving', async () => {
    const errors = captureErrors(ctx)
    // Passes this package's per-field bounds but fails mcp-client's
    // cross-field reconnect rule at load, so the fiber settles FAILED.
    await writeServers(ctx, [stdioEntry('srv', { reconnect: { initialDelayMs: 5_000, maxDelayMs: 100 } })])

    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('failed')
    })
    expect(errors.some(line => line.includes('failed to load'))).toBe(true)
    expect(ctx.mcpManager.snapshot()[0]?.toolCount).toBe(0)
    await ctx.fiber.dispose()
  })

  it('reflects the supervisor reconnecting state through the registry', async () => {
    await writeServers(ctx, [stdioEntry('srv')])
    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })

    connections[0]!.drop()

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('reconnecting') })
    await ctx.fiber.dispose()
  })

  it('composes a Streamable HTTP entry with headers and default reconnect policy', async () => {
    await writeServers(ctx, [{
      transport: 'streamable-http', serverName: 'http', url: 'http://localhost/mcp',
      headers: { Authorization: 'Bearer test' },
    }])

    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()).toEqual([
        { serverName: 'http', transport: 'streamable-http', enabled: true, connection: 'connected', toolCount: 1 },
      ])
    })
    expect(ctx.tools.get('mcp__http__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('resolves a credential reference into the HTTP Authorization header', async () => {
    await ctx.credentials.set(credentialRef('TEST_KEY'), 'secret-value')
    await writeServers(ctx, [{
      transport: 'streamable-http', serverName: 'http-auth', url: 'https://example.test/mcp',
      headers: { 'X-Test': 'present', authorization: 'Bearer stale' }, authorizationCredentialRef: 'TEST_KEY',
    }])

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })
    const composed = receivedConfigs.find(config => config.serverName === 'http-auth')
    expect(composed?.headers).toEqual({ 'X-Test': 'present', Authorization: 'Bearer secret-value' })
    await ctx.fiber.dispose()
  })

  it('resolves credential references into the stdio child environment', async () => {
    await ctx.credentials.set(credentialRef('TEST_KEY'), 'secret-value')
    await writeServers(ctx, [stdioEntry('stdio-auth', {
      env: { STATIC: 'present' }, envCredentialRefs: { Z_AI_API_KEY: 'TEST_KEY' },
    })])

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })
    const composed = receivedConfigs.find(config => config.serverName === 'stdio-auth')
    expect(composed?.env).toMatchObject({ STATIC: 'present', Z_AI_API_KEY: 'secret-value' })
    await ctx.fiber.dispose()
  })

  it('marks a server failed when its credential reference is missing', async () => {
    const errors = captureErrors(ctx)
    await writeServers(ctx, [{
      transport: 'streamable-http', serverName: 'missing-auth', url: 'https://example.test/mcp',
      authorizationCredentialRef: 'MISSING_KEY',
    }])

    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('failed') })
    expect(errors.some(line => line.includes('credential "MISSING_KEY" is not configured'))).toBe(true)
    expect(String(errors)).not.toContain('secret-value')
    await ctx.fiber.dispose()
  })

  it('rejects malformed credential references before composition', async () => {
    await expect(writeServers(ctx, [{
      transport: 'streamable-http', serverName: 'bad-auth', url: 'https://example.test/mcp',
      authorizationCredentialRef: 'bad-ref',
    }])).rejects.toThrow()
    expect(ctx.mcpManager.snapshot()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('restarts only a referencing server when its credential rotates', async () => {
    const ref = credentialRef('TEST_KEY')
    await ctx.credentials.set(ref, 'first-value')
    await writeServers(ctx, [{
      transport: 'streamable-http', serverName: 'http-auth', url: 'https://example.test/mcp',
      authorizationCredentialRef: 'TEST_KEY',
    }])
    await vi.waitFor(() => { expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('connected') })

    await ctx.credentials.set(ref, 'second-value')

    await vi.waitFor(() => { expect(connections).toHaveLength(2) })
    const last = receivedConfigs.filter(config => config.serverName === 'http-auth').at(-1)
    expect(last?.headers).toEqual({ Authorization: 'Bearer second-value' })
    await ctx.fiber.dispose()
  })

  it('retries refused credential-dependent spawns once the credentials service mounts', async () => {
    // The loader starts profile rows concurrently: the settings provider can
    // wake the manager's first resync before the credentials provider mounts,
    // refusing credential-dependent spawns with no retry. The manager must
    // re-sync when the credentials service becomes available.
    class SeededCredentials extends MemoryCredentials {
      constructor(ctx: Context) {
        super(ctx)
        this.values.set(credentialRef('TEST_KEY'), 'secret-value')
      }
    }

    const late = new Context()
    await late.plugin(SystemPrompt)
    await late.plugin(ToolRuntime)
    const settingsFiber = late.plugin(MemorySettings)
    await settingsFiber.await()
    const managerFiber = late.plugin(McpManagerService)
    await managerFiber.await()
    const errors = captureErrors(late)

    await late.settings.update(MCP_SETTINGS_NAMESPACE, { servers: [{
      transport: 'streamable-http', serverName: 'http-auth', url: 'https://example.test/mcp',
      authorizationCredentialRef: 'TEST_KEY',
    }] })
    await vi.waitFor(() => { expect(late.mcpManager.snapshot()[0]?.connection).toBe('failed') })
    expect(errors.some(line => line.includes('no credentials service is mounted'))).toBe(true)
    expect(receivedConfigs).toHaveLength(0)

    await late.plugin(SeededCredentials)

    await vi.waitFor(() => { expect(late.mcpManager.snapshot()[0]?.connection).toBe('connected') })
    const composed = receivedConfigs.find(config => config.serverName === 'http-auth')
    expect(composed?.headers).toEqual({ Authorization: 'Bearer secret-value' })
    await late.fiber.dispose()
  })

  it('does not spawn after disposal while credential resolution is pending', async () => {
    let resolveCredential!: (value: ResolvedCredential) => void
    const pendingCredential = new Promise<ResolvedCredential>((resolve) => { resolveCredential = resolve })
    const resolve = vi.spyOn(ctx.credentials, 'resolve').mockReturnValueOnce(pendingCredential)
    await writeServers(ctx, [stdioEntry('delayed', { envCredentialRefs: { API_KEY: 'TEST_KEY' } })])
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledWith(credentialRef('TEST_KEY')) })

    await managerFiber.dispose()
    resolveCredential({ value: 'late-value', source: 'memory' })
    await Promise.resolve()
    await Promise.resolve()

    expect(receivedConfigs).toHaveLength(0)
    expect(ctx.get('mcpManager')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('ignores status for an unmanaged serverName', async () => {
    ctx.emit('mcp-client/status', 'missing', 'failed', 7)
    expect(ctx.mcpManager.snapshot()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('contains and logs a resync source failure', async () => {
    const errors = captureErrors(ctx)
    const manager = ctx.mcpManager as unknown as {
      readSettings: () => { servers: readonly unknown[] }
      enqueueResync(): void
    }
    manager.readSettings = () => { throw new Error('settings exploded') }
    manager.enqueueResync()

    await vi.waitFor(() => {
      expect(errors.some(line => line.includes('resync failed: Error: settings exploded'))).toBe(true)
    })
    await ctx.fiber.dispose()
  })

  it('records a synchronous client spawn failure without escaping the settings write', async () => {
    const errors = captureErrors(ctx)
    const plugin = vi.spyOn(ctx, 'plugin')
    plugin.mockImplementationOnce(() => { throw new Error('spawn exploded') })

    await writeServers(ctx, [stdioEntry('srv')])

    await vi.waitFor(() => {
      expect(ctx.mcpManager.snapshot()[0]?.connection).toBe('failed')
    })
    expect(errors.some(line => line.includes('spawn mcp-client(srv) failed: Error: spawn exploded'))).toBe(true)
    plugin.mockRestore()
    await ctx.fiber.dispose()
  })

  it('disposing the manager unloads every spawned mcp-client fiber (HMR disposal proof)', async () => {
    await writeServers(ctx, [stdioEntry('one'), stdioEntry('two')])
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__one__remote')).toBeDefined()
      expect(ctx.tools.get('mcp__two__remote')).toBeDefined()
    })

    await managerFiber.dispose()

    expect(ctx.tools.get('mcp__one__remote')).toBeUndefined()
    expect(ctx.tools.get('mcp__two__remote')).toBeUndefined()
    expect(ctx.get('mcpManager')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('an absent settings provider leaves the manager idle with an empty snapshot', async () => {
    const bare = new Context()
    await bare.plugin(SystemPrompt)
    await bare.plugin(ToolRuntime)
    const fiber = bare.plugin(McpManagerService)
    await fiber.await()

    expect(bare.mcpManager.snapshot()).toEqual([])
    await bare.fiber.dispose()
  })
})
