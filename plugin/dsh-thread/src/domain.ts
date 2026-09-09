import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { migrateLegacyLink } from './migrate.ts'
import { threadDraftRecordSchema, threadLinkSchema } from './thread-types.ts'

/**
 * Durable Thread sidecar state; Session logs remain the source of message truth.
 *
 * The links table migrates pre-0.3 records through `migrateLegacyLink` at the
 * parse boundary so stored legacy documents can never fail domain open; boot
 * then rewrites them once and clears the capture marker.
 */
export const threadDomainSpec = defineDomain({
  name: 'dsh_thread',
  version: 1,
  tables: {
    drafts: domainTable<string, import('./thread-types.ts').ThreadDraftRecord>(threadDraftRecordSchema),
    links: domainTable<string, import('./thread-types.ts').ThreadLink>(
      z.preprocess(migrateLegacyLink, threadLinkSchema),
    ),
  },
})
