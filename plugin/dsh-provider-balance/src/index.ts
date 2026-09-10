/**
 * dsh-provider-balance — Host half.
 *
 * Serves one same-origin JSON endpoint on the DSH web server that reports the
 * remaining quota of the provider the current session's model runs on
 * (`?provider=<route-id>`; omitting the parameter returns every configured
 * source). The browser half (client/client.js) follows the composer's model
 * selection and fetches only that provider's snapshot.
 *
 * Architecture: a small adapter registry. Each upstream is one ADAPTERS entry
 * — the credential env name, the API base, and a `read(getJson)` that maps the
 * upstream's payload onto the normalized wire shape (plan / session / weekly /
 * tools windows). Everything else — credential resolution, authenticated
 * transport, per-provider cache + TTL, in-flight joining, stale fallback, and
 * the HTTP route — is shared plumbing that never changes per provider. Adding
 * a provider is one adapter object plus one line in SOURCES.
 *
 * Design notes (kept in sync with README.md):
 * - Credentials are resolved per request through `ctx.credentials` (optional
 *   service), then the process environment, then the DSH credentials file.
 *   The key never appears in responses, logs, or errors.
 * - Pull model: no background timers. The endpoint serves a cached snapshot
 *   and re-fetches at most once per `refreshMinIntervalMs`; `refresh=1`
 *   forces a bypass (the panel's refresh button).
 * - A failed refresh keeps the last good snapshot, marked `stale`, so a
 *   transient upstream failure never masquerades as zero remaining quota.
 *
 * This module deliberately keeps zero runtime imports on `@deepseek-ai/*`
 * packages: as an out-of-tree directory it is not inside the harness
 * workspace, so package resolution must not depend on it. Only ECMAScript
 * globals (`fetch`, `AbortSignal`, `JSON`), node:fs for the credentials-file
 * fallback, and the injected Cordis context are used.
 */

import { readFileSync } from 'node:fs'

/* ------------------------------------------------------------------ */
/* Wire shapes (JSON-safe; no secrets ever cross to the browser).      */
/* ------------------------------------------------------------------ */

/** One percentage window; token/point totals are optional extras. */
export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  /** Epoch-ms reset deadline when the upstream reports one. */
  resetAt?: number
  /** Absolute used/total in the upstream's native unit, when available. */
  usedTokens?: number
  totalTokens?: number
  /** Upstream window status, surfaced when not the healthy "ok". */
  status?: string
}

/** Count-based quota (tool / web-search calls). */
export interface ToolQuota {
  used: number
  limit: number
  remaining: number
  resetAt?: number
  breakdown: Array<{ code: string; used: number }>
}

/** Plan identity, best-effort decoration from a subscription endpoint.
 * Every field is upstream-provided; adapters never invent names — when the
 * API returns no product name the client falls back to the route label. */
export interface PlanInfo {
  name?: string
  level?: string
  renewDate?: string
}

/** Normalized quotas every adapter maps its upstream onto. */
export interface ProviderQuotas {
  plan?: PlanInfo
  /** 5-hour session window. */
  session?: QuotaWindow
  /** 7-day weekly window. */
  weekly?: QuotaWindow
  /** Calendar-month window (OpenCode Go reports one; others omit it). */
  monthly?: QuotaWindow
  /** Monthly tool/web-search allowance, when the upstream has one. */
  tools?: ToolQuota
  /** Prepaid balances (DeepSeek-style pay-as-you-go; window fields empty). */
  balances?: BalanceInfo[]
}

/** One prepaid currency balance. */
export interface BalanceInfo {
  currency: 'CNY' | 'USD'
  total: number
  granted?: number
  toppedUp?: number
  /** Today's spend in the same unit (gateway-reported, e.g. Sub2API). */
  usedToday?: number
  isAvailable?: boolean
}

/** Wire snapshot for one provider. */
export interface ProviderBalanceSnapshot extends ProviderQuotas {
  /** DSH provider route id this snapshot belongs to. */
  id: string
  ok: boolean
  /** ISO time of the last successful upstream fetch. */
  fetchedAt?: string
  /** True when served from cache after a failed refresh. */
  stale?: boolean
  /** Last refresh failure, retained for the UI while stale data shows. */
  error?: { code: string; message: string }
}

/* ------------------------------------------------------------------ */
/* Adapter registry.                                                   */
/* ------------------------------------------------------------------ */

/** Authenticated JSON GET bound to one adapter's base URL and key. */
type GetJson = (path: string) => Promise<unknown>

/** One upstream quota adapter: credential + base + payload mapping. */
export interface ProviderAdapter {
  /** Credential reference resolved per request. */
  credential: string
  /** API origin the quota endpoints live under. */
  base: string
  /** Map the upstream's payloads onto the normalized quotas. */
  read(getJson: GetJson): Promise<ProviderQuotas>
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Clamp a used-percentage into a wire window, OMITTING absent optionals.
 * An explicit `resetAt: undefined` key fails the JSON wire (lossless-JSON
 * guards treat undefined as non-transportable), so optional fields spread in
 * only when defined. */
function percentWindow(usedPercent: number, resetAt?: number, status?: string): QuotaWindow {
  const used = Math.min(100, Math.max(0, Math.round(usedPercent)))
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(typeof status === 'string' && status !== 'ok' ? { status } : {}),
  }
}

/* ---- zai / GLM Coding (open.bigmodel.cn, api.z.ai) ---- */

interface ZaiLimitRow {
  type?: string
  unit?: number
  number?: number
  usage?: number
  currentValue?: number
  remaining?: number
  percentage?: number
  nextResetTime?: number
  usageDetails?: Array<{ modelCode?: string; usage?: number }>
}

const zaiAdapter: ProviderAdapter = {
  credential: 'ZAI_CODING_CN_API_KEY',
  base: 'https://open.bigmodel.cn',
  async read(getJson) {
    const quota = await getJson('/api/monitor/usage/quota/limit') as {
      success?: boolean
      code?: number
      msg?: string
      data?: { limits?: ZaiLimitRow[]; level?: string }
    }
    if (quota?.success !== true || quota.data == null) {
      throw Object.assign(
        new Error(`quota endpoint code ${String(quota?.code ?? '?')}: ${String(quota?.msg ?? 'n/a')}`),
        { code: 'parse' },
      )
    }
    let session: QuotaWindow | undefined
    let weekly: QuotaWindow | undefined
    let tools: ToolQuota | undefined
    const fallback: QuotaWindow[] = []
    for (const limit of quota.data.limits ?? []) {
      if (limit.type === 'TOKENS_LIMIT') {
        const window = percentWindow(finite(limit.percentage) ?? 0, finite(limit.nextResetTime))
        if (limit.unit === 3 && limit.number === 5 && session === undefined) session = window
        else if (limit.unit === 6 && weekly === undefined) weekly = window
        else fallback.push(window)
      } else if (limit.type === 'TIME_LIMIT' && tools === undefined) {
        const used = finite(limit.currentValue) ?? 0
        const total = finite(limit.usage) ?? 0
        tools = {
          used,
          limit: total,
          remaining: finite(limit.remaining) ?? Math.max(0, total - used),
          ...(finite(limit.nextResetTime) !== undefined ? { resetAt: finite(limit.nextResetTime) } : {}),
          breakdown: Array.isArray(limit.usageDetails)
            ? limit.usageDetails
                .map(detail => ({
                  code: typeof detail.modelCode === 'string' ? detail.modelCode : 'unknown',
                  used: finite(detail.usage) ?? 0,
                }))
                .filter(detail => detail.code !== 'unknown')
            : [],
        }
      }
    }
    // Older/other plans may label windows differently; first unclaimed token
    // window reads as the 5h session, the next as the weekly one.
    if (session === undefined) session = fallback.shift()
    if (weekly === undefined) weekly = fallback.shift()

    let plan: PlanInfo | undefined
    try {
      const sub = await getJson('/api/biz/subscription/list') as {
        data?: Array<{ productName?: string; inCurrentPeriod?: boolean; nextRenewTime?: string }>
      }
      const entry = sub?.data?.find(candidate => candidate.inCurrentPeriod !== false) ?? sub?.data?.[0]
      if (entry?.productName !== undefined) {
        plan = {
          name: entry.productName,
          ...(quota.data.level !== undefined ? { level: quota.data.level } : {}),
          ...(typeof entry.nextRenewTime === 'string' ? { renewDate: entry.nextRenewTime } : {}),
        }
      }
    } catch {
      // Subscription identity is optional decoration.
    }
    return { plan, session, weekly, ...(tools !== undefined ? { tools } : {}) }
  },
}

/* ---- Kimi Code (api.kimi.com; string-valued quota points) ---- */

interface KimiDetail {
  limit?: string | number
  used?: string | number
  remaining?: string | number
  resetTime?: string
}

const KIMI_LEVELS: Record<string, string> = {
  LEVEL_BASIC: 'basic',
  LEVEL_INTERMEDIATE: 'pro',
  LEVEL_ADVANCED: 'max',
}

/** Map one Kimi detail row onto a percentage window over its quota points. */
function kimiWindow(detail: KimiDetail | undefined): QuotaWindow | undefined {
  if (detail === null || typeof detail !== 'object') return undefined
  const limit = Number(detail.limit)
  if (!Number.isFinite(limit) || limit <= 0) return undefined
  const used = Number(detail.used)
  let remaining = Number(detail.remaining)
  if (!Number.isFinite(remaining)) {
    // An EXHAUSTED window omits `remaining` entirely (observed 2026-08-19:
    // a 5h window at 100/100 reports only limit/used/resetTime). Derive the
    // remainder from `used`; the old NaN→limit fallback read exactly as
    // "100% left" while the account was being limited. A window reporting
    // neither field is unreadable — omit it rather than fabricate a value.
    if (!Number.isFinite(used)) return undefined
    remaining = limit - used
  }
  remaining = Math.min(Math.max(remaining, 0), limit)
  const resetAt = typeof detail.resetTime === 'string' ? Date.parse(detail.resetTime) : Number.NaN
  const window = percentWindow(((limit - remaining) / limit) * 100, Number.isFinite(resetAt) ? resetAt : undefined)
  window.usedTokens = limit - remaining
  window.totalTokens = limit
  return window
}

const kimiAdapter: ProviderAdapter = {
  credential: 'KIMI_CODING_API_KEY',
  base: 'https://api.kimi.com',
  async read(getJson) {
    const body = await getJson('/coding/v1/usages') as {
      user?: { membership?: { level?: string } }
      usage?: KimiDetail
      limits?: Array<{ window?: { duration?: number; timeUnit?: string }; detail?: KimiDetail } | KimiDetail>
    }
    if (body === null || typeof body !== 'object' || (body.usage === undefined && !Array.isArray(body.limits))) {
      throw Object.assign(new Error('kimi response lacks usage/limits fields'), { code: 'parse' })
    }
    // usage = the weekly quota; limits[window 300 minutes] = the 5-hour one.
    const weekly = kimiWindow(body.usage)
    let session: QuotaWindow | undefined
    for (const item of body.limits ?? []) {
      const entry = item as { window?: { duration?: number; timeUnit?: string }; detail?: KimiDetail }
      if (entry.window?.duration === 300 && String(entry.window.timeUnit ?? '').includes('MINUTE')) {
        session = kimiWindow(entry.detail ?? (item as KimiDetail))
        break
      }
    }
    const levelRaw = body.user?.membership?.level
    const level = typeof levelRaw === 'string'
      ? KIMI_LEVELS[levelRaw] ?? levelRaw.replace(/^LEVEL_/, '').toLowerCase()
      : undefined
    /* The usages API carries no product name — only the membership level. */
    return {
      ...(level !== undefined ? { plan: { level } } : {}),
      ...(session !== undefined ? { session } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
    }
  },
}

/* ---- OpenCode Go (opencode.ai/zen/go; percent-only windows) ---- */

/**
 * Map one OpenCode usage window `{status, percent, resetsAt}` onto the wire
 * shape. `percent` is ALREADY the used percentage (0-100); a non-ok status
 * rides along for the hint line.
 */
function opencodeWindow(window: { status?: string; percent?: number; resetsAt?: string } | undefined): QuotaWindow | undefined {
  if (window === null || typeof window !== 'object') return undefined
  const percent = finite(window.percent)
  if (percent === undefined) return undefined
  const resetAt = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : Number.NaN
  return percentWindow(percent, Number.isFinite(resetAt) ? resetAt : undefined, window.status)
}

const opencodeAdapter: ProviderAdapter = {
  credential: 'OPENCODE_GO_API_KEY',
  // Origin only: resolveConfig collapses quotaBase to scheme://host, so the
  // /zen/go prefix must live on the request path (not the adapter base).
  // Otherwise getJson('/v1/usage') hits https://opencode.ai/v1/usage → 404.
  base: 'https://opencode.ai',
  async read(getJson) {
    const body = await getJson('/zen/go/v1/usage') as {
      usage?: { rolling?: { status?: string; percent?: number; resetsAt?: string }; weekly?: { status?: string; percent?: number; resetsAt?: string }; monthly?: { status?: string; percent?: number; resetsAt?: string } }
    }
    const usage = body?.usage
    if (usage === null || typeof usage !== 'object') {
      throw Object.assign(new Error('opencode response lacks the usage field'), { code: 'parse' })
    }
    const session = opencodeWindow(usage.rolling)
    const weekly = opencodeWindow(usage.weekly)
    const monthly = opencodeWindow(usage.monthly)
    /* The usage API returns windows only — no product name or tier. */
    return {
      ...(session !== undefined ? { session } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
      ...(monthly !== undefined ? { monthly } : {}),
    }
  },
}

/* ---- DeepSeek official (api.deepseek.com; prepaid balance, documented) ---- */

const deepseekAdapter: ProviderAdapter = {
  credential: 'DEEPSEEK_API_KEY',
  base: 'https://api.deepseek.com',
  async read(getJson) {
    const body = await getJson('/user/balance') as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; topped_up_balance?: string }>
    }
    const infos = body?.balance_infos ?? []
    if (infos.length === 0) {
      throw Object.assign(new Error('deepseek response has no balance_infos'), { code: 'parse' })
    }
    const balances: BalanceInfo[] = []
    for (const info of infos) {
      const total = Number(info.total_balance)
      if (!Number.isFinite(total)) continue
      const granted = Number(info.granted_balance)
      const toppedUp = Number(info.topped_up_balance)
      balances.push({
        currency: info.currency === 'USD' ? 'USD' : 'CNY',
        total,
        ...(Number.isFinite(granted) ? { granted } : {}),
        ...(Number.isFinite(toppedUp) ? { toppedUp } : {}),
        ...(body?.is_available !== undefined ? { isAvailable: body.is_available === true } : {}),
      })
    }
    /* The balance API returns amounts only — no product name or tier. */
    return { balances }
  },
}

/* ---- Moonshot Open Platform (api.moonshot.cn; prepaid balance, documented) ----
 * Distinct from the Kimi Code subscription: this is the pay-as-you-go
 * platform key (sk-...), not the sk-kimi-... coding-plan key. */

const moonshotAdapter: ProviderAdapter = {
  credential: 'MOONSHOT_API_KEY',
  base: 'https://api.moonshot.cn',
  async read(getJson) {
    const body = await getJson('/v1/users/me/balance') as {
      code?: number
      data?: { available_balance?: string; balance?: string; granted_balance?: string; topped_up_balance?: string; currency?: string }
    }
    const data = body?.data
    if (data === null || typeof data !== 'object') {
      throw Object.assign(new Error('moonshot response lacks the data field'), { code: 'parse' })
    }
    const total = Number(data.available_balance ?? data.balance)
    if (!Number.isFinite(total)) {
      throw Object.assign(new Error('moonshot balance fields missing'), { code: 'parse' })
    }
    const granted = Number(data.granted_balance)
    const toppedUp = Number(data.topped_up_balance)
    const balance: BalanceInfo = {
      currency: data.currency === 'USD' ? 'USD' : 'CNY',
      total,
      ...(Number.isFinite(granted) ? { granted } : {}),
      ...(Number.isFinite(toppedUp) ? { toppedUp } : {}),
    }
    return { balances: [balance] }
  },
}

/* ---- xAI (management-api.x.ai; prepaid credits, documented) ----
 * Requires a MANAGEMENT key (console.x.ai → Settings → Management Keys),
 * separate from the inference xai-... key; team_id "default" addresses the
 * default team. Amounts arrive in USD cents; prepaidCredits is an
 * accounting-style negative for remaining credit. */

const xaiAdapter: ProviderAdapter = {
  credential: 'XAI_MANAGEMENT_KEY',
  base: 'https://management-api.x.ai',
  async read(getJson) {
    const team = process.env.XAI_TEAM_ID ?? 'default'
    const body = await getJson(`/v1/billing/teams/${team}/postpaid/invoice/preview`) as {
      coreInvoice?: { prepaidCredits?: { val?: string }; prepaidCreditsUsed?: { val?: string } }
      billingCycle?: { year?: number; month?: number }
    }
    const raw = body?.coreInvoice?.prepaidCredits?.val
    if (raw === undefined) {
      throw Object.assign(new Error('xai response lacks prepaidCredits'), { code: 'parse' })
    }
    const cents = Number(raw)
    if (!Number.isFinite(cents)) {
      throw Object.assign(new Error('xai prepaidCredits is not numeric'), { code: 'parse' })
    }
    const usedCents = Number(body?.coreInvoice?.prepaidCreditsUsed?.val)
    const balance: BalanceInfo = {
      currency: 'USD',
      // Accounting-style negative credit: -4500 cents = $45.00 remaining.
      total: Math.abs(cents) / 100,
      ...(Number.isFinite(usedCents) ? { usedToday: usedCents / 100 } : {}),
    }
    const cycle = body?.billingCycle
    const plan: PlanInfo = cycle !== undefined && typeof cycle.year === 'number' && typeof cycle.month === 'number'
      ? { name: 'xAI', level: `${cycle.year}-${String(cycle.month).padStart(2, '0')}` }
      : { name: 'xAI' }
    return { plan, balances: [balance] }
  },
}

/** Installed adapters by kind; the vocabulary a source config may name. */
const ADAPTERS: Record<string, ProviderAdapter> = {
  'zai-coding': zaiAdapter,
  'kimi-coding': kimiAdapter,
  'opencode-go': opencodeAdapter,
  'deepseek-official': deepseekAdapter,
  'moonshot-platform': moonshotAdapter,
  'xai': xaiAdapter,
  /** Sub2API-family gateways (route-config-driven; see detectGateway). */
  'sub2api-gateway': {
    credential: '', // per-route; filled by the detection
    base: '',
    async read(): Promise<ProviderQuotas> {
      throw new Error('sub2api-gateway is resolved per-route by detection, never statically')
    },
  },
}

/** Map one Sub2API-style /v1/usage body onto the wire shape. */
function sub2apiRead(body: {
  balance?: unknown
  unit?: unknown
  planName?: unknown
  usage?: { today?: { cost?: unknown } } | null
}): ProviderQuotas {
  const balance: BalanceInfo = {
    currency: body.unit === 'CNY' ? 'CNY' : 'USD',
    total: Number(body.balance),
  }
  const usedToday = finite(body.usage?.today?.cost)
  if (usedToday !== undefined) balance.usedToday = usedToday
  const out: ProviderQuotas = { balances: [balance] }
  if (typeof body.planName === 'string' && body.planName.length > 0) {
    out.plan = { name: body.planName }
  }
  return out
}

/**
 * Default served sources: DSH provider route id → adapter kind. The route id
 * is what the browser sends (the composer's current model provider), so a
 * source becomes visible exactly when the session runs on that provider.
 */
const DEFAULT_SOURCES: Array<{ id: string; kind: string }> = [
  { id: 'zai-coding-cn', kind: 'zai-coding' },
  { id: 'kimi-coding', kind: 'kimi-coding' },
  { id: 'opencode-go', kind: 'opencode-go' },
  { id: 'deepseek-official', kind: 'deepseek-official' },
  { id: 'moonshot-platform', kind: 'moonshot-platform' },
  { id: 'xai', kind: 'xai' },
]

/* ------------------------------------------------------------------ */
/* Configuration.                                                      */
/* ------------------------------------------------------------------ */

/** One configured provider source; the id IS the DSH provider route id. */
export interface ProviderBalanceSourceConfig {
  id: string
  /** Adapter kind; must name an entry in the adapter registry. */
  kind?: string
  /** Credential reference; defaults to the adapter's. */
  apiKeyEnv?: string
  /** API origin; defaults to the adapter's. */
  quotaBase?: string
}

/** Plugin configuration (cordis.yml `config:`). */
export interface ProviderBalanceConfig {
  sources?: ProviderBalanceSourceConfig[]
  /** Minimum spacing between upstream fetches per source (ms). */
  refreshMinIntervalMs?: number
  /** Upstream request timeout (ms). */
  requestTimeoutMs?: number
  /** HTTP path served on the DSH web server. */
  route?: string
}

interface ResolvedSource {
  id: string
  kind: string
  apiKeyEnv: string
  quotaBase: string
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code })
}

/** Extract `scheme://host[:port]` from a URL string without the URL global
 * (kept URL-free so the same source runs inside the dynamic sandbox). */
function originOf(baseURL: string): string | undefined {
  const match = /^(https?:\/\/[^/]+)/.exec(baseURL)
  return match === null ? undefined : match[1]
}
const CHAT_PATH_SUFFIXES: Record<string, readonly string[]> = {
  'zai-coding': ['/api/coding/paas/v4', '/api/paas/v4'],
  'kimi-coding': ['/coding/v1', '/v1'],
  /* OpenCode usage is absolute from the host (/zen/go/v1/usage); chat bases
   * like …/zen/go/v1 are collapsed to origin, so no suffix strip is needed. */
  'opencode-go': [],
  'deepseek-official': [],
}

/** Hand-rolled config validation: loud and early, no schemastery dependency. */
function resolveConfig(raw: unknown): {
  sources: ResolvedSource[]
  refreshMinIntervalMs: number
  requestTimeoutMs: number
  route: string
} {
  const config = (raw ?? {}) as ProviderBalanceConfig
  if (typeof config !== 'object' || config === null) fail('config', 'config must be an object')

  const rawSources = config.sources ?? DEFAULT_SOURCES
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    fail('config.sources', 'config.sources must be a non-empty array')
  }
  const sources = rawSources.map((source, index): ResolvedSource => {
    if (typeof source !== 'object' || source === null) {
      fail(`config.sources[${index}]`, 'each source must be an object')
    }
    if (typeof source.id !== 'string' || source.id.length === 0) {
      fail(`config.sources[${index}].id`, 'source.id must be a non-empty string')
    }
    const kind = source.kind ?? DEFAULT_SOURCES.find(def => def.id === source.id)?.kind
    const adapter = kind !== undefined ? ADAPTERS[kind] : undefined
    if (adapter === undefined) {
      fail(`config.sources[${index}].kind`, `unknown source kind "${String(kind)}" (supported: ${Object.keys(ADAPTERS).join(', ')})`)
    }
    const apiKeyEnv = source.apiKeyEnv ?? adapter.credential
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) {
      fail(`config.sources[${index}].apiKeyEnv`, 'apiKeyEnv must be a non-empty string')
    }
    let quotaBase = (source.quotaBase ?? adapter.base).replace(/\/+$/, '')
    // The DSH provider route baseURL points at the chat endpoint; the quota
    // APIs live on the bare host. Strip the known chat paths per kind.
    for (const suffix of CHAT_PATH_SUFFIXES[kind as string] ?? []) {
      if (quotaBase.endsWith(suffix)) {
        quotaBase = quotaBase.slice(0, -suffix.length)
        break
      }
    }
    const quotaOrigin = originOf(quotaBase)
    if (quotaOrigin === undefined) {
      fail(`config.sources[${index}].quotaBase`, `quotaBase "${quotaBase}" is not a valid http(s) URL`)
    }
    quotaBase = quotaOrigin as string
    return { id: source.id, kind: kind as string, apiKeyEnv, quotaBase }
  })

  const refreshMinIntervalMs = config.refreshMinIntervalMs ?? 60_000
  if (typeof refreshMinIntervalMs !== 'number' || !Number.isFinite(refreshMinIntervalMs) || refreshMinIntervalMs < 0) {
    fail('config.refreshMinIntervalMs', 'refreshMinIntervalMs must be a non-negative number')
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? 15_000
  if (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    fail('config.requestTimeoutMs', 'requestTimeoutMs must be a positive number')
  }
  const route = config.route ?? '/provider-balance/quota'
  if (typeof route !== 'string' || !route.startsWith('/') || route.includes('?')) {
    fail('config.route', 'route must be an absolute pathname')
  }
  return { sources, refreshMinIntervalMs, requestTimeoutMs, route }
}

/* ------------------------------------------------------------------ */
/* Transport + snapshot assembly.                                      */
/* ------------------------------------------------------------------ */

/** One authenticated JSON GET with timeout; throws tagged errors. */
async function getJsonFrom(url: string, apiKey: string, requestTimeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http', status: response.status })
  }
  return response.json()
}

/** Upstream error → { code, message }; never includes the key. */
function describeUpstreamError(error: unknown): { code: string; message: string } {
  const err = error as { code?: string; status?: number; message?: string }
  if (typeof err.status === 'number') {
    if (err.status === 401 || err.status === 403) {
      return { code: 'auth', message: `API key rejected (HTTP ${err.status}); check the provider credential` }
    }
    return { code: 'http', message: `upstream HTTP ${err.status}` }
  }
  if (err?.code === 'missing-key') return { code: 'missing-key', message: String(err.message) }
  if (err?.code === 'parse') return { code: 'parse', message: String(err.message) }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { code: 'timeout', message: 'upstream request timed out' }
  }
  if (error instanceof TypeError) {
    return { code: 'network', message: 'network error contacting the provider' }
  }
  return { code: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

interface SourceState {
  snapshot?: ProviderBalanceSnapshot
  inFlight?: Promise<ProviderBalanceSnapshot>
  fetchedAt?: number
}

/** One refresh attempt, recorded for after-the-fact diagnosis. Never carries
 * secrets: `via` names only the credential LAYER, errors are status-coded. */
interface RefreshEvent {
  at: string
  ok: boolean
  /** Credential layer that supplied the key: credentials | env | file. */
  via?: string
  durationMs: number
  error?: { code: string; message: string }
}

/** Minimal slice of the Cordis context this plugin consumes. */
export interface PluginContext {
  webServer: {
    register: (route: {
      kind: string
      path: string
      handler: (req: unknown, res: {
        setHeader: (name: string, value: string) => void
        end: (body?: string) => void
      }) => void | Promise<void>
    }) => () => void
  }
  get?: (name: string) => unknown
  on?: (event: string, listener: (payload: unknown) => void) => void
  effect?: (callback: () => () => void, label?: string) => () => void
}

/**
 * Host plugin body: registers one exact-path JSON route on the web server.
 *
 * Query parameters: `provider=<route-id>` scopes the response to one source
 * (the browser half's mode — exactly the composer's current model provider);
 * without it every configured source is returned. `refresh=1` bypasses the
 * per-source TTL once.
 *
 * @param ctx - Cordis context carrying the `webServer` service.
 * @param rawConfig - plugin configuration (validated by hand; see resolveConfig).
 */
export function apply(ctx: PluginContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const states = new Map<string, SourceState>()
  for (const source of config.sources) states.set(source.id, {})

  /**
   * The credentials service is looked up PER RESOLUTION, never captured at
   * apply time: this plugin may activate before the provider mounts, and a
   * captured `undefined` would stick — the fallback layers below then freeze
   * whatever they saw at first use, so key rotation in the credentials store
   * never reaches the adapters until a restart (the "changed the key but the
   * panel still shows the old account" bug).
   */
  const credentialsService = (): { resolve: (ref: string) => Promise<{ value: string } | undefined> } | undefined =>
    (typeof ctx.get === 'function' ? ctx.get('credentials') : undefined) as
      | { resolve: (ref: string) => Promise<{ value: string } | undefined> }
      | undefined

  /**
   * Fresh read of the DSH credentials file (the credentials-local provider's
   * managed layer). Re-read per resolution — no cache: the document is a
   * handful of lines, reads are TTL-gated, and a frozen copy was the other
   * half of the key-rotation bug.
   */
  const readCredentialsFile = (): Map<string, string> => {
    const map = new Map<string, string>()
    try {
      const home = process.env.DSH_HOME ?? `${process.env.HOME ?? ''}/.dsh`
      if (home.length > 0) {
        const text = readFileSync(`${home}/.credentials.yaml`, 'utf8') as string
        for (const line of text.split('\n')) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(line)
          if (match !== null) map.set(match[1], match[2].trim().replace(/^['"]|['"]$/g, ''))
        }
      }
    } catch {
      // Absent or unreadable file: not an error, the layer is simply empty.
    }
    return map
  }

  /** Credential resolution: credentials service → process env → credentials file.
   * Returns the value plus WHICH layer supplied it (`via`), so refresh events
   * can name the layer without ever recording the key itself. */
  const resolveKeyByEnv = async (apiKeyEnv: string): Promise<{ value: string; via: string } | undefined> => {
    const credentials = credentialsService()
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(apiKeyEnv)
        if (resolved !== undefined && resolved.value.length > 0) return { value: resolved.value, via: 'credentials' }
      } catch (error) {
        console.warn('provider-balance: credentials resolve for %s failed: %s', apiKeyEnv, String(error))
      }
    }
    const fromEnv = process.env[apiKeyEnv]
    if (fromEnv !== undefined && fromEnv.length > 0) return { value: fromEnv, via: 'env' }
    const fromFile = readCredentialsFile().get(apiKeyEnv)
    return fromFile !== undefined && fromFile.length > 0 ? { value: fromFile, via: 'file' } : undefined
  }

  const resolveKey = (source: ResolvedSource): Promise<{ value: string; via: string } | undefined> => resolveKeyByEnv(source.apiKeyEnv)

  /** Per-source ring buffer of recent refresh outcomes (newest last). */
  const EVENTS_PER_SOURCE = 30
  const events = new Map<string, RefreshEvent[]>()
  const recordEvent = (id: string, event: RefreshEvent): void => {
    const list = events.get(id) ?? []
    list.push(event)
    if (list.length > EVENTS_PER_SOURCE) list.shift()
    events.set(id, list)
  }

  /** Fetch one source through its adapter; never throws. */
  const refresh = (source: ResolvedSource, adapterOverride?: ProviderAdapter): Promise<ProviderBalanceSnapshot> => {
    const state = states.get(source.id) as SourceState
    if (state.inFlight !== undefined) return state.inFlight
    const adapter = adapterOverride ?? ADAPTERS[source.kind]
    const task = (async (): Promise<ProviderBalanceSnapshot> => {
      const startedAt = Date.now()
      let via: string | undefined
      try {
        const resolvedKey = await resolveKey(source)
        if (resolvedKey === undefined) {
          fail('missing-key', `no credential "${source.apiKeyEnv}" configured (env or DSH credentials store)`)
        }
        via = resolvedKey.via
        const getJson = (path: string) => getJsonFrom(`${source.quotaBase}${path}`, resolvedKey.value, config.requestTimeoutMs)
        const quotas = await adapter.read(getJson)
        recordEvent(source.id, { at: new Date().toISOString(), ok: true, via, durationMs: Date.now() - startedAt })
        return {
          id: source.id,
          ok: true,
          ...quotas,
          fetchedAt: new Date().toISOString(),
          stale: false,
        }
      } catch (error) {
        const described = describeUpstreamError(error)
        recordEvent(source.id, {
          at: new Date().toISOString(),
          ok: false,
          ...(via !== undefined ? { via } : {}),
          durationMs: Date.now() - startedAt,
          error: described,
        })
        // Straight to the process console: this harness wires no stdout sink
        // for ctx.logger records, so only console output reaches a tee'd log.
        console.warn('provider-balance: %s refresh failed (%s): %s', source.id, described.code, described.message)
        const previous = state.snapshot
        if (previous?.ok === true) {
          // Keep the last good reading, explicitly marked stale.
          const staleSnapshot: ProviderBalanceSnapshot = { ...previous, stale: true, error: described }
          state.snapshot = staleSnapshot
          state.fetchedAt = Date.now()
          return staleSnapshot
        }
        return { id: source.id, ok: false, error: described }
      } finally {
        state.inFlight = undefined
      }
    })()
    state.inFlight = task
    return task
  }

  /** Served snapshot for one source: cache + TTL + in-flight join. */
  const snapshotFor = (source: ResolvedSource, force: boolean, adapterOverride?: ProviderAdapter): Promise<ProviderBalanceSnapshot> => {
    const state = states.get(source.id) as SourceState
    if (state === undefined) {
      // A dynamically detected route has no configured source entry; give it
      // a transient state so cache/in-flight joining still applies.
      const transient: SourceState = {}
      states.set(source.id, transient)
      return runSnapshot(source, transient, force, adapterOverride)
    }
    return runSnapshot(source, state, force, adapterOverride)
  }

  const runSnapshot = (source: ResolvedSource, state: SourceState, force: boolean, adapterOverride?: ProviderAdapter): Promise<ProviderBalanceSnapshot> => {
    const fresh = state.fetchedAt !== undefined && Date.now() - state.fetchedAt < config.refreshMinIntervalMs
    if (!force && fresh && state.snapshot !== undefined) return Promise.resolve(state.snapshot)
    if (state.inFlight !== undefined) return state.inFlight
    const task = refresh(source, adapterOverride)
    // Register the outcome (and its timestamp, so a failing upstream is not
    // re-hit on every poll); refresh() already stored the stale fallback.
    task.then(snapshot => {
      state.snapshot = snapshot
      state.fetchedAt = Date.now()
    }).catch(() => undefined)
    return task
  }

  /* ---------- Sub2API-style gateway auto-detection ---------- */

  /** Detection result cache (positive AND negative) per provider route. */
  const detected = new Map<string, { adapter?: ProviderAdapter; at: number }>()
  const DETECT_TTL_MS = 10 * 60 * 1000

  /** Read one route's llm-pi-ai settings entry: baseURL + apiKeyEnv. */
  const routeConfigOf = (provider: string): { origin: string; apiKeyEnv: string } | undefined => {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (settings === undefined) return undefined
    try {
      const section = (settings as { get?: (ns: string) => unknown }).get?.('llm-pi-ai') as
        | { providers?: Record<string, { baseURL?: unknown; apiKeyEnv?: unknown }> }
        | undefined
      const route = section?.providers?.[provider]
      if (route === null || typeof route !== 'object') return undefined
      const baseURL = typeof route.baseURL === 'string' ? route.baseURL : undefined
      const apiKeyEnv = typeof route.apiKeyEnv === 'string' ? route.apiKeyEnv : undefined
      if (baseURL === undefined || apiKeyEnv === undefined) return undefined
      const origin = originOf(baseURL)
      if (origin === undefined) return undefined
      return { origin, apiKeyEnv }
    } catch {
      return undefined
    }
  }

  /**
   * Probe one route for a Sub2API-style /v1/usage endpoint. Recognition is a
   * SHAPE check on the response (numeric balance + string unit), keyed to the
   * route's own credential — nothing about the gateway is hardcoded.
   */
  const detectGateway = async (provider: string): Promise<ProviderAdapter | undefined> => {
    const cachedDetection = detected.get(provider)
    if (cachedDetection !== undefined && Date.now() - cachedDetection.at < DETECT_TTL_MS) {
      return cachedDetection.adapter
    }
    let adapter: ProviderAdapter | undefined
    const route = routeConfigOf(provider)
    if (route !== undefined) {
      const key = await resolveKeyByEnv(route.apiKeyEnv)
      if (key !== undefined) {
        try {
          const body = await getJsonFrom(`${route.origin}/v1/usage`, key.value, config.requestTimeoutMs) as Parameters<typeof sub2apiRead>[0]
          if (typeof body?.balance === 'number' && Number.isFinite(body.balance) && typeof body.unit === 'string') {
            adapter = {
              credential: route.apiKeyEnv,
              base: route.origin,
              read: async getJson => sub2apiRead(await getJson('/v1/usage') as Parameters<typeof sub2apiRead>[0]),
            }
          }
        } catch {
          // Not a usage-capable gateway — negative cache below.
        }
      }
    }
    detected.set(provider, { adapter, at: Date.now() })
    return adapter
  }

  /** Resolve one provider id into a servable source: configured, or detected. */
  const resolveProvider = async (provider: string): Promise<{ source: ResolvedSource; adapter?: ProviderAdapter } | undefined> => {
    const configured = config.sources.find(source => source.id === provider)
    if (configured !== undefined) return { source: configured }
    const adapter = await detectGateway(provider)
    if (adapter === undefined) return undefined
    return {
      source: { id: provider, kind: 'sub2api-gateway', apiKeyEnv: adapter.credential, quotaBase: adapter.base },
      adapter,
    }
  }

  /**
   * Key rotation invalidates cached snapshots immediately: after a credential
   * commit, every quota fetched through that reference belongs to the old
   * key's account, so the next poll re-fetches instead of serving the old
   * account's numbers until the TTL expires. (The detection cache stays: it
   * remembers endpoint SHAPES, never key values.)
   */
  ctx.on?.('credentials/reference-updated', (ref: unknown) => {
    if (typeof ref !== 'string') return
    for (const [id, state] of states) {
      const configured = config.sources.find(source => source.id === id)
      const apiKeyEnv = configured?.apiKeyEnv ?? routeConfigOf(id)?.apiKeyEnv
      if (apiKeyEnv === ref) {
        state.snapshot = undefined
        state.fetchedAt = undefined
      }
    }
  })

  const handler = async (req: unknown, res: {
    setHeader: (name: string, value: string) => void
    end: (body?: string) => void
  }): Promise<void> => {
    const url = new URL((req as { url?: string }).url ?? '/', 'http://local')
    const force = url.searchParams.get('refresh') === '1'
    const provider = url.searchParams.get('provider') ?? undefined
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    /* Diagnostics: `?events=1` returns the per-source ring buffers of recent
     * refresh outcomes instead of quota snapshots — the answer to "the badge
     * keeps showing '!', what happened". */
    if (url.searchParams.get('events') === '1') {
      const payload: Record<string, RefreshEvent[]> = {}
      for (const [id, list] of events) {
        if (provider !== undefined && id !== provider) continue
        payload[id] = list
      }
      res.end(JSON.stringify({ events: payload, servedAt: new Date().toISOString() }))
      return
    }
    try {
      let sources: ProviderBalanceSnapshot[]
      if (provider !== undefined) {
        const resolved = await resolveProvider(provider)
        sources = resolved === undefined
          ? []
          : [await snapshotFor(resolved.source, force, resolved.adapter)]
      } else {
        sources = await Promise.all(config.sources.map(source => snapshotFor(source, force)))
      }
      // Lossless-JSON backstop: JSON round-trip drops any undefined-valued
      // keys before the payload crosses the wire.
      res.end(JSON.stringify({ sources, servedAt: new Date().toISOString() }))
    } catch (error) {
      res.end(JSON.stringify({ sources: [], error: describeUpstreamError(error), servedAt: new Date().toISOString() }))
    }
  }

  ctx.effect?.(
    () => ctx.webServer.register({ kind: 'exact', path: config.route, handler }),
    'provider-balance: quota route',
  )
  console.log(
    'provider-balance: serving %s for %s',
    config.route,
    config.sources.map(source => source.id).join(', '),
  )
}

export default apply
