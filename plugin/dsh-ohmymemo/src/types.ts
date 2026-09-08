/**
 * Shared domain types for the OhMyMemo store medium contract. These types are
 * the Phase 1 seam: Phase 2 tools and the context injector consume them
 * without owning the file layout.
 * @module dsh-ohmymemo/types
 */

/** Memory kinds (see the design doc's taxonomy). */
export type MemoryKind = 'semantic' | 'episodic' | 'procedural'

/**
 * Maturity states. `expired` is the lifecycle archive state (valid_until
 * passed or silence past the decay horizon); `forgotten` is not a state:
 * forgetting deletes the body.
 */
export type MemoryStatus = 'candidate' | 'active' | 'disputed' | 'superseded' | 'expired'

/** Sensitivity policy. Credential-like content never enters the store. */
export type MemoryPrivacy = 'normal' | 'sensitive' | 'secret-ref'

/** Same-key conflict cardinality. */
export type MemoryCardinality = 'single' | 'multiple'

/** Provenance source types, ordered by authority in the design doc. */
export type MemorySourceType =
  | 'user_command'
  | 'user_correction'
  | 'user_statement'
  | 'tool_observation'
  | 'cross_session_inference'
  | 'model_inference'
  | 'subagent'
  | 'automation'
  | 'webhook'
  | 'external_content'

/** Provenance entry: `session_id + event_seq` is the most stable locator. */
export interface MemorySource {
  type: MemorySourceType
  session_id?: string
  event_seq?: number
  message_id?: string
  part_id?: string
  span?: [number, number]
  quote_hash?: string
  quote_preview?: string
  observed_at?: string
}

/** One atomic memory record (frontmatter fields + body). */
export interface MemoryRecord {
  schema: 'ohmymemo/v1'
  id: string
  revision: number
  /** `user` or `workspace:<ws-id>`. */
  scope: string
  kind: MemoryKind
  key: string
  cardinality: MemoryCardinality
  status: MemoryStatus
  confidence: number
  importance: number
  privacy: MemoryPrivacy
  pinned: boolean
  confirmed: boolean
  created_at: string
  updated_at: string
  last_confirmed_at?: string
  /** Last time real evidence re-attested this fact (curator refresh only; never recall). */
  last_evidenced_at?: string
  valid_from?: string | null
  valid_until?: string | null
  tags: string[]
  sources: MemorySource[]
  supersedes: string[]
  contradicts: string[]
  candidate_reason?: string
  candidate_expires_at?: string
  body: string
}

/** Forget barrier: no value, no summary, no quote. */
export interface Tombstone {
  schema: 'ohmymemo-tombstone/v1'
  id: string
  scope: string
  key: string
  memory_ids: string[]
  forgotten_at: string
  reason: string
}

/** Store identity (deliberately independent of the telemetry user id). */
export interface StoreManifest {
  schema: 'ohmymemo-store/v1'
  store_id: string
  created_at: string
  format_version: number
}

/** User-editable policy file (`config.yaml`). */
export interface StoreUserConfig {
  schema: 'ohmymemo-config/v1'
  capture_mode: string
  remember_direct_facts: boolean
  allow_inference_candidates: boolean
  /** Host-local wall-clock time for the daily dream-memory run (`HH:mm`). */
  dream_schedule_local_time: string
  /** Dream-extraction model override; empty strings follow the harness default. */
  dream_model_provider: string
  dream_model: string
  /** Dream-extraction reasoning effort override; empty follows the route default. */
  dream_effort: string
  auto_consolidation: boolean
  watch: boolean
  max_record_bytes: number
  max_search_results: number
  max_get_records: number
  max_injected_bytes: number
  candidate_retention_days: number
  /** Read-time decay horizons per kind, in days (see the lifecycle design note). */
  decay_horizon_days_semantic: number
  decay_horizon_days_procedural: number
  decay_horizon_days_episodic: number
}

/** Workspace scope association file (`scopes/workspaces/<ws>/scope.yaml`). */
export interface ScopeFile {
  schema: 'ohmymemo-scope/v1'
  id: string
  dsh_workspace_id?: string | null
  canonical_path: string
  created_at: string
  updated_at: string
}

/** Severity ladder for scan/doctor findings. */
export type DiagnosticSeverity = 'error' | 'warning' | 'info'

/** One diagnosable finding. Never carries record bodies. */
export interface Diagnostic {
  code: string
  severity: DiagnosticSeverity
  message: string
  path?: string
  id?: string
}

/** Field-level schema problem (aggregated into diagnostics by the scanner). */
export interface SchemaIssue {
  field?: string
  message: string
}

/** Reasons an entry stays in the catalog but out of active recall. */
export type QuarantineReason = 'duplicate-id' | 'path-mismatch' | 'single-key-conflict'

/** Catalog view of one record file on disk. */
export interface CatalogEntry {
  record: MemoryRecord
  /** Store-relative path, always `/`-separated. */
  relPath: string
  absPath: string
  /** sha256 of the full file bytes, `sha256:<hex>`. */
  hash: string
  bytes: number
  mtimeMs: number
  /** NFKC + case-folded body for the in-process text index (active/disputed only). */
  normalizedBody: string
  quarantine?: QuarantineReason
}

/** Catalog view of one tombstone file. */
export interface TombstoneEntry {
  tombstone: Tombstone
  relPath: string
  absPath: string
  hash: string
}

/** Catalog view of one workspace scope registration. */
export interface ScopeEntry {
  scope: ScopeFile
  wsId: string
  relPath: string
}

/** Change notification shape (Phase 2 context injector will subscribe). */
export type MemoryChange =
  | { type: 'upserted'; id: string; revision: number; hash: string; external: boolean }
  | { type: 'removed'; id: string; external: boolean }
  | { type: 'scope-registered'; wsId: string }
  | { type: 'tombstoned'; key: string; scope: string }
  | { type: 'config-updated'; hash: string; external: boolean }
