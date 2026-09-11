/**
 * Storage Domain spec for user scheduled tasks (design §6).
 *
 * Three tables: durable definitions (`tasks`), per-task runtime cursors
 * (`runtime`), and the fenced run audit (`runs`). Strict versioned records
 * from ./contract.ts; broken records are quarantined by the storage backend
 * and fail visible rather than being dropped silently.
 * @module dsh-scheduled-tasks/domain
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { TaskRecord, TaskRunAudit, TaskRuntimeRecord } from './contract.ts'
import {
  taskRecordSchema,
  taskRunAuditSchema,
  taskRuntimeRecordSchema,
} from './contract.ts'

/** Process-independent state for the global scheduler. */
export const scheduledTasksDomainSpec = defineDomain({
  name: 'dsh_scheduled_tasks',
  version: 1,
  tables: {
    tasks: domainTable<string, TaskRecord>(taskRecordSchema),
    runtime: domainTable<string, TaskRuntimeRecord>(taskRuntimeRecordSchema),
    runs: domainTable<string, TaskRunAudit>(taskRunAuditSchema),
  },
})
