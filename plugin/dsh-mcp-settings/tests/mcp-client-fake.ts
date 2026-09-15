/**
 * Config-aliased stand-in for `@deepseek-ai/dsh-mcp-client`: the manager's
 * import resolves here (vitest `resolve.alias`), so tests drive the
 * supervisor's status events directly. Mocking the real lib's SDK imports is
 * not reachable — the published lib is externalized CJS whose require chain
 * bypasses both vi.mock and the vite resolver.
 */

export interface FakeConnection {
  readonly serverName: string
  status: string
  /** Simulate a lost transport: reconnecting now, connected again next tick. */
  drop(): void
}

export const connections: FakeConnection[] = []
/** The configs the manager handed to `apply`, in spawn order. */
export const receivedConfigs: Array<Record<string, unknown>> = []

export function resetFake(): void {
  connections.length = 0
  receivedConfigs.length = 0
}

function toolNameOf(config: Record<string, unknown>): string {
  return `mcp__${String(config.serverName)}__remote`
}

/** Mirrors mcp-client's cross-field reconnect rule so load-failure coverage keeps a validation throw. */
function validate(config: Record<string, unknown>): void {
  const reconnect = config.reconnect as { initialDelayMs?: number; maxDelayMs?: number } | undefined
  if (reconnect !== undefined
    && typeof reconnect.initialDelayMs === 'number'
    && typeof reconnect.maxDelayMs === 'number'
    && reconnect.initialDelayMs > reconnect.maxDelayMs) {
    throw new Error('reconnect.initialDelayMs must not exceed reconnect.maxDelayMs')
  }
}

export function apply(ctx: {
  emit: (event: string, ...args: unknown[]) => void
  tools: { register: (definition: unknown) => () => void }
}, rawConfig: Record<string, unknown>): () => void {
  validate(rawConfig)
  receivedConfigs.push(rawConfig)

  const serverName = String(rawConfig.serverName)
  const emit = (status: string, toolCount: number): void => {
    ctx.emit('mcp-client/status', serverName, status, toolCount)
  }

  const connection: FakeConnection = {
    serverName,
    status: 'connecting',
    drop() {
      connection.status = 'reconnecting'
      emit('reconnecting', 1)
      setTimeout(() => {
        if (connection.disposed) return
        connection.status = 'connected'
        emit('connected', 1)
      }, 0)
    },
  }
  let disposed = false
  Object.defineProperty(connection, 'disposed', { get: () => disposed })
  connections.push(connection)

  const unregister = ctx.tools.register({
    name: toolNameOf(rawConfig),
    description: 'fake MCP tool registered by the test stand-in',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'fake' }],
    },
    execute: async () => ({ content: [] }),
  })

  emit('connecting', 1)
  setTimeout(() => {
    if (disposed) return
    connection.status = 'connected'
    emit('connected', 1)
  }, 0)

  return () => {
    disposed = true
    connection.status = 'disposed'
    unregister()
    emit('disposed', 0)
  }
}

export const name = '@deepseek-ai/dsh-mcp-client'
export const inject: readonly string[] = ["tools"]
export const Config = {
  /** cordis consumes the Standard Schema interface (`Config["~standard"].validate`). */
  validate(data: Record<string, unknown>): Record<string, unknown> {
    validate(data)
    return data
  },
  '~standard': {
    version: 1,
    vendor: 'mcp-client-fake',
    validate(data: Record<string, unknown>): { value: Record<string, unknown> } | { issues: Array<{ message: string }> } {
      try {
        validate(data)
        return { value: data }
      } catch (error) {
        return { issues: [{ message: String(error) }] }
      }
    },
  },
}
