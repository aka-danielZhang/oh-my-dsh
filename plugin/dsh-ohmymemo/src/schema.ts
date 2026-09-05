/**
 * Parsing, validation and serialization for every on-disk schema the store
 * owns: memory records (Markdown + YAML frontmatter), tombstones, the store
 * manifest, workspace scope files and the user config. All functions here are
 * pure — filesystem work lives elsewhere.
 *
 * Validation philosophy: a record is either fully valid or it is excluded
 * from recall with precise issues (fail closed); unknown schema versions are
 * never guessed at.
 * @module dsh-ohmymemo/schema
 */

import { parse, stringify } from 'yaml'
import { MEM_ID_RE, TOMB_ID_RE, WS_ID_RE } from './ids.ts'
import type {
  MemoryCardinality,
  MemoryKind,
  MemoryPrivacy,
  MemoryRecord,
  MemorySource,
  MemorySourceType,
  MemoryStatus,
  ScopeFile,
  SchemaIssue,
  StoreManifest,
  StoreUserConfig,
  Tombstone,
} from './types.ts'

/** Current record schema discriminator. */
export const RECORD_SCHEMA = 'ohmymemo/v1'

/** Store layout version this code understands. */
export const STORE_FORMAT_VERSION = 1

/** Normalized conflict key: dot-separated lowercase segments. */
const KEY_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/** Normalized tag shape. */
const TAG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const KINDS: ReadonlySet<string> = new Set<MemoryKind>(['semantic', 'episodic', 'procedural'])
const STATUSES: ReadonlySet<string> = new Set<MemoryStatus>(['candidate', 'active', 'disputed', 'superseded'])
const CARDINALITIES: ReadonlySet<string> = new Set<MemoryCardinality>(['single', 'multiple'])
const PRIVACIES: ReadonlySet<string> = new Set<MemoryPrivacy>(['normal', 'sensitive', 'secret-ref'])
const SOURCE_TYPES: ReadonlySet<string> = new Set<MemorySourceType>([
  'user_command',
  'user_correction',
  'user_statement',
  'tool_observation',
  'cross_session_inference',
  'model_inference',
  'subagent',
  'automation',
  'webhook',
  'external_content',
])

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Maximum tags per record. */
export const MAX_TAGS = 8

/** Maximum quote_preview length in sources (provenance previews stay short). */
export const MAX_QUOTE_PREVIEW = 200

/** Maximum accepted normalized key length. */
export const MAX_KEY_LENGTH = 128

/** Upper bound for candidate_reason length. */
export const MAX_CANDIDATE_REASON = 500

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * Normalize a raw key: NFKC, lowercase, whitespace/underscores to hyphens,
 * drop characters outside [a-z0-9.-], collapse separators. Returns undefined
 * when nothing usable remains.
 */
export function normalizeKey(raw: string): string | undefined {
  let value = raw.normalize('NFKC').toLowerCase()
  value = value.replace(/[\s_]+/g, '-')
  value = value.replace(/[^a-z0-9.-]+/g, '-')
  value = value.replace(/-{2,}/g, '-').replace(/\.{2,}/g, '.')
  value = value.replace(/^[.-]+|[.-]+$/g, '')
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) return undefined
  if (!KEY_RE.test(value)) return undefined
  return value
}

/** Normalize a raw tag; undefined when unusable. */
export function normalizeTag(raw: string): string | undefined {
  const value = raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (value.length === 0 || value.length > 64) return undefined
  if (!TAG_RE.test(value)) return undefined
  return value
}

/** Normalize text for the in-process index: NFKC + locale-insensitive lowercase. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

/**
 * Best-effort credential matcher — a write-gate policy, not a DLP. A hit
 * refuses the write (fail closed) instead of downgrading to `sensitive`.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/ },
  { label: 'credential-assignment', re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?([^\s"']{8,})/i },
]

/** Placeholder-looking values the assignment pattern should not flag. */
const PLACEHOLDER_RE = /^(x+|\*+|<[^>]*>|\$\{[^}]*\}|\{\{.*\}\}|env:|changeme|placeholder|dummy|redacted|xxxx-xxxx)$/i

/** Detect credential-like content; returns the matched label or undefined. */
export function detectSecretLike(text: string): string | undefined {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(text)
    if (match === null) continue
    if (pattern.label === 'credential-assignment') {
      const value = match[1] ?? ''
      if (PLACEHOLDER_RE.test(value)) continue
    }
    return pattern.label
  }
  return undefined
}

// ---------------------------------------------------------- frontmatter ----

/** Split a Markdown file into frontmatter source and body. */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return undefined
  const lines = normalized.split('\n')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') {
      end = i
      break
    }
  }
  if (end === -1) return undefined
  const frontmatter = lines.slice(1, end).join('\n')
  const after = lines.slice(end + 1)
  const body = after.length > 0 && after[0] === '' ? after.slice(1).join('\n') : after.join('\n')
  return { frontmatter, body }
}

/** Compose a Markdown file from frontmatter source and body (single trailing newline). */
export function composeFrontmatter(frontmatter: string, body: string): string {
  const trimmedBody = body.replace(/\n+$/, '')
  return `---\n${frontmatter}\n---\n\n${trimmedBody}\n`
}

// --------------------------------------------------------------- record ----

interface RawRecord {
  schema: unknown
  id: unknown
  revision: unknown
  scope: unknown
  kind: unknown
  key: unknown
  cardinality: unknown
  status: unknown
  confidence: unknown
  importance: unknown
  privacy: unknown
  pinned: unknown
  confirmed: unknown
  created_at: unknown
  updated_at: unknown
  last_confirmed_at?: unknown
  valid_from?: unknown
  valid_until?: unknown
  tags: unknown
  sources: unknown
  supersedes: unknown
  contradicts: unknown
  candidate_reason?: unknown
  candidate_expires_at?: unknown
}

/** Parse and validate one record file's text. Returns the record or its issues. */
export function parseRecord(text: string): { record?: MemoryRecord; issues: SchemaIssue[] } {
  const issues: SchemaIssue[] = []
  const parts = splitFrontmatter(text)
  if (parts === undefined) {
    return { issues: [{ message: 'missing or malformed YAML frontmatter' }] }
  }
  let raw: unknown
  try {
    raw = parse(parts.frontmatter)
  } catch (error) {
    return { issues: [{ message: `frontmatter is not valid YAML: ${(error as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { issues: [{ message: 'frontmatter must be a YAML mapping' }] }
  }
  const fm = raw as RawRecord

  if (fm.schema !== RECORD_SCHEMA) {
    return { issues: [{ field: 'schema', message: `unsupported record schema ${JSON.stringify(fm.schema)} (this store reads ${RECORD_SCHEMA})` }] }
  }
  if (typeof fm.id !== 'string' || !MEM_ID_RE.test(fm.id)) {
    issues.push({ field: 'id', message: 'id must be mem_<ulid> and match the file name' })
  }
  if (!Number.isInteger(fm.revision) || (fm.revision as number) < 1) {
    issues.push({ field: 'revision', message: 'revision must be a positive integer' })
  }
  if (fm.scope !== 'user' && !(typeof fm.scope === 'string' && fm.scope.startsWith('workspace:') && WS_ID_RE.test(fm.scope.slice('workspace:'.length)))) {
    issues.push({ field: 'scope', message: 'scope must be "user" or "workspace:ws_<ulid>"' })
  }
  if (typeof fm.kind !== 'string' || !KINDS.has(fm.kind)) {
    issues.push({ field: 'kind', message: 'kind must be semantic | episodic | procedural' })
  }
  const key = typeof fm.key === 'string' ? fm.key : ''
  if (!KEY_RE.test(key) || key.length > MAX_KEY_LENGTH) {
    issues.push({ field: 'key', message: `key must be normalized (lowercase dot-segments, ≤${MAX_KEY_LENGTH} chars)` })
  }
  if (typeof fm.cardinality !== 'string' || !CARDINALITIES.has(fm.cardinality)) {
    issues.push({ field: 'cardinality', message: 'cardinality must be single | multiple' })
  }
  if (typeof fm.status !== 'string' || !STATUSES.has(fm.status)) {
    issues.push({ field: 'status', message: 'status must be candidate | active | disputed | superseded' })
  }
  for (const field of ['confidence', 'importance'] as const) {
    const value = fm[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      issues.push({ field, message: `${field} must be a number in [0, 1]` })
    }
  }
  if (typeof fm.privacy !== 'string' || !PRIVACIES.has(fm.privacy)) {
    issues.push({ field: 'privacy', message: 'privacy must be normal | sensitive | secret-ref' })
  }
  if (typeof fm.pinned !== 'boolean') issues.push({ field: 'pinned', message: 'pinned must be a boolean' })
  if (typeof fm.confirmed !== 'boolean') issues.push({ field: 'confirmed', message: 'confirmed must be a boolean' })
  if (!isIso(fm.created_at)) issues.push({ field: 'created_at', message: 'created_at must be an ISO 8601 timestamp' })
  if (!isIso(fm.updated_at)) issues.push({ field: 'updated_at', message: 'updated_at must be an ISO 8601 timestamp' })
  if (fm.last_confirmed_at !== undefined && !isIso(fm.last_confirmed_at)) {
    issues.push({ field: 'last_confirmed_at', message: 'last_confirmed_at must be an ISO 8601 timestamp' })
  }
  for (const field of ['valid_from', 'valid_until'] as const) {
    const value = fm[field]
    if (value !== undefined && value !== null && !isIso(value)) {
      issues.push({ field, message: `${field} must be an ISO 8601 timestamp or null` })
    }
  }
  if (fm.valid_from !== undefined && fm.valid_from !== null && fm.valid_until !== undefined && fm.valid_until !== null
    && isIso(fm.valid_from) && isIso(fm.valid_until) && Date.parse(fm.valid_until as string) < Date.parse(fm.valid_from as string)) {
    issues.push({ field: 'valid_until', message: 'valid_until precedes valid_from' })
  }

  if (!Array.isArray(fm.tags) || fm.tags.length > MAX_TAGS) {
    issues.push({ field: 'tags', message: `tags must be an array of at most ${MAX_TAGS} strings` })
  } else {
    const seen = new Set<string>()
    for (const tag of fm.tags) {
      if (typeof tag !== 'string' || !TAG_RE.test(tag) || seen.has(tag)) {
        issues.push({ field: 'tags', message: `invalid or duplicate tag ${JSON.stringify(tag)}` })
        break
      }
      seen.add(tag)
    }
  }

  if (!Array.isArray(fm.sources) || fm.sources.length === 0) {
    issues.push({ field: 'sources', message: 'sources must be a non-empty array' })
  } else {
    const sourceIssues = validateSources(fm.sources)
    issues.push(...sourceIssues)
  }

  for (const field of ['supersedes', 'contradicts'] as const) {
    const value = fm[field]
    if (!Array.isArray(value)) {
      issues.push({ field, message: `${field} must be an array of memory ids` })
      continue
    }
    const seen = new Set<string>()
    for (const item of value) {
      if (typeof item !== 'string' || !MEM_ID_RE.test(item)) {
        issues.push({ field, message: `${field} contains a non-mem id ${JSON.stringify(item)}` })
        break
      }
      if (item === fm.id) {
        issues.push({ field, message: `${field} must not reference itself` })
        break
      }
      if (seen.has(item)) {
        issues.push({ field, message: `${field} contains duplicate id ${item}` })
        break
      }
      seen.add(item)
    }
  }

  const status = typeof fm.status === 'string' && STATUSES.has(fm.status) ? (fm.status as MemoryStatus) : undefined
  if (status === 'candidate') {
    if (typeof fm.candidate_reason !== 'string' || fm.candidate_reason.trim().length === 0 || fm.candidate_reason.length > MAX_CANDIDATE_REASON) {
      issues.push({ field: 'candidate_reason', message: `candidates require a short reason (≤${MAX_CANDIDATE_REASON} chars)` })
    }
    if (!isIso(fm.candidate_expires_at)) {
      issues.push({ field: 'candidate_expires_at', message: 'candidates require an expiry timestamp' })
    }
  } else {
    if (fm.candidate_reason !== undefined) issues.push({ field: 'candidate_reason', message: 'only candidates carry candidate_reason' })
    if (fm.candidate_expires_at !== undefined) issues.push({ field: 'candidate_expires_at', message: 'only candidates carry candidate_expires_at' })
  }

  const body = parts.body.replace(/\n+$/, '')
  if (body.trim().length === 0) {
    issues.push({ message: 'record body must not be empty' })
  }
  if (detectSecretLike(body) !== undefined) {
    issues.push({ message: 'record body looks like credential material — refused (fail closed)' })
  }

  if (issues.length > 0) return { issues }
  const record = { ...(fm as unknown as Omit<MemoryRecord, 'body'>), body }
  return { record, issues: [] }
}

function validateSources(sources: unknown[]): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  sources.forEach((item, index) => {
    const field = `sources[${index}]`
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({ field, message: 'each source must be a mapping' })
      return
    }
    const source = item as Record<string, unknown>
    if (typeof source.type !== 'string' || !SOURCE_TYPES.has(source.type as MemorySourceType)) {
      issues.push({ field: `${field}.type`, message: `unknown source type ${JSON.stringify(source.type)}` })
    }
    if (source.session_id !== undefined && typeof source.session_id !== 'string') {
      issues.push({ field: `${field}.session_id`, message: 'session_id must be a string' })
    }
    if (source.event_seq !== undefined && (!Number.isInteger(source.event_seq) || (source.event_seq as number) < 0)) {
      issues.push({ field: `${field}.event_seq`, message: 'event_seq must be a non-negative integer' })
    }
    if (source.message_id !== undefined && typeof source.message_id !== 'string') {
      issues.push({ field: `${field}.message_id`, message: 'message_id must be a string' })
    }
    if (source.part_id !== undefined && typeof source.part_id !== 'string') {
      issues.push({ field: `${field}.part_id`, message: 'part_id must be a string' })
    }
    if (source.span !== undefined) {
      const span = source.span
      if (!Array.isArray(span) || span.length !== 2 || !Number.isInteger(span[0]) || !Number.isInteger(span[1]) || (span[0] as number) < 0 || (span[1] as number) < (span[0] as number)) {
        issues.push({ field: `${field}.span`, message: 'span must be [start, end] with 0 ≤ start ≤ end' })
      }
    }
    if (source.quote_hash !== undefined && typeof source.quote_hash !== 'string') {
      issues.push({ field: `${field}.quote_hash`, message: 'quote_hash must be a string' })
    }
    if (source.quote_preview !== undefined && (typeof source.quote_preview !== 'string' || source.quote_preview.length > MAX_QUOTE_PREVIEW)) {
      issues.push({ field: `${field}.quote_preview`, message: `quote_preview must be ≤${MAX_QUOTE_PREVIEW} chars` })
    }
    if (source.observed_at !== undefined && !isIso(source.observed_at)) {
      issues.push({ field: `${field}.observed_at`, message: 'observed_at must be an ISO 8601 timestamp' })
    }
  })
  return issues
}

/** Fields serialized into frontmatter, in canonical order. */
const RECORD_FIELD_ORDER = [
  'schema', 'id', 'revision', 'scope', 'kind', 'key', 'cardinality', 'status',
  'confidence', 'importance', 'privacy', 'pinned', 'confirmed',
  'created_at', 'updated_at', 'last_confirmed_at', 'valid_from', 'valid_until',
  'tags', 'sources', 'supersedes', 'contradicts',
  'candidate_reason', 'candidate_expires_at',
] as const

/** Serialize a record to its canonical file text. Deterministic: same record in, same bytes out. */
export function serializeRecord(record: MemoryRecord): string {
  const frontmatter: Record<string, unknown> = {}
  const { body, ...fields } = record
  for (const field of RECORD_FIELD_ORDER) {
    const value = (fields as Record<string, unknown>)[field]
    if (value === undefined) continue
    frontmatter[field] = value
  }
  const yamlText = stringify(frontmatter, { lineWidth: 0 })
  return composeFrontmatter(yamlText, body)
}

/** Field-level deterministic transforms for derived transaction ops. */
export interface RecordDerive {
  status?: MemoryStatus
  revision?: number
  updated_at: string
  last_confirmed_at?: string
  confirmed?: boolean
}

/** Apply a derive patch to a record (pure). */
export function deriveRecord(record: MemoryRecord, derive: RecordDerive): MemoryRecord {
  const next: MemoryRecord = { ...record }
  if (derive.status !== undefined) next.status = derive.status
  if (derive.revision !== undefined) next.revision = derive.revision
  next.updated_at = derive.updated_at
  if (derive.last_confirmed_at !== undefined) next.last_confirmed_at = derive.last_confirmed_at
  if (derive.confirmed !== undefined) next.confirmed = derive.confirmed
  return next
}

// ------------------------------------------------------------ tombstone ----

/** Parse a tombstone YAML file. */
export function parseTombstone(text: string): { tombstone?: Tombstone; issues: SchemaIssue[] } {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    return { issues: [{ message: `tombstone is not valid YAML: ${(error as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { issues: [{ message: 'tombstone must be a YAML mapping' }] }
  }
  const t = raw as Record<string, unknown>
  const issues: SchemaIssue[] = []
  if (t.schema !== 'ohmymemo-tombstone/v1') issues.push({ field: 'schema', message: 'unsupported tombstone schema' })
  if (typeof t.id !== 'string' || !TOMB_ID_RE.test(t.id)) issues.push({ field: 'id', message: 'tombstone id must be tomb_<ulid>' })
  if (t.scope !== 'user' && !(typeof t.scope === 'string' && t.scope.startsWith('workspace:') && WS_ID_RE.test(t.scope.slice('workspace:'.length)))) {
    issues.push({ field: 'scope', message: 'tombstone scope must be "user" or "workspace:ws_<ulid>"' })
  }
  if (typeof t.key !== 'string' || !KEY_RE.test(t.key)) issues.push({ field: 'key', message: 'tombstone key must be normalized' })
  if (!Array.isArray(t.memory_ids) || t.memory_ids.some((id) => typeof id !== 'string' || !MEM_ID_RE.test(id))) {
    issues.push({ field: 'memory_ids', message: 'memory_ids must be an array of memory ids' })
  }
  if (!isIso(t.forgotten_at)) issues.push({ field: 'forgotten_at', message: 'forgotten_at must be an ISO 8601 timestamp' })
  if (typeof t.reason !== 'string' || t.reason.length === 0 || t.reason.length > 200) {
    issues.push({ field: 'reason', message: 'reason must be a short non-empty string' })
  }
  if (issues.length > 0) return { issues }
  return { tombstone: t as unknown as Tombstone, issues: [] }
}

/** Serialize a tombstone to YAML text. Never contains record bodies. */
export function serializeTombstone(tombstone: Tombstone): string {
  const frontmatter: Record<string, unknown> = {
    schema: tombstone.schema,
    id: tombstone.id,
    scope: tombstone.scope,
    key: tombstone.key,
    memory_ids: tombstone.memory_ids,
    forgotten_at: tombstone.forgotten_at,
    reason: tombstone.reason,
  }
  return `${stringify(frontmatter, { lineWidth: 0 })}`
}

// -------------------------------------------------------------- manifest ----

/** Parse the store manifest. */
export function parseManifest(text: string): { manifest?: StoreManifest; issues: SchemaIssue[] } {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    return { issues: [{ message: `manifest is not valid YAML: ${(error as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { issues: [{ message: 'manifest must be a YAML mapping' }] }
  }
  const m = raw as Record<string, unknown>
  const issues: SchemaIssue[] = []
  if (m.schema !== 'ohmymemo-store/v1') issues.push({ field: 'schema', message: 'unsupported store manifest schema' })
  if (typeof m.store_id !== 'string' || !m.store_id.startsWith('oms_')) issues.push({ field: 'store_id', message: 'store_id must be oms_<ulid>' })
  if (!isIso(m.created_at)) issues.push({ field: 'created_at', message: 'created_at must be an ISO 8601 timestamp' })
  if (!Number.isInteger(m.format_version) || (m.format_version as number) < 1) {
    issues.push({ field: 'format_version', message: 'format_version must be a positive integer' })
  }
  if (issues.length > 0) return { issues }
  const manifest = m as unknown as StoreManifest
  if (manifest.format_version > STORE_FORMAT_VERSION) {
    return { issues: [{ field: 'format_version', message: `store format_version ${manifest.format_version} is newer than supported ${STORE_FORMAT_VERSION} — refusing to read (fail loud, no downgrade)` }] }
  }
  return { manifest, issues: [] }
}

/** Serialize the store manifest. */
export function serializeManifest(manifest: StoreManifest): string {
  return `${stringify({
    schema: manifest.schema,
    store_id: manifest.store_id,
    created_at: manifest.created_at,
    format_version: manifest.format_version,
  }, { lineWidth: 0 })}`
}

// ----------------------------------------------------------- scope file ----

/** Parse a workspace scope.yaml. */
export function parseScopeFile(text: string): { scope?: ScopeFile; issues: SchemaIssue[] } {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    return { issues: [{ message: `scope file is not valid YAML: ${(error as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { issues: [{ message: 'scope file must be a YAML mapping' }] }
  }
  const s = raw as Record<string, unknown>
  const issues: SchemaIssue[] = []
  if (s.schema !== 'ohmymemo-scope/v1') issues.push({ field: 'schema', message: 'unsupported scope schema' })
  if (typeof s.id !== 'string' || !WS_ID_RE.test(s.id)) issues.push({ field: 'id', message: 'scope id must be ws_<ulid>' })
  if (s.dsh_workspace_id !== undefined && s.dsh_workspace_id !== null && typeof s.dsh_workspace_id !== 'string') {
    issues.push({ field: 'dsh_workspace_id', message: 'dsh_workspace_id must be a string or null' })
  }
  if (typeof s.canonical_path !== 'string' || s.canonical_path.length === 0 || !s.canonical_path.startsWith('/')) {
    issues.push({ field: 'canonical_path', message: 'canonical_path must be an absolute path' })
  }
  if (!isIso(s.created_at)) issues.push({ field: 'created_at', message: 'created_at must be an ISO 8601 timestamp' })
  if (!isIso(s.updated_at)) issues.push({ field: 'updated_at', message: 'updated_at must be an ISO 8601 timestamp' })
  if (issues.length > 0) return { issues }
  return { scope: s as unknown as ScopeFile, issues: [] }
}

/** Serialize a workspace scope.yaml. */
export function serializeScopeFile(scope: ScopeFile): string {
  return `${stringify({
    schema: scope.schema,
    id: scope.id,
    dsh_workspace_id: scope.dsh_workspace_id ?? null,
    canonical_path: scope.canonical_path,
    created_at: scope.created_at,
    updated_at: scope.updated_at,
  }, { lineWidth: 0 })}`
}

// ----------------------------------------------------------- store config ----

/** Default store config (the design doc's suggested initial policy). */
export function defaultStoreConfig(): StoreUserConfig {
  return {
    schema: 'ohmymemo-config/v1',
    capture_mode: 'direct',
    remember_direct_facts: true,
    allow_inference_candidates: false,
    dream_schedule_local_time: '02:00',
    dream_model_provider: '',
    dream_model: '',
    dream_effort: '',
    auto_consolidation: false,
    watch: true,
    max_record_bytes: 16384,
    max_search_results: 8,
    max_get_records: 8,
    max_injected_bytes: 8192,
    candidate_retention_days: 30,
  }
}

/** Field validators for the user config; invalid fields fall back to defaults with a warning. */
const CONFIG_FIELDS = {
  capture_mode: (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 32,
  remember_direct_facts: (v: unknown): v is boolean => typeof v === 'boolean',
  allow_inference_candidates: (v: unknown): v is boolean => typeof v === 'boolean',
  dream_schedule_local_time: (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v),
  dream_model_provider: (v: unknown): v is string => typeof v === 'string' && v.length <= 200,
  dream_model: (v: unknown): v is string => typeof v === 'string' && v.length <= 200,
  dream_effort: (v: unknown): v is string => typeof v === 'string' && v.length <= 200,
  auto_consolidation: (v: unknown): v is boolean => typeof v === 'boolean',
  watch: (v: unknown): v is boolean => typeof v === 'boolean',
  max_record_bytes: (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 256 && (v as number) <= 1_048_576,
  max_search_results: (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  max_get_records: (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  max_injected_bytes: (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 512 && (v as number) <= 262_144,
  candidate_retention_days: (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
} as const

/**
 * Parse the user-editable `config.yaml`. Tolerant by design: unknown fields
 * and invalid values produce warnings (surfaced by doctor) and the affected
 * field falls back to its default — a hand-damaged policy file must not make
 * the store unopenable.
 */
export function parseStoreConfig(text: string): { config: StoreUserConfig; issues: SchemaIssue[] } {
  const config = defaultStoreConfig()
  const issues: SchemaIssue[] = []
  let raw: unknown
  try {
    raw = parse(text)
  } catch (error) {
    return { config, issues: [{ message: `config.yaml is not valid YAML, using defaults: ${(error as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config, issues: [{ message: 'config.yaml must be a mapping, using defaults' }] }
  }
  const record = raw as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (key === 'schema') continue
    const validator = (CONFIG_FIELDS as Record<string, ((v: unknown) => boolean) | undefined>)[key]
    if (validator === undefined) {
      issues.push({ field: key, message: 'unknown config field (ignored)' })
      continue
    }
    if (!validator(value)) {
      issues.push({ field: key, message: `invalid value ${JSON.stringify(value)}, using default` })
      continue
    }
    ;(config as unknown as Record<string, unknown>)[key] = value
  }
  return { config, issues }
}

/** Serialize the store config (used only to seed the initial file). */
export function serializeStoreConfig(config: StoreUserConfig): string {
  return `${stringify({ ...config }, { lineWidth: 0 })}`
}
