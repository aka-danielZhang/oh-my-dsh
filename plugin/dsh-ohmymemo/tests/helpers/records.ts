/** Record construction helpers for tests. */
import type { MemoryRecord } from '../../src/types.ts'

export function baseRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const at = '2026-09-03T10:00:00.000Z'
  return {
    schema: 'ohmymemo/v1',
    id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    revision: 1,
    scope: 'user',
    kind: 'semantic',
    key: 'preference.communication.language',
    cardinality: 'single',
    status: 'active',
    confidence: 1,
    importance: 0.8,
    privacy: 'normal',
    pinned: true,
    confirmed: true,
    created_at: at,
    updated_at: at,
    last_confirmed_at: at,
    valid_from: at,
    valid_until: null,
    tags: ['language', 'communication'],
    sources: [{ type: 'user_command', session_id: 'session-123', event_seq: 42, observed_at: at }],
    supersedes: [],
    contradicts: [],
    body: '用户更喜欢使用中文交流。',
    ...overrides,
  }
}
