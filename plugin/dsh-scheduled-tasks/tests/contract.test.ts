/**
 * Contract and descriptor tests: wire schemas parse owned JSON and refuse
 * foreign shapes; managed ids are recognised; Typert descriptors are
 * complete and point at the real service.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIMITS,
  isValidLocalTime,
  resolveTimeZone,
  createTaskRequestSchema,
  scheduleFromSpec,
  scheduleRule,
  scheduleSpecError,
  scheduleSpecSchema,
  taskRowSchema,
  taskScheduleSchema,
  userTaskRowSchema,
} from '../src/contract.ts'
import { TYPERT_REMOTE } from '../src/typert.remote-client.ts'
import { TYPERT_HOST } from '../src/typert.host.ts'

function userRow(): Record<string, unknown> {
  return {
    kind: 'user',
    id: 'task-1',
    revision: 1,
    title: '每日巡检',
    instruction: '检查仓库状态',
    schedule: { kind: 'daily', localTime: '02:00', timeZone: 'Asia/Shanghai' },
    enabled: true,
    execution: {
      workspacePath: '/tmp/repo',
      agentPreset: 'default',
      permissionPreset: 'workspace-write',
      model: null,
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    activity: 'idle',
    nextRunAt: 2_000,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastResult: null,
    runCount: 3,
    sessionId: 'sched-abc',
  }
}

test('user task rows parse and reject unknown fields', () => {
  const parsed = userTaskRowSchema.parse(userRow())
  assert.equal(parsed.id, 'task-1')
  assert.equal(parsed.runCount, 3)
  assert.equal(parsed.sessionId, 'sched-abc')
  const extra = userRow()
  ;(extra as Record<string, unknown>).surprise = true
  assert.throws(() => userTaskRowSchema.parse(extra))
})

test('managed rows carry the honest host-local zone policy', () => {
  const row = {
    kind: 'managed',
    id: 'system.ohmymemo.dream',
    order: 0,
    title: '梦境记忆',
    instructionSummary: '整理近期对话并沉淀为长期记忆',
    sourceLabel: '系统任务',
    schedule: { kind: 'daily', localTime: '02:00', timeZone: 'Asia/Shanghai', timeZonePolicy: 'host-local' },
    scheduleState: 'enabled',
    activity: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    detail: null,
    observedAt: 1_000,
  }
  const parsed = taskRowSchema.parse(row)
  assert.equal(parsed.kind, 'managed')
  assert.throws(() => taskRowSchema.parse({ ...row, timeZonePolicy: 'fabricated' }))
})

test('validation helpers agree with the limits', () => {
  assert.equal(isValidLocalTime('00:00'), true)
  assert.equal(isValidLocalTime('09:30'), true)
  assert.equal(isValidLocalTime('9:30'), false)
  assert.equal(LIMITS.maxTasks, 100)
  assert.equal(resolveTimeZone('UTC'), 'UTC')
  assert.equal(resolveTimeZone('local'), resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'))
  assert.throws(() => resolveTimeZone('Mars/Olympus_Mons'))
})

test('every schedule kind round-trips from a wire spec to a durable schedule', () => {
  const specs = [
    { kind: 'hourly', minute: 5 },
    { kind: 'daily', localTime: '02:00' },
    { kind: 'weekdays', localTime: '09:30' },
    { kind: 'weekly', dayOfWeek: 1, localTime: '09:00' },
    { kind: 'monthly', dayOfMonth: 31, localTime: '23:59' },
  ] as const
  for (const spec of specs) {
    assert.equal(scheduleSpecSchema.safeParse(spec).success, true, `spec ${spec.kind}`)
    const schedule = scheduleFromSpec(scheduleSpecSchema.parse(spec), 'Asia/Shanghai')
    assert.equal(schedule.kind, spec.kind)
    assert.equal(taskScheduleSchema.safeParse(schedule).success, true, `schedule ${spec.kind}`)
    assert.equal(scheduleRule(schedule).kind, spec.kind)
    assert.equal(scheduleSpecError(spec), null, `no error for ${spec.kind}`)
  }
  // The daily member keeps the original v1 field set, so pre-extension rows parse.
  const legacy = { kind: 'daily', localTime: '02:00', timeZone: 'Asia/Shanghai' }
  assert.equal(taskScheduleSchema.safeParse(legacy).success, true)
})

test('schedule specs refuse out-of-range and foreign shapes', () => {
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'hourly', minute: 60 }).success, false)
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'daily', localTime: '24:00' }).success, false)
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'weekly', dayOfWeek: 0, localTime: '09:00' }).success, false)
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'weekly', dayOfWeek: 8, localTime: '09:00' }).success, false)
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'monthly', dayOfMonth: 32, localTime: '09:00' }).success, false)
  assert.equal(scheduleSpecSchema.safeParse({ kind: 'cron', expression: '* * * * *' }).success, false)
  // The strict wire request carries the spec plus the pinned zone.
  const request = {
    title: '巡检',
    instruction: '检查仓库状态',
    schedule: { kind: 'weekly', dayOfWeek: 5, localTime: '16:00' },
    timeZone: 'Asia/Shanghai',
    workspacePath: '/tmp/repo',
    agentPreset: 'standard',
    permissionPreset: 'read-only',
    model: null,
    enabled: true,
  }
  assert.equal(createTaskRequestSchema.safeParse(request).success, true)
  assert.equal(createTaskRequestSchema.safeParse({ ...request, localTime: '16:00' }).success, false)
})

test('scheduleSpecError mirrors the schema bounds with stable messages', () => {
  assert.equal(scheduleSpecError({ kind: 'hourly', minute: 59 }), null)
  assert.match(String(scheduleSpecError({ kind: 'hourly', minute: 60 })), /0\.\.59/)
  assert.match(String(scheduleSpecError({ kind: 'daily', localTime: '9:00' })), /HH:mm/)
  assert.match(String(scheduleSpecError({ kind: 'weekly', dayOfWeek: 9, localTime: '09:00' })), /1\.\.7/)
  assert.match(String(scheduleSpecError({ kind: 'monthly', dayOfMonth: 0, localTime: '09:00' })), /1\.\.31/)
})

test('typert descriptors cover the six Remote methods on the scheduledTasks service', () => {
  const methods = TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method).sort()
  assert.deepEqual(methods, ['catalog', 'create', 'deleteRun', 'deleteTask', 'list', 'listRuns', 'runNow', 'setEnabled', 'update'])
  for (const descriptor of TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.service, 'scheduledTasks')
    assert.equal(descriptor.namespace, 'scheduledTasks')
    assert.equal(descriptor.invocation.kind, 'direct')
    assert.equal(descriptor.result.mode, 'strict')
  }
  // Host registration reuses the exact same strict descriptors.
  assert.equal(TYPERT_HOST.invocations, TYPERT_REMOTE.descriptors)
  assert.equal(TYPERT_HOST.package, 'dsh-scheduled-tasks')
  assert.equal(TYPERT_HOST.face, 'host')
})
