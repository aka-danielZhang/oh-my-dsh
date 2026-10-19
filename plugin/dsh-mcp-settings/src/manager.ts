/**
 * Settings-driven MCP server composition. Owns the `mcp` user-settings
 * namespace (`{ servers: [...] }`), composes one mcp-client fiber per enabled
 * entry, and serves the merged status registry through `ctx.mcpManager`.
 *
 * The registry is fed by `mcp-client/status` events — the connection
 * supervisor's own commit points — never by fiber lifecycle: with
 * `failOnStartupError: false` a failing server still reaches an active fiber
 * inside its reconnect loop, so only the supervisor's events distinguish
 * connected, reconnecting, and exhausted.
 *
 * @module dsh-mcp-settings/manager
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import type { McpClientStatus, McpServerEntry, McpSettings, McpServerStatus } from './manager-types.ts'

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export type { McpServerEntry, McpSettings, McpServerStatus } from './manager-types.ts'
export type { StdioMcpServerEntry, HttpMcpServerEntry } from './manager-types.ts'

/** Settings namespace owned by this service. */
export const MCP_SETTINGS_NAMESPACE = 'mcp' as SettingsNamespace

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Settings-driven MCP server manager. */
    mcpManager: McpManagerService
  }
  interface Events {
    /** @mode emit */
    'mcp-client/status'(serverName: string, status: McpClientStatus, toolCount: number): void
  }
}

/** Matches mcp-client's per-tool-call default; its Config schema is the final gate at spawn. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
/** Mirrors the credential service's POSIX-portable reference-name contract. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
/**
 * Mirrors mcp-client's reconnect defaults. Mirrored (not imported) so the
 * manager loads against any published mcp-client build; the spawned plugin's
 * own Config schema stays the final gate at spawn.
 */
const RECONNECT_DEFAULTS: Required<ReconnectConfig> = {
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 10,
}
/** Mirrors mcp-client's `serverName` contract (kept below the public tool-name budget). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

const Reconnect = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})

/**
 * Section schema: a mirror of mcp-client's transport union plus the
 * manager-owned `enabled` switch. The spawned plugin object still carries
 * mcp-client's own `Config`, so a drifted mirror cannot let an invalid entry
 * through — it only moves the failure from the settings write to the spawn.
 */
/** Composition and settings schema for the managed MCP server list. */
export const Config: z<McpSettings> = z.object({
  servers: z.array(z.union([
    z.object({
      transport: z.const('stdio'),
      serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
      enabled: z.boolean().default(true),
      command: z.string().required(),
      args: z.array(String).default([]),
      env: z.dict(String).default({}),
      envCredentialRefs: z.dict(z.string().pattern(CREDENTIAL_REF_PATTERN).role('credential-ref')).default({}),
      cwd: z.string().default(''),
      toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
      reconnect: Reconnect,
    }),
    z.object({
      transport: z.const('streamable-http'),
      serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
      enabled: z.boolean().default(true),
      url: z.string().required(),
      headers: z.dict(String).default({}),
      authorizationCredentialRef: z.string().pattern(CREDENTIAL_REF_PATTERN).role('credential-ref'),
      toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
      reconnect: Reconnect,
    }),
  ])).default([]).volatile(),
}) as unknown as z<McpSettings>

/** Composition entry: the fallback when no settings provider is mounted. */
const EMPTY_SETTINGS: McpSettings = Object.freeze({ servers: Object.freeze([]) })

/** Runtime state of one configured serverName. */
interface ManagedServer {
  /** Spawned mcp-client fiber; undefined while disabled or after a refused spawn. */
  fiber: Fiber | undefined
  /** Last committed connection status from the supervisor's event. */
  connection: McpServerStatus['connection']
  /** Live tool registration count from the supervisor's event. */
  toolCount: number
}

/** Preserve exact-optional semantics when forwarding the resolved reconnect policy. */
function optionalReconnect(reconnect: ReconnectConfig | undefined): { reconnect?: ReconnectConfig } {
  /* v8 ignore else -- the settings schema materializes its reconnect default before manager resync. */
  if (reconnect !== undefined) return { reconnect }
  /* v8 ignore next -- direct omission is accepted only by the exported settings DTO, not a resolved section. */
  return {}
}

/** Resolve one configured credential reference without exposing its value in diagnostics. */
async function resolveCredential(ctx: Context, ref: string, serverName: string): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(`mcp-manager: mcp-client(${serverName}) requires credential "${ref}", but no credentials service is mounted`)
  }
  const resolved = await credentials.resolve(credentialRef(ref))
  if (resolved === undefined) {
    throw new Error(`mcp-manager: mcp-client(${serverName}) credential "${ref}" is not configured`)
  }
  return resolved.value
}

/** Map one settings entry to the mcp-client plugin config and resolve credential projections. */
async function toClientConfig(ctx: Context, entry: McpServerEntry): Promise<McpClient.Config> {
  const shared = {
    serverName: entry.serverName,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    // A slow-starting server must reach the reconnect loop rather than fail
    // the fiber: the status event carries the connection truth instead.
    failOnStartupError: false,
    ...optionalReconnect(entry.reconnect),
  }
  if (entry.transport === 'stdio') {
    const env = { ...entry.env }
    for (const [name, ref] of Object.entries(entry.envCredentialRefs ?? {})) {
      env[name] = await resolveCredential(ctx, ref, entry.serverName)
    }
    return {
      transport: 'stdio',
      ...shared,
      command: entry.command,
      args: [...entry.args],
      env,
      cwd: entry.cwd,
    }
  }
  const headers = { ...entry.headers }
  if (entry.authorizationCredentialRef !== undefined) {
    // HTTP field names are case-insensitive. A credential reference is the
    // authoritative Authorization source, so remove every literal variant.
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'authorization') delete headers[name]
    }
    headers.Authorization = `Bearer ${await resolveCredential(ctx, entry.authorizationCredentialRef, entry.serverName)}`
  }
  return {
    transport: 'streamable-http',
    ...shared,
    url: entry.url,
    headers,
  }
}

/**
 * Composes MCP servers from the `mcp` settings section and serves their
 * merged status (`ctx.mcpManager`).
 */
export class McpManagerService extends Service {
  /** Validates the profile-owned base server list. */
  static Config = Config

  /** Runtime registry keyed by configured serverName. */
  private readonly runtime = new Map<string, ManagedServer>()
  /** Last-synced configured servers, in settings order. */
  private configured: readonly McpServerEntry[] = EMPTY_SETTINGS.servers
  /** Serializes resyncs so rapid settings changes cannot interleave. */
  private syncTail: Promise<void> = Promise.resolve()
  /** Server names whose projected credentials changed and require a fresh client. */
  private readonly credentialInvalidations = new Set<string>()
  /** Set synchronously when this service starts unloading. */
  private disposing = false
  /** Reads the resolved settings section; installSection initializes it synchronously. */
  private readSettings!: () => McpSettings

  constructor(ctx: Context, config: McpSettings = EMPTY_SETTINGS) {
    super(ctx, 'mcpManager')

    // Subscribe before any spawn can run so a fast-failing server's first
    // status event is not missed. Events only update state; removal runs in
    // this service's own sync path, so a renamed server's late 'disposed'
    // event lands on the outgoing entry rather than its replacement.
    ctx.on('mcp-client/status', (serverName, status, toolCount) => {
      const managed = this.runtime.get(serverName)
      if (managed === undefined) return
      managed.connection = status
      managed.toolCount = toolCount
    })

    // Projected credentials are resolved at process/connect time. Restart only
    // clients that reference the changed value so rotations take effect.
    ctx.on('credentials/reference-updated', (ref) => {
      for (const entry of this.configured) {
        const usesRef = entry.transport === 'stdio'
          ? Object.values(entry.envCredentialRefs ?? {}).includes(ref)
          : entry.authorizationCredentialRef === ref
        if (usesRef) this.credentialInvalidations.add(entry.serverName)
      }
      if (this.credentialInvalidations.size > 0) this.enqueueResync()
    })

    // The profile loader starts rows concurrently, so the settings provider
    // (an earlier row) can wake this manager's first resync before the
    // credentials provider (a later row) has mounted: every
    // credential-dependent spawn is then refused once, with no later event to
    // retry it. One extra resync once the credentials service is available
    // re-spawns exactly those refused rows — a live fiber carries over, so
    // established connections are untouched.
    ctx.inject(['credentials'], () => { this.enqueueResync() })

    // The servers list is this entry's own configuration: the volatile
    // object is the live read (profile writes re-resolve it in place), and
    // document updates are the resync signal. Without a config document
    // (headless) the composition entry stands.
    this.readSettings = () => {
      // Schema resolution hands volatile fields over as live references;
      // plain mounts (tests, direct compositions) carry the raw array.
      const raw = (config as { servers?: unknown }).servers
      const servers = typeof (raw as { get?: unknown } | undefined)?.get === 'function'
        ? (raw as unknown as { get(): McpServerEntry[] }).get()
        : raw
      return { servers: (servers ?? []) as McpServerEntry[] }
    }
    ctx.on('settings/document-updated', (ns: string) => {
      if (ns === MCP_SETTINGS_NAMESPACE) this.enqueueResync()
    })
    // Compose whatever the entry configuration already carries; later
    // document updates resync through the listener above.
    this.enqueueResync()

    // Child fibers ride this service's fiber as effects; mark disposal before
    // the first await so in-flight credential resolution cannot spawn later.
    ctx.effect(() => async () => {
      this.disposing = true
      await this.disposeAll()
    }, 'mcpManager.fibers()')
  }

  /**
   * Merged view for read-only consumers: every configured server with its
   * live connection status, in settings order.
   * @returns one status row per configured server, disabled rows included.
   */
  snapshot(): McpServerStatus[] {
    return this.configured.map((entry) => {
      const managed = entry.enabled ? this.runtime.get(entry.serverName) : undefined
      return {
        serverName: entry.serverName,
        transport: entry.transport,
        enabled: entry.enabled,
        connection: managed === undefined ? null : managed.connection,
        toolCount: managed === undefined ? 0 : managed.toolCount,
      }
    })
  }

  /** Queue one resync; a resync failure is logged and never escapes the caller. */
  private enqueueResync(): void {
    if (this.disposing) return
    this.syncTail = this.syncTail.then(() => this.resync()).catch((error: unknown) => {
      this.ctx.logger.error(`mcp-manager: resync failed: ${String(error)}`)
    })
  }

  /**
   * Apply the configured server list: release removed, changed, and refused
   * fibers first, then swap the registry, then spawn the new composition.
   * Disposing before the swap keeps a released fiber's late 'disposed' event
   * off the replacement that may reuse its name.
   */
  private async resync(): Promise<void> {
    if (this.disposing) return
    const next = this.readSettings().servers
    const previous = this.configured
    const credentialInvalidations = new Set(this.credentialInvalidations)
    this.credentialInvalidations.clear()
    const previousByName = new Map(previous.map(entry => [entry.serverName, entry] as const))

    // A duplicated serverName is an ambiguous document: refuse both copies
    // loudly rather than picking a winner.
    const occurrences = new Map<string, number>()
    for (const entry of next) occurrences.set(entry.serverName, (occurrences.get(entry.serverName) ?? 0) + 1)

    const nextRuntime = new Map<string, ManagedServer>()
    const toDispose: Fiber[] = []
    const toSpawn: McpServerEntry[] = []
    const decided = new Set<string>()

    for (const entry of next) {
      const { serverName } = entry
      if (decided.has(serverName)) continue
      decided.add(serverName)

      /* v8 ignore next -- occurrences was populated from every entry in this same list. */
      const duplicated = (occurrences.get(serverName) ?? 0) > 1
      const previousEntry = previousByName.get(serverName)
      const managed = this.runtime.get(serverName)
      // Only a live fiber with identical config carries over; a disabled,
      // refused, or failed composition re-decides so the new document wins.
      const unchanged = !duplicated
        && !credentialInvalidations.has(serverName)
        && previousEntry !== undefined
        && managed?.fiber !== undefined
        && sameJson(previousEntry, entry)

      if (unchanged) {
        nextRuntime.set(serverName, managed)
        continue
      }

      if (managed?.fiber !== undefined) toDispose.push(managed.fiber)

      if (duplicated) {
        this.ctx.logger.error(
          `mcp-manager: serverName "${serverName}" appears more than once in the mcp settings section — refusing to compose it until the document carries one entry`,
        )
        nextRuntime.set(serverName, { fiber: undefined, connection: 'failed', toolCount: 0 })
        continue
      }

      if (!entry.enabled) {
        nextRuntime.set(serverName, { fiber: undefined, connection: null, toolCount: 0 })
        continue
      }

      // The placeholder claims the name before the spawn so early status
      // events already land on the new entry; the spawn fills in the fiber.
      nextRuntime.set(serverName, { fiber: undefined, connection: 'connecting', toolCount: 0 })
      toSpawn.push(entry)
    }

    // Names absent from the document release their fibers.
    for (const [name, managed] of this.runtime) {
      if (nextRuntime.has(name)) continue
      if (managed.fiber !== undefined) toDispose.push(managed.fiber)
    }

    await Promise.all(toDispose.map(fiber => fiber.dispose()))
    if (this.disposing) return

    this.runtime.clear()
    for (const [name, managed] of nextRuntime) this.runtime.set(name, managed)
    this.configured = next

    // Spawn after the swap: the new fibers' status events must find the new
    // entries, never a same-named predecessor mid-disposal. Credential stores
    // are independent, so one slow resolution must not block other servers.
    await Promise.all(toSpawn.map(async (entry) => {
      const managed = this.runtime.get(entry.serverName)
      /* v8 ignore next -- toSpawn is filled only after nextRuntime claims this exact serverName. */
      if (managed !== undefined) await this.spawnInto(entry, managed)
    }))
  }

  /**
   * Spawn one mcp-client fiber into a prepared runtime record. A spawn or
   * load failure is recorded on the entry and logged; it never escapes.
   * @param entry - the enabled settings entry to compose.
   * @param managed - the placeholder record claimed for this entry.
   */
  private async spawnInto(entry: McpServerEntry, managed: ManagedServer): Promise<void> {
    try {
      const config = await toClientConfig(this.ctx, entry)
      if (this.disposing || this.runtime.get(entry.serverName) !== managed) return
      const fiber = this.ctx.plugin({
        name: McpClient.name,
        inject: McpClient.inject,
        apply: McpClient.apply,
        Config: McpClient.Config,
      }, config)
      if (this.disposing || this.runtime.get(entry.serverName) !== managed) {
        await fiber.dispose()
        return
      }
      managed.fiber = fiber
      // Config validation and startup failures settle the fiber without ever
      // running the supervisor, so surface them through the fiber itself.
      void fiber.await().then(
        () => {},
        (error: unknown) => {
          if (this.disposing || this.runtime.get(entry.serverName) !== managed) return
          managed.connection = 'failed'
          managed.toolCount = 0
          this.ctx.logger.error(`mcp-manager: mcp-client(${entry.serverName}) failed to load: ${String(error)}`)
        },
      )
    } catch (error) {
      if (this.disposing || this.runtime.get(entry.serverName) !== managed) return
      managed.connection = 'failed'
      this.ctx.logger.error(`mcp-manager: spawn mcp-client(${entry.serverName}) failed: ${String(error)}`)
    }
  }

  /** Dispose every spawned fiber and empty the registry; awaits full teardown. */
  private async disposeAll(): Promise<void> {
    const fibers: Fiber[] = []
    for (const managed of this.runtime.values()) {
      if (managed.fiber !== undefined) fibers.push(managed.fiber)
    }
    this.runtime.clear()
    this.configured = EMPTY_SETTINGS.servers
    this.credentialInvalidations.clear()
    await Promise.all(fibers.map(fiber => fiber.dispose()))
  }
}

export default McpManagerService
