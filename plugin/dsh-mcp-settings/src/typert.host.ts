/* Generated-equivalent Typert Host contribution owned by dsh-mcp-settings. */
import { z } from 'zod'

const resultSchema = z.object({
  servers: z.array(z.object({
    serverName: z.string().readonly(),
    transport: z.union([z.literal('stdio'), z.literal('streamable-http')]).readonly(),
    enabled: z.boolean().readonly(),
    connection: z.union([
      z.literal(null), z.literal('failed'), z.literal('connecting'), z.literal('connected'),
      z.literal('reconnecting'), z.literal('disposed'),
    ]).readonly(),
    toolCount: z.number().readonly(),
  })).readonly(),
})

/** Host Typert descriptor for the mcpInventory Remote. */
export const TYPERT = {
  package: 'dsh-mcp-settings',
  face: 'host',
  schemas: [],
  invocations: [{
    id: 'dsh-mcp-settings#mcpInventory/list',
    service: 'mcpInventory',
    namespace: 'mcpInventory',
    method: 'list',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: 'dsh-mcp-settings/inventory-types#McpInventorySnapshot',
      create: () => resultSchema,
    },
    sourceLocation: { file: 'src/inventory.ts', line: 31, column: 3 },
  }],
  model: { services: [], events: [], objects: [] },
}
