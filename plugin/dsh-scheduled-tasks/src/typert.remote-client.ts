/**
 * Browser Remote contribution for the `scheduledTasks` namespace — the
 * single source of truth for the wire shape, shared by the browser half's
 * `ctx.remote.$mount` (./client/index.ts) and the Host's strict registration
 * (./typert.host.ts). Schemas live in ./contract.ts next to the durable
 * records so wire and storage cannot drift.
 * @module dsh-scheduled-tasks/typert.remote-client
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  CatalogSnapshot,
  CreateTaskRequest,
  ListSnapshot,
  RemoveTaskRequest,
  SetEnabledRequest,
  TaskIdRequest,
  UpdateTaskRequest,
  UserTaskRow,
} from './contract.ts'
import {
  catalogSnapshotSchema,
  createTaskRequestSchema,
  listSnapshotSchema,
  removeTaskRequestSchema,
  setEnabledRequestSchema,
  taskIdRequestSchema,
  updateTaskRequestSchema,
  userTaskRowSchema,
} from './contract.ts'

/** `remove` answer. */
const removeResultSchema = z.object({ removed: z.literal(true) }).strict()
export type RemoveResult = z.infer<typeof removeResultSchema>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$7363686564756c65645461736b73 {
    list: () => Promise<RemoteResult<ListSnapshot>>
    catalog: () => Promise<RemoteResult<CatalogSnapshot>>
    create: (request: CreateTaskRequest) => Promise<RemoteResult<UserTaskRow>>
    update: (request: UpdateTaskRequest) => Promise<RemoteResult<UserTaskRow>>
    setEnabled: (request: SetEnabledRequest) => Promise<RemoteResult<UserTaskRow>>
    deleteTask: (request: RemoveTaskRequest) => Promise<RemoteResult<RemoveResult>>
    runNow: (request: TaskIdRequest) => Promise<RemoteResult<UserTaskRow>>
  }
  interface TypertRemoteMap {
    'scheduledTasks/list': () => Promise<RemoteResult<ListSnapshot>>
    'scheduledTasks/catalog': () => Promise<RemoteResult<CatalogSnapshot>>
    'scheduledTasks/create': (request: CreateTaskRequest) => Promise<RemoteResult<UserTaskRow>>
    'scheduledTasks/update': (request: UpdateTaskRequest) => Promise<RemoteResult<UserTaskRow>>
    'scheduledTasks/setEnabled': (request: SetEnabledRequest) => Promise<RemoteResult<UserTaskRow>>
    'scheduledTasks/deleteTask': (request: RemoveTaskRequest) => Promise<RemoteResult<RemoveResult>>
    'scheduledTasks/runNow': (request: TaskIdRequest) => Promise<RemoteResult<UserTaskRow>>
  }
  interface TypertRemoteNamespaceMap {
    scheduledTasks: TypertRemoteNamespace$7363686564756c65645461736b73
  }
}

/** Browser Remote descriptor for the scheduledTasks namespace. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-scheduled-tasks',
  descriptors: [
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/list',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#ListSnapshot', schema: listSnapshotSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/catalog',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'catalog',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#CatalogSnapshot', schema: catalogSnapshotSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/create',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'create',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#CreateTaskRequest', schema: createTaskRequestSchema },
      }],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#UserTaskRow', schema: userTaskRowSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/update',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'update',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#UpdateTaskRequest', schema: updateTaskRequestSchema },
      }],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#UserTaskRow', schema: userTaskRowSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/setEnabled',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'setEnabled',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#SetEnabledRequest', schema: setEnabledRequestSchema },
      }],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#UserTaskRow', schema: userTaskRowSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/deleteTask',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'deleteTask',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#RemoveTaskRequest', schema: removeTaskRequestSchema },
      }],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#RemoveResult', schema: removeResultSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
    {
      id: 'dsh-scheduled-tasks#scheduledTasks/runNow',
      service: 'scheduledTasks',
      namespace: 'scheduledTasks',
      method: 'runNow',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#TaskIdRequest', schema: taskIdRequestSchema },
      }],
      result: { mode: 'strict', typeSymbol: 'dsh-scheduled-tasks/types#UserTaskRow', schema: userTaskRowSchema },
      sourceLocation: { file: 'src/index.ts', line: 1, column: 3 },
    },
  ],
}

export default TYPERT_REMOTE
