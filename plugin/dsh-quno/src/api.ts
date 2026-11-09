/**
 * Read-model assembly for the browser half: one bounded, JSON-safe snapshot
 * plus on-demand detail views.
 *
 * The client never folds host state itself. The 15-second snapshot carries
 * small wire rows only; large Trigger/Thread/Exchange bodies are loaded by an
 * explicit detail call, so a busy inbox never inflates the polling payload.
 *
 * @module dsh-quno/api
 */

import { localClock, zonedToEpoch } from './util.ts'
import type { QunoHost } from './service.ts'
import type {
  AttentionWire,
  EvalDetailWire,
  EvalWire,
  EventDetailWire,
  EventWire,
  ExchangeDetailWire,
  NoticeDetailWire,
  NoticeWire,
  QunoWireState,
  RunWire,
  SenseFieldWire,
  SenseTypeWire,
  SenseWire,
  SourceWire,
  TaskWire,
  ThreadDetailWire,
  ThreadWire,
  TicketDetailWire,
  TriggerDetailWire,
} from './api-types.ts'
import type { SenseDefinition } from './types.ts'
import type { EvalRecord, TicketRecord, TriggerRecord } from './core/model.ts'
import type { DomainRepository } from './core/repository.ts'

/** Build the complete settings snapshot from one Host. */
export async function buildQunoState(host: QunoHost): Promise<QunoWireState> {
  const store = host.store
  const repo = host.repo
  const quno = store.getQuno(host.qunoId)
  if (quno === undefined) throw new Error('quno row is not provisioned')
  const now = Date.now()
  const live = host.mainAgent() !== undefined
  const health = host.senses.healthSnapshot()
  const clock = localClock(now, quno.config.timeZone)
  const midnight = zonedToEpoch(clock.dayKey, 0, quno.config.timeZone)
  const attention = store.listAttention(host.qunoId, undefined, 100)
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
    ...maskSenseConfig(instance.config, view.definition.configFields ?? []),
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
    lastAttemptAt: instance.lastAttemptAt,
    lastSuccessAt: instance.lastSuccessAt,
    lastEventAt: instance.lastEventAt,
    nextRetryAt: instance.nextRetryAt,
    consecutiveFailures: instance.consecutiveFailures,
    errorCode: instance.errorCode,
    checkpointRevision: instance.checkpoint.revision,
    configFields: (view.definition.configFields ?? []).map(toFieldWire),
  })))

  const senseTypes: SenseTypeWire[] = health.types.map(view => toSenseTypeWire(view, host))

  const tickets = repo.listTickets(host.qunoId, { limit: 50 })
  const effects = repo.listDueEffects(now, 200)
  const waitingEvals = repo.listEvals(host.qunoId, { status: ['delivering', 'waiting-decision'], limit: 200 })
  const evals = repo.listEvals(host.qunoId, { limit: 30 })
  const workerRuns = tickets.flatMap(ticket => repo.listAssignmentsByTicket(ticket.id)
    .flatMap(assignment => repo.listWorkerRunsByAssignment(assignment.id)))
  const runs: RunWire[] = [
    ...evals.map(evalRecord => toEvalRunWire(repo, evalRecord)),
    ...workerRuns.map(run => toWorkerRunWire(run)),
  ].sort((left, right) => right.startedAt - left.startedAt).slice(0, 30)

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
    runs,
    tasks: tickets.map(ticket => toTaskWire(repo, ticket)),
    notices: notices.map(toNoticeWire),
    metrics: {
      deliveries: {
        pending: effects.filter(effect => effect.kind === 'input-delivery').length,
        deferred: waitingEvals.length,
        'dead-letter': effects.filter(effect => effect.attempts >= 3).length,
      },
      attentionOpen: attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed').length,
      oldestPendingAt: oldestPendingInputAt(repo, tickets),
      runsToday: evals.filter(record => record.startedAt >= midnight).length
        + workerRuns.filter(run => run.startedAt >= midnight).length,
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

/**
 * Read one notice by id together with the CURRENT state of the attention
 * items it links. Historical reports therefore keep rendering after the
 * 30-entry snapshot forgets them, and settled items stay visible.
 */
export async function buildNoticeDetail(host: QunoHost, notificationId: string): Promise<NoticeDetailWire | null> {
  const notice = host.store.findNotice(notificationId)
  if (notice === undefined) return null
  const items = (notice.payload.itemIds ?? [])
    .map(id => host.store.getAttentionItem(id))
    .filter((item): item is NonNullable<typeof item> => item !== undefined)
    .map(toAttentionWire)
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
    items,
    eligibleAt: notice.eligibleAt,
    createdAt: notice.createdAt,
    messageId: notice.messageId,
    attempts: notice.attempts,
    expired: notice.status === 'expired' || notice.status === 'superseded',
  }
}

/** Read one event with a bounded payload for the evidence drill-down. */
export async function buildEventDetail(host: QunoHost, eventId: string): Promise<EventDetailWire | null> {
  const trigger = host.repo.getTrigger(eventId)
  if (trigger !== undefined) {
    const serialized = trigger.prunedAt === null ? safeJson(trigger.data) : null
    return {
      id: trigger.id,
      sourceId: trigger.sourceId,
      instanceId: null,
      type: trigger.type,
      operation: trigger.operation,
      subjectKey: null,
      subjectRevision: null,
      summary: trigger.summary,
      occurredAt: trigger.occurredAt,
      receivedAt: trigger.receivedAt,
      ingestSeq: 0,
      pruned: trigger.prunedAt !== null,
      provenance: describeProvenance(trigger.provenance),
      data: serialized === null ? null : serialized.value,
      dataTruncated: serialized?.truncated === true,
      attachments: [],
    }
  }
  const event = host.store.getEvent(eventId)
  if (event === undefined) return null
  const source = host.store.listSources(host.qunoId).find(candidate => candidate.id === event.sourceId)
  const instance = source === undefined
    ? undefined
    : host.store.listSenseInstances(host.qunoId).find(candidate => candidate.id === source.instanceId)
  const serialized = event.prunedAt === null ? safeJson(event.data) : null
  return {
    id: event.id,
    sourceId: event.sourceId,
    instanceId: source?.instanceId ?? null,
    type: event.type,
    operation: event.operation,
    subjectKey: event.subjectKey,
    subjectRevision: event.subjectRevision,
    summary: event.summary,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    ingestSeq: event.ingestSeq,
    pruned: event.prunedAt !== null,
    provenance: describeProvenance(event.provenance),
    data: serialized === null ? null : serialized.value,
    dataTruncated: serialized?.truncated === true,
    attachments: event.prunedAt === null ? readAttachments(event.data) : [],
  }
}

/** One Trigger with its bounded payload. */
export function buildTriggerDetail(host: QunoHost, triggerId: string): TriggerDetailWire | null {
  const trigger = host.repo.getTrigger(triggerId)
  if (trigger === undefined) return null
  const serialized = trigger.prunedAt === null ? safeJson(trigger.data) : null
  return {
    id: trigger.id,
    sourceId: trigger.sourceId,
    type: trigger.type,
    operation: trigger.operation,
    summary: trigger.summary,
    occurredAt: trigger.occurredAt,
    receivedAt: trigger.receivedAt,
    pruned: trigger.prunedAt !== null,
    human: trigger.human,
    addressed: trigger.addressed,
    actor: trigger.actor,
    threads: trigger.threads,
    correlationKeys: trigger.correlationKeys,
    provenance: describeProvenance(trigger.provenance),
    data: serialized === null ? null : serialized.value,
    dataTruncated: serialized?.truncated === true,
    filtered: host.repo.filteredReason(trigger.id),
  }
}

/** One Thread with bounded correlation and subscription context. */
export function buildThreadDetail(host: QunoHost, threadId: string): ThreadDetailWire | null {
  const thread = host.repo.getThread(threadId)
  if (thread === undefined) return null
  const subscriptions = host.repo.listSubscriptionsByThread(thread.id)
  const tickets = subscriptions.flatMap((subscription) => {
    const ticket = host.repo.getTicket(subscription.ticketId)
    return ticket === undefined ? [] : [{ id: ticket.id, title: ticket.title, mode: subscription.mode, ended: ticket.ended !== null }]
  })
  const triggerIds = host.repo.listTriggerIdsByThread(thread.id, 20)
  return {
    id: thread.id,
    sourceId: thread.sourceId,
    threadKey: thread.threadKey,
    label: thread.label,
    lastAt: thread.lastAt,
    pendingTriggerIds: thread.pendingTriggerIds,
    activeEvalId: thread.activeEvalId,
    correlatedThreadIds: thread.correlatedThreadIds,
    closed: thread.closed,
    subscriptions: subscriptions.map(subscription => ({
      id: subscription.id,
      ticketId: subscription.ticketId,
      mode: subscription.mode,
      origin: subscription.origin,
      cancelledAt: subscription.cancelledAt,
    })),
    tickets,
    recentTriggers: triggerIds.flatMap((id) => {
      const trigger = host.repo.getTrigger(id)
      return trigger === undefined ? [] : [{
        id: trigger.id,
        type: trigger.type,
        summary: trigger.summary,
        occurredAt: trigger.occurredAt,
        human: trigger.human,
      }]
    }),
  }
}

/** One Ticket with its assignments, inputs and report. */
export function buildTicketDetail(host: QunoHost, ticketId: string): TicketDetailWire | null {
  const ticket = host.repo.getTicket(ticketId)
  if (ticket === undefined) return null
  const assignments = host.repo.listAssignmentsByTicket(ticket.id)
  const inputs = host.repo.listInputsByTicket(ticket.id, { limit: 50 })
  const subscriptions = host.repo.listSubscriptionsByTicket(ticket.id)
  const triggers = ticket.origin.triggerIds.flatMap((id) => {
    const trigger = host.repo.getTrigger(id)
    return trigger === undefined ? [] : [{
      id: trigger.id,
      type: trigger.type,
      summary: trigger.summary,
      occurredAt: trigger.occurredAt,
    }]
  })
  return {
    ticket: {
      id: ticket.id,
      title: ticket.title,
      goal: ticket.goal,
      mode: ticket.mode,
      ended: ticket.ended,
      question: ticket.question,
      mandate: ticket.mandate,
      channels: ticket.channels,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    },
    assignments: assignments.map(assignment => ({
      id: assignment.id,
      state: assignment.state,
      executorSessionId: assignment.executorSessionId,
      directory: assignment.directory,
      deliveredAt: assignment.deliveredAt,
      idleAt: assignment.idleAt,
      endedReason: assignment.endedReason,
      report: assignment.report,
      runs: host.repo.listWorkerRunsByAssignment(assignment.id).map(run => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        error: run.error,
      })),
    })),
    inputs: inputs.map(input => ({
      id: input.id,
      kind: input.kind,
      human: input.human,
      context: input.context,
      text: input.text,
      createdAt: input.createdAt,
      deliveredAt: input.deliveredAt,
      readAt: input.readAt,
      acknowledgedAt: input.acknowledgedAt,
      handedBackAt: input.handedBackAt,
    })),
    subscriptions: subscriptions.map(subscription => ({
      id: subscription.id,
      threadId: subscription.threadId,
      mode: subscription.mode,
      origin: subscription.origin,
      cancelledAt: subscription.cancelledAt,
    })),
    triggers,
  }
}

/** One Eval with its audit and candidate Triggers. */
export function buildEvalDetail(host: QunoHost, evalId: string): EvalDetailWire | null {
  const evalRecord = host.repo.getEval(evalId)
  if (evalRecord === undefined) return null
  const decision = host.repo.findDecisionByEval(evalId)
  const thread = host.repo.getThread(evalRecord.threadId)
  return {
    eval: toEvalWire(evalRecord),
    thread: thread === undefined
      ? null
      : { id: thread.id, sourceId: thread.sourceId, threadKey: thread.threadKey, label: thread.label },
    decision: decision === null || decision === undefined
      ? null
      : {
        id: decision.id,
        kind: decision.kind,
        strength: decision.strength,
        reason: decision.reason,
        ticketId: decision.ticketId,
        policyVersion: decision.policyVersion,
        audit: decision.audit,
        createdAt: decision.createdAt,
      },
    triggers: evalRecord.triggerIds.flatMap((id) => {
      const trigger = host.repo.getTrigger(id)
      return trigger === undefined ? [] : [{
        id: trigger.id,
        type: trigger.type,
        summary: trigger.summary,
        occurredAt: trigger.occurredAt,
        human: trigger.human,
        addressed: trigger.addressed,
        actor: trigger.actor,
      }]
    }),
  }
}

/** One Exchange with its durable messages. */
export function buildExchangeDetail(host: QunoHost, exchangeId: string): ExchangeDetailWire | null {
  const exchange = host.repo.getExchange(exchangeId)
  if (exchange === undefined) return null
  return {
    exchange: {
      id: exchange.id,
      kind: exchange.kind,
      requester: exchange.requester,
      responder: exchange.responder,
      status: exchange.status,
      deadline: exchange.deadline,
      requestMessageId: exchange.requestMessageId,
      responseMessageId: exchange.responseMessageId,
      attempts: exchange.attempts,
      createdAt: exchange.createdAt,
      updatedAt: exchange.updatedAt,
    },
    messages: host.repo.getExchangeMessages(exchangeId).map(message => ({
      id: message.id,
      kind: message.kind,
      producerEndpoint: message.producerEndpoint,
      contentHash: message.contentHash,
      responseTo: message.responseTo,
      createdAt: message.createdAt,
      payload: safeJson(message.payload)?.value ?? null,
    })),
  }
}

/** Bounded JSON for one event payload; oversized payloads become a clipped string. */
function safeJson(data: unknown): { readonly value: unknown; readonly truncated: boolean } | null {
  if (data === undefined || data === null) return null
  try {
    const text = JSON.stringify(data)
    if (text === undefined) return null
    if (text.length > 8000) return { value: `${text.slice(0, 8000)}…`, truncated: true }
    return { value: JSON.parse(text) as unknown, truncated: false }
  } catch {
    return { value: '（无法序列化的事件负载）', truncated: true }
  }
}

function describeProvenance(provenance: { readonly kind: string; readonly collector?: string; readonly processor?: string; readonly coverage?: string }): string {
  if (provenance.kind === 'observed') {
    return provenance.collector === undefined ? 'observed' : `observed · ${provenance.collector}`
  }
  const processor = provenance.processor ?? 'derived'
  return provenance.coverage === undefined ? `derived · ${processor}` : `derived · ${processor} · ${provenance.coverage}`
}

function readAttachments(data: unknown): readonly { readonly name: string; readonly mediaType: string; readonly ref: string; readonly bytes?: number }[] {
  if (typeof data !== 'object' || data === null) return []
  const attachments = (data as { attachments?: unknown }).attachments
  if (!Array.isArray(attachments)) return []
  return attachments.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const name = typeof record['name'] === 'string' ? record['name'] : ''
    const mediaType = typeof record['mediaType'] === 'string' ? record['mediaType'] : ''
    const ref = typeof record['ref'] === 'string' ? record['ref'] : ''
    if (name === '' || ref === '') return []
    return [{
      name,
      mediaType,
      ref,
      ...(typeof record['bytes'] === 'number' ? { bytes: record['bytes'] } : {}),
    }]
  }).slice(0, 20)
}

/** Secret values never leave the Host; the UI only learns which keys are set. */
export function maskSenseConfig(config: Record<string, unknown>, fields: readonly { readonly key: string; readonly secret?: boolean }[]): {
  readonly config: Record<string, unknown>
  readonly secretSet: readonly string[]
} {
  const secretKeys = new Set(fields.filter(field => field.secret === true).map(field => field.key))
  const masked: Record<string, unknown> = {}
  const secretSet: string[] = []
  for (const [key, value] of Object.entries(config)) {
    if (!secretKeys.has(key)) {
      masked[key] = value
      continue
    }
    const present = value !== undefined && value !== null && value !== ''
    if (present) {
      secretSet.push(key)
      masked[key] = null
      continue
    }
    masked[key] = value ?? null
  }
  return { config: masked, secretSet }
}

function toFieldWire(field: NonNullable<SenseDefinition['configFields']>[number]): SenseFieldWire {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.secret === undefined ? {} : { secret: field.secret }),
    ...(field.help === undefined ? {} : { help: field.help }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.step === undefined ? {} : { step: field.step }),
    ...(field.options === undefined ? {} : { options: field.options.map(option => ({ ...option })) }),
    ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
    ...(field.discover === undefined ? {} : { discover: field.discover }),
    ...(field.advanced === undefined ? {} : { advanced: field.advanced }),
  }
}

function toSenseTypeWire(
  view: { readonly definition: SenseDefinition },
  host: QunoHost,
): SenseTypeWire {
  const definition = view.definition
  return {
    type: definition.type,
    displayName: definition.displayName,
    description: definition.description,
    implementationVersion: definition.implementationVersion,
    contractVersion: definition.contractVersion,
    registered: host.senses === undefined ? true : true,
    configFields: (definition.configFields ?? []).map(toFieldWire),
    runtime: {
      modes: definition.runtime.modes,
      defaultIntervalSec: definition.runtime.defaultIntervalSec,
      minIntervalSec: definition.runtime.minIntervalSec,
      concurrency: definition.runtime.concurrency,
      timeoutMs: definition.runtime.timeoutMs,
      quotas: definition.runtime.quotas === undefined
        ? null
        : {
          maxEventsPerCheck: definition.runtime.quotas.maxEventsPerCheck ?? null,
          maxBytesPerCheck: definition.runtime.quotas.maxBytesPerCheck ?? null,
        },
    },
    permissions: {
      reads: definition.permissions.reads,
      credentialKinds: definition.permissions.credentialKinds ?? [],
      network: definition.permissions.network ?? [],
      mcp: definition.permissions.mcp ?? [],
      requiresModel: definition.permissions.requiresModel === true,
    },
    reliability: {
      checkpoint: definition.reliability.checkpoint,
      replay: {
        kind: definition.reliability.replay.kind,
        windowSec: definition.reliability.replay.windowSec ?? null,
      },
      changeCoverage: definition.reliability.changeCoverage,
      gapDetection: definition.reliability.gapDetection,
      readOriginal: definition.reliability.readOriginal,
    },
    firstSync: definition.firstSync ?? 'unknown',
    eventTypes: definition.eventTypes.map(eventType => ({
      type: eventType.type,
      summary: eventType.summary ?? null,
    })),
    probeAvailable: true,
  }
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
    evidence: item.evidence.map(point => ({
      ...(point.eventId === undefined ? {} : { eventId: point.eventId }),
      ...(point.quote === undefined ? {} : { quote: point.quote }),
    })),
  }
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

function toEventWire(event: {
  readonly id: string
  readonly sourceId: string
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
    sourceId: event.sourceId,
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

function toTaskWire(repo: DomainRepository, ticket: TicketRecord): TaskWire {
  const assignments = repo.listAssignmentsByTicket(ticket.id)
  const assignment = assignments.at(-1)
  const report = [...assignments].reverse().map(candidate => candidate.report).find(candidate => candidate !== null) ?? null
  const ended = ticket.ended
  const status = ended !== null
    ? ended.outcome === 'completed' ? 'done'
      : ended.outcome === 'failed' ? 'failed'
        : ended.outcome === 'stopped' ? 'cancelled'
          : 'done'
    : ticket.question !== null
      ? 'interrupted'
      : assignment?.state === 'running' ? 'running' : 'interrupted'
  return {
    id: ticket.id,
    title: ticket.title,
    status,
    childSessionId: assignment?.executorSessionId ?? null,
    resultDigest: report === null ? null : String(report.at),
    result: report === null ? null : report.summary,
    plan: null,
    prompt: ticket.goal,
    artifacts: (report?.artifacts ?? []).map(artifact => ({ kind: artifact.kind, label: artifact.label, uri: artifact.uri })),
    error: report !== null && report.state === 'failed'
      ? { code: 'task-failed', message: report.summary }
      : ended !== null && ended.outcome === 'failed'
        ? { code: 'task-failed', message: ended.reason ?? '任务失败' }
        : null,
    createdAt: ticket.createdAt,
    settledAt: ended?.at ?? null,
  }
}

function toEvalWire(evalRecord: EvalRecord): EvalWire {
  return {
    id: evalRecord.id,
    threadId: evalRecord.threadId,
    triggerIds: evalRecord.triggerIds,
    primaryTriggerId: evalRecord.primaryTriggerId,
    strength: evalRecord.strength,
    policyVersion: evalRecord.policyVersion,
    status: evalRecord.status,
    candidateMessageId: evalRecord.candidateMessageId,
    startedAt: evalRecord.startedAt,
    deliveredAt: evalRecord.deliveredAt,
    deadline: evalRecord.deadline,
    pausedAt: evalRecord.pausedAt,
    expiryCount: evalRecord.expiryCount,
  }
}

function toEvalRunWire(repo: DomainRepository, evalRecord: EvalRecord): RunWire {
  const decision = repo.findDecisionByEval(evalRecord.id)
  return {
    id: evalRecord.id,
    kind: 'eval',
    trigger: String(evalRecord.triggerIds.length) + ' trigger(s)',
    status: evalRecord.status,
    startedAt: evalRecord.startedAt,
    finishedAt: decision?.createdAt ?? null,
    committed: decision?.kind === 'accept' ? 1 : 0,
    deferred: 0,
    notices: 0,
    error: null,
    provider: null,
    model: null,
    cost: null,
  }
}

function toWorkerRunWire(run: {
  readonly id: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly error: { readonly code: string; readonly message: string } | null
}): RunWire {
  return {
    id: run.id,
    kind: 'worker',
    trigger: 'worker run',
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    committed: 0,
    deferred: 0,
    notices: 0,
    error: run.error,
    provider: null,
    model: null,
    cost: null,
  }
}

function oldestPendingInputAt(repo: DomainRepository, tickets: readonly TicketRecord[]): number | null {
  let oldest: number | null = null
  for (const ticket of tickets) {
    for (const input of repo.listInputsByTicket(ticket.id, { undelivered: true, limit: 50 })) {
      if (oldest === null || input.createdAt < oldest) oldest = input.createdAt
    }
  }
  return oldest
}

/** Re-exported for the client declaration merge. */
export type { ThreadWire, TicketDetailWire, TriggerRecord }
