/**
 * Strict Typert contribution for the `quno` Remote namespace.
 *
 * The descriptors are hand-authored (the same shape `dsh-thread` and
 * `dsh-usage-stats` mount): the assembled desktop runtime resolves this
 * plugin's harness dependencies to its own packed copies, so marker scanning
 * cannot be relied on. Registering strict descriptors puts the endpoints on
 * the registry's local store directly.
 *
 * @module dsh-quno/typert.remote-client
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { CheckNowResult, EnsureMainResult, EventWire, QunoWireState } from './api-types.ts'
import {
  actAttentionInput,
  createSenseInput,
  ensureMainInput,
  eventsRecentInput,
  muteInput,
  passthroughSchema,
  senseCommandInput,
  taskCommandInput,
  updateConfigInput,
  updateProfileInput,
} from './api-types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$71756e6f {
    state: () => Promise<RemoteResult<QunoWireState>>
    ensureMain: (request: { cwd: string }) => Promise<RemoteResult<EnsureMainResult>>
    updateConfig: (request: { patch: Record<string, unknown> }) => Promise<RemoteResult<QunoWireState>>
    updateProfile: (request: {
      name?: string
      persona?: string
      instructions?: string
      modelProvider?: string
      model?: string
      reasoningEffort?: string | null
    }) => Promise<RemoteResult<QunoWireState>>
    actAttention: (request: {
      itemId: string
      action: 'processed' | 'later' | 'dismiss' | 'resume' | 'clarify'
      expectedRevision?: number
      snoozeMinutes?: number
      note?: string
    }) => Promise<RemoteResult<QunoWireState>>
    checkNow: () => Promise<RemoteResult<CheckNowResult>>
    createSense: (request: {
      type: string
      label?: string
      config?: Record<string, unknown>
      desiredState?: 'enabled' | 'paused' | 'disabled'
    }) => Promise<RemoteResult<QunoWireState>>
    senseCommand: (request: {
      instanceId: string
      action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
      label?: string
      config?: Record<string, unknown>
    }) => Promise<RemoteResult<QunoWireState>>
    taskCommand: (request: {
      taskId: string
      action: 'resume' | 'abandon'
    }) => Promise<RemoteResult<QunoWireState>>
    mute: (request: { minutes?: number; until?: string; cancel?: boolean }) => Promise<RemoteResult<QunoWireState>>
    eventsRecent: (request: { limit?: number }) => Promise<RemoteResult<{ events: EventWire[] }>>
  }

  interface TypertRemoteMap {
    'quno/state': () => Promise<RemoteResult<QunoWireState>>
    'quno/ensureMain': (request: { cwd: string }) => Promise<RemoteResult<EnsureMainResult>>
    'quno/updateConfig': (request: { patch: Record<string, unknown> }) => Promise<RemoteResult<QunoWireState>>
    'quno/updateProfile': (request: {
      name?: string
      persona?: string
      instructions?: string
      modelProvider?: string
      model?: string
      reasoningEffort?: string | null
    }) => Promise<RemoteResult<QunoWireState>>
    'quno/actAttention': (request: {
      itemId: string
      action: 'processed' | 'later' | 'dismiss' | 'resume' | 'clarify'
      expectedRevision?: number
      snoozeMinutes?: number
      note?: string
    }) => Promise<RemoteResult<QunoWireState>>
    'quno/checkNow': () => Promise<RemoteResult<CheckNowResult>>
    'quno/createSense': (request: {
      type: string
      label?: string
      config?: Record<string, unknown>
      desiredState?: 'enabled' | 'paused' | 'disabled'
    }) => Promise<RemoteResult<QunoWireState>>
    'quno/senseCommand': (request: {
      instanceId: string
      action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
      label?: string
      config?: Record<string, unknown>
    }) => Promise<RemoteResult<QunoWireState>>
    'quno/taskCommand': (request: {
      taskId: string
      action: 'resume' | 'abandon'
    }) => Promise<RemoteResult<QunoWireState>>
    'quno/mute': (request: { minutes?: number; until?: string; cancel?: boolean }) => Promise<RemoteResult<QunoWireState>>
    'quno/eventsRecent': (request: { limit?: number }) => Promise<RemoteResult<{ events: EventWire[] }>>
  }

  interface TypertRemoteNamespaceMap {
    quno: TypertRemoteNamespace$71756e6f
  }
}

const direct = { kind: 'direct' } as const
const noParameters: [] = []

function parameter(name: string, schema: { parse(value: unknown): unknown }, typeSymbol: string) {
  return [{
    name,
    wire: name,
    source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol, create: () => schema },
  }]
}

function resultCodec(typeSymbol: string) {
  return { mode: 'strict' as const, typeSymbol, create: () => passthroughSchema() }
}

const STATE = resultCodec('dsh-quno/api-types#QunoWireState')

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: 'dsh-quno',
  descriptors: [
    {
      id: 'dsh-quno#quno/state', service: 'quno', namespace: 'quno', method: 'state',
      invocation: direct, parameters: noParameters, result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/ensureMain', service: 'quno', namespace: 'quno', method: 'ensureMain',
      implementation: 'ensureMainForClient',
      invocation: direct,
      parameters: parameter('request', ensureMainInput, 'dsh-quno/api-types#EnsureMainInput'),
      result: resultCodec('dsh-quno/api-types#EnsureMainResult'),
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/updateConfig', service: 'quno', namespace: 'quno', method: 'updateConfig',
      invocation: direct,
      parameters: parameter('request', updateConfigInput, 'dsh-quno/api-types#UpdateConfigInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/updateProfile', service: 'quno', namespace: 'quno', method: 'updateProfile',
      invocation: direct,
      parameters: parameter('request', updateProfileInput, 'dsh-quno/api-types#UpdateProfileInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/actAttention', service: 'quno', namespace: 'quno', method: 'actAttention',
      implementation: 'actAttentionForClient',
      invocation: direct,
      parameters: parameter('request', actAttentionInput, 'dsh-quno/api-types#ActAttentionInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/checkNow', service: 'quno', namespace: 'quno', method: 'checkNow',
      invocation: direct, parameters: noParameters,
      result: resultCodec('dsh-quno/api-types#CheckNowResult'),
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/createSense', service: 'quno', namespace: 'quno', method: 'createSense',
      invocation: direct,
      parameters: parameter('request', createSenseInput, 'dsh-quno/api-types#CreateSenseInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/senseCommand', service: 'quno', namespace: 'quno', method: 'senseCommand',
      invocation: direct,
      parameters: parameter('request', senseCommandInput, 'dsh-quno/api-types#SenseCommandInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/taskCommand', service: 'quno', namespace: 'quno', method: 'taskCommand',
      invocation: direct,
      parameters: parameter('request', taskCommandInput, 'dsh-quno/api-types#TaskCommandInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/mute', service: 'quno', namespace: 'quno', method: 'mute',
      implementation: 'muteForClient',
      invocation: direct,
      parameters: parameter('request', muteInput, 'dsh-quno/api-types#MuteInput'),
      result: STATE,
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
    {
      id: 'dsh-quno#quno/eventsRecent', service: 'quno', namespace: 'quno', method: 'eventsRecent',
      implementation: 'eventsRecentForClient',
      invocation: direct,
      parameters: parameter('request', eventsRecentInput, 'dsh-quno/api-types#EventsRecentInput'),
      result: resultCodec('dsh-quno/api-types#EventsRecentResult'),
      sourceLocation: { file: 'src/api.ts', line: 1, column: 1 },
    },
  ],
}

export default TYPERT_REMOTE
