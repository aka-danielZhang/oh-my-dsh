/** Durable scheduler state and body-free run audit records. */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import {
  dreamRunAuditSchema,
  dreamRuntimeStateSchema,
  type DreamRunAudit,
  type DreamRuntimeState,
} from './manager-contract.ts'

/** Process-independent state for the global dream-memory maintainer. */
export const managerDomainSpec = defineDomain({
  name: 'dsh_ohmymemo_manager',
  version: 1,
  tables: {
    state: domainTable<string, DreamRuntimeState>(dreamRuntimeStateSchema),
    runs: domainTable<string, DreamRunAudit>(dreamRunAuditSchema),
  },
})
