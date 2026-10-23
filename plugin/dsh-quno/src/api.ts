/**
 * Read-model assembly for the browser half: one bounded, JSON-safe snapshot.
 *
 * The client never folds host state itself; every view (configuration,
 * sources, attention, runs, tasks, notifications) reads this snapshot and the
 * command methods return a fresh one.
 *
 * @module dsh-quno/api
 */

import { localClock, zonedToEpoch } from './util.ts'
import type { QunoHost } from './service.ts'
import type {
  AttentionWire,
  EventWire,
  NoticeWire,
  QunoWireState,
  RunWire,
  SenseTypeWire,
  SenseWire,
  SourceWire,
  TaskWire,
} from './api-types.ts'

/** Build the complete settings snapshot from one Host. */
export async function buildQunoState(host: QunoHost): Promise<QunoWireState> {
  const store = host.store
  const quno = store.getQuno(host.qunoId)
  if (quno === undefined) throw new Error('quno row is not provisioned')
  const now = Date.now()
  const live = host.mainAgent() !== undefined
  const health = host.senses.healthSnapshot()
  const clock = localClock(now, quno.config.timeZone)
  const midnight = zonedToEpoch(clock.dayKey, 0, quno.config.timeZone)
  const attention = store.listAttention(host.qunoId, undefined, 100)
  const deliveries = store.countDeliveries(host.qunoId)
  const notices = store.listNotices(host.qunoId, 30)
  const sources: SourceWire[] = store.listSources(host.qunoId).map(source => ({
    id: source.id,
    instanceId: source.instanceId,
    type: source.type,
    lastEventAt: store.listSenseInstances(host.qunoId).find(instance => instance.id === source.instanceId)?.lastEventAt ?? null,
  }))
  const senses: SenseWire[] = health.types.flatMap(view => view.instances.map(instance => ({
    id: instance.id,
    type: instance.type,
    label: instance.label,
    config: instance.config,
    configRevision: instance.configRevision,
    desiredState: instance.desiredState,
    lifecycle: instance.lifecycle,
    health: instance.health,
    stale: (instance as { stale?: boolean }).stale === true,
    healthDetail: instance.healthDetail === null
      ? null
      : {
        ...(instance.healthDetail.detail === undefined ? {} : { detail: instance.healthDetail.detail }),
        ...(instance.healthDetail.consecutiveFailures === undefined ? {} : { consecutiveFailures: instance.healthDetail.consecutiveFailures }),
        ...(instance.healthDetail.errorCode === undefined ? {} : { errorCode: instance.healthDetail.errorCode }),
        ...(instance.healthDetail.sourceLagSec === undefined ? {} : { sourceLagSec: instance.healthDetail.sourceLagSec }),
        ...(instance.healthDetail.coveredThrough === undefined ? {} : { coveredThrough: instance.healthDetail.coveredThrough }),
      },
    lastSuccessAt: instance.lastSuccessAt,
    lastEventAt: instance.lastEventAt,
    nextRetryAt: instance.nextRetryAt,
    checkpointRevision: instance.checkpoint.revision,
    configFields: (view.definition.configFields ?? []).map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.help === undefined ? {} : { help: field.help }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    })),
  })))

  const senseTypes: SenseTypeWire[] = health.types.map(view => ({
    type: view.type,
    displayName: view.displayName,
    description: view.description,
    implementationVersion: view.implementationVersion,
    contractVersion: view.contractVersion,
    registered: view.definition !== undefined && typeof view.definition.type === 'string',
    configFields: (view.definition.configFields ?? []).map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.help === undefined ? {} : { help: field.help }),
      ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    })),
  }))

  return {
    updatedAt: now,
    quno: {
      id: quno.id,
      name: quno.name,
      persona: quno.persona,
      instructions: quno.instructions,
      modelProvider: quno.modelProvider,
      model: quno.model,
      reasoningEffort: quno.reasoningEffort,
      mainSessionId: quno.mainSessionId,
      mainSessionState: quno.mainSessionState,
      mutedUntil: quno.mutedUntil,
      configRevision: quno.configRevision,
    },
    config: quno.config,
    main: { sessionId: quno.mainSessionId, state: quno.mainSessionState, live },
    senses,
    senseTypes,
    sources,
    gaps: health.gaps,
    attention: attention.map(toAttentionWire),
    runs: store.listRuns(host.qunoId, 30).map(toRunWire),
    tasks: store.listTasks(host.qunoId, undefined, 50).map(toTaskWire),
    notices: notices.map(toNoticeWire),
    metrics: {
      deliveries,
      attentionOpen: attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed').length,
      oldestPendingAt: store.oldestReadyDeliveryAt(host.qunoId, now),
      runsToday: store.countRunsSince(host.qunoId, midnight),
      noticesToday: store.countNoticesSince(host.qunoId, midnight),
    },
    status: host.statusSummary(),
    presets: { main: 'quno', task: 'quno-task' },
  }
}

/** Build the bounded recent-events summary for the panel's 动态 view. */
export async function buildRecentEvents(host: QunoHost, limit: number): Promise<EventWire[]> {
  return host.store.listRecentEvents(limit).map(toEventWire)
}

function toAttentionWire(item: {
  readonly id: string
  readonly topicKey: string
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly revision: number
  readonly materialRevision: number
  readonly nextReviewAt: number | null
  readonly snoozedUntil: number | null
  readonly updatedAt: number
  readonly evidence: readonly { readonly eventId?: string; readonly quote?: string }[]
}): AttentionWire {
  return {
    id: item.id,
    topicKey: item.topicKey,
    title: item.title,
    summary: item.summary,
    status: item.status,
    revision: item.revision,
    materialRevision: item.materialRevision,
    nextReviewAt: item.nextReviewAt,
    snoozedUntil: item.snoozedUntil,
    updatedAt: item.updatedAt,
    evidence: item.evidence.slice(0, 10).map(point => ({
      ...(point.eventId === undefined ? {} : { eventId: point.eventId }),
      ...(point.quote === undefined ? {} : { quote: point.quote }),
    })),
  }
}

function toRunWire(run: {
  readonly id: string
  readonly kind: string
  readonly trigger: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly result: {
    readonly eventDecisions: readonly unknown[]
    readonly attentionChanges: readonly unknown[]
    readonly notificationCandidates: readonly unknown[]
  } | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly provider: string | null
  readonly model: string | null
  readonly cost: { readonly promptChars: number; readonly outputChars: number; readonly durationMs: number; readonly toolCalls: number } | null
}): RunWire {
  return {
    id: run.id,
    kind: run.kind,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    committed: run.result?.eventDecisions.length ?? 0,
    deferred: 0,
    notices: run.result?.notificationCandidates.length ?? 0,
    error: run.error === null ? null : { code: run.error.code, message: run.error.message },
    provider: run.provider,
    model: run.model,
    cost: run.cost === null
      ? null
      : {
        promptChars: run.cost.promptChars,
        outputChars: run.cost.outputChars,
        durationMs: run.cost.durationMs,
        toolCalls: run.cost.toolCalls,
      },
  }
}

function toTaskWire(task: {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly childSessionId: string | null
  readonly resultDigest: string | null
  readonly result: string | null
  readonly plan?: string | null
  readonly prompt?: string | null
  readonly artifacts: readonly { readonly kind: string; readonly label: string; readonly uri: string }[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly createdAt: number
  readonly settledAt: number | null
}): TaskWire {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    childSessionId: task.childSessionId,
    resultDigest: task.resultDigest,
    result: task.result,
    plan: task.plan ?? null,
    prompt: task.prompt === null || task.prompt === undefined ? null : clipText(task.prompt, 2000),
    artifacts: task.artifacts.map(artifact => ({ kind: artifact.kind, label: artifact.label, uri: artifact.uri })),
    error: task.error === null ? null : { code: task.error.code, message: task.error.message },
    createdAt: task.createdAt,
    settledAt: task.settledAt,
  }
}

function toEventWire(event: {
  readonly id: string
  readonly type: string
  readonly operation: string
  readonly subjectKey: string | null
  readonly summary: string | null
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly ingestSeq: number
  readonly prunedAt: number | null
}): EventWire {
  return {
    id: event.id,
    type: event.type,
    operation: event.operation,
    subjectKey: event.subjectKey,
    summary: event.summary,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    ingestSeq: event.ingestSeq,
    pruned: event.prunedAt !== null,
  }
}

/** Clip one text body to at most `max` code units without splitting a surrogate pair. */
function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  const next = text.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return text.slice(0, end)
}

function toNoticeWire(notice: {
  readonly id: string
  readonly topicKey: string
  readonly kind: string
  readonly status: string
  readonly reason: string | null
  readonly payload: { readonly title: string; readonly summary: string; readonly body: string; readonly why: string; readonly itemIds?: readonly string[] }
  readonly eligibleAt: number
  readonly createdAt: number
  readonly messageId: string | null
  readonly attempts: number
}): NoticeWire {
  return {
    id: notice.id,
    topicKey: notice.topicKey,
    kind: notice.kind,
    status: notice.status,
    reason: notice.reason,
    title: notice.payload.title,
    summary: notice.payload.summary,
    body: notice.payload.body,
    why: notice.payload.why,
    itemIds: notice.payload.itemIds ?? [],
    eligibleAt: notice.eligibleAt,
    createdAt: notice.createdAt,
    messageId: notice.messageId,
    attempts: notice.attempts,
  }
}
