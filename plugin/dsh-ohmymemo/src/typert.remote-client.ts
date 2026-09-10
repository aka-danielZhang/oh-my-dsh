/** Strict browser Remote descriptors for the OhMyMemo UI gateway. */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import {
  cancelRunResultSchema,
  dreamModelsSchema,
  memoryDocumentSchema,
  memoryOverviewSchema,
  memoryTreeSchema,
  readMemoryFileRequestSchema,
  runNowResultSchema,
  updateDreamSettingsRequestSchema,
  type CancelRunResult,
  type DreamModelsSnapshot,
  type MemoryDocument,
  type MemoryOverview,
  type MemoryTreeSnapshot,
  type ReadMemoryFileRequest,
  type RunNowResult,
  type UpdateDreamSettingsRequest,
} from './manager-contract.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$6f684d794d656d6f5569 {
    overview: () => Promise<RemoteResult<MemoryOverview>>
    updateDreamSettings: (request: UpdateDreamSettingsRequest) => Promise<RemoteResult<MemoryOverview>>
    models: () => Promise<RemoteResult<DreamModelsSnapshot>>
    tree: () => Promise<RemoteResult<MemoryTreeSnapshot>>
    read: (request: ReadMemoryFileRequest) => Promise<RemoteResult<MemoryDocument>>
    runNow: () => Promise<RemoteResult<RunNowResult>>
    cancelRun: () => Promise<RemoteResult<CancelRunResult>>
  }
  interface TypertRemoteMap {
    'ohMyMemoUi/overview': () => Promise<RemoteResult<MemoryOverview>>
    'ohMyMemoUi/updateDreamSettings': (request: UpdateDreamSettingsRequest) => Promise<RemoteResult<MemoryOverview>>
    'ohMyMemoUi/models': () => Promise<RemoteResult<DreamModelsSnapshot>>
    'ohMyMemoUi/tree': () => Promise<RemoteResult<MemoryTreeSnapshot>>
    'ohMyMemoUi/read': (request: ReadMemoryFileRequest) => Promise<RemoteResult<MemoryDocument>>
    'ohMyMemoUi/runNow': () => Promise<RemoteResult<RunNowResult>>
    'ohMyMemoUi/cancelRun': () => Promise<RemoteResult<CancelRunResult>>
  }
  interface TypertRemoteNamespaceMap {
    ohMyMemoUi: TypertRemoteNamespace$6f684d794d656d6f5569
  }
}

const direct = { kind: 'direct' } as const
const noParameters: [] = []

function parameter(name: string, schema: { parse(value: unknown): unknown }, typeSymbol: string) {
  return [{
    name,
    wire: name,
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol, schema },
  }]
}

/** Browser contribution mounted before reading `remote.ohMyMemoUi`. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-ohmymemo',
  descriptors: [
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/overview', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'overview',
      invocation: direct, parameters: noParameters,
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#MemoryOverview', schema: memoryOverviewSchema },
      sourceLocation: { file: 'src/manager.ts', line: 248, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/updateDreamSettings', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'updateDreamSettings',
      invocation: direct,
      parameters: parameter('request', updateDreamSettingsRequestSchema, 'dsh-ohmymemo/manager-contract#UpdateDreamSettingsRequest'),
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#MemoryOverview', schema: memoryOverviewSchema },
      sourceLocation: { file: 'src/manager.ts', line: 281, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/models', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'models',
      invocation: direct, parameters: noParameters,
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#DreamModelsSnapshot', schema: dreamModelsSchema },
      sourceLocation: { file: 'src/manager.ts', line: 298, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/tree', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'tree',
      invocation: direct, parameters: noParameters,
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#MemoryTreeSnapshot', schema: memoryTreeSchema },
      sourceLocation: { file: 'src/manager.ts', line: 335, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/read', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'read',
      invocation: direct,
      parameters: parameter('request', readMemoryFileRequestSchema, 'dsh-ohmymemo/manager-contract#ReadMemoryFileRequest'),
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#MemoryDocument', schema: memoryDocumentSchema },
      sourceLocation: { file: 'src/manager.ts', line: 340, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/runNow', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'runNow',
      invocation: direct, parameters: noParameters,
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#RunNowResult', schema: runNowResultSchema },
      sourceLocation: { file: 'src/manager.ts', line: 348, column: 3 },
    },
    {
      id: 'dsh-ohmymemo#ohMyMemoUi/cancelRun', service: 'ohMyMemoUi', namespace: 'ohMyMemoUi', method: 'cancelRun',
      invocation: direct, parameters: noParameters,
      result: { mode: 'strict', typeSymbol: 'dsh-ohmymemo/manager-contract#CancelRunResult', schema: cancelRunResultSchema },
      sourceLocation: { file: 'src/manager.ts', line: 362, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
