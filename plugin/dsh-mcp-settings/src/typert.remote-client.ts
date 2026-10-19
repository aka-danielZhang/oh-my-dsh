/* Generated-equivalent Typert Client contribution owned by dsh-mcp-settings. */
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { McpInventorySnapshot } from './inventory-types.ts'

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

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6d6370496e76656e746f7279 {
    list: () => Promise<RemoteResult<McpInventorySnapshot>>
  }
  interface TypertRemoteMap {
    'mcpInventory/list': () => Promise<RemoteResult<McpInventorySnapshot>>
  }
  interface TypertRemoteNamespaceMap {
    mcpInventory: TypertRemoteNamespace$6d6370496e76656e746f7279
  }
}

/** Browser Remote descriptor for the mcpInventory namespace. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-mcp-settings',
  descriptors: [{
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
}

export default TYPERT_REMOTE
