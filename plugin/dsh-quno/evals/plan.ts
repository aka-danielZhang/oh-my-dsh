/**
 * ModelPlan (design §2): the ONE place model configuration is resolved —
 * builtin default → environment → case override → CLI override. The plan
 * records credential REFERENCES (never values) and both the requested route
 * and the provider-resolved route, so the internal role tokens `router` /
 * `worker` are never mistaken for real model IDs.
 *
 * @module dsh-quno/evals/plan
 */

/** One concrete model route. Carries a credential REFERENCE, never a value. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly baseUrl: string
  /** Which env var supplied the credential — the name only. */
  readonly credentialRef: string
  readonly temperature?: number
  readonly maxTokens?: number
}

/** Per-role model routing for one run. */
export interface ModelPlan {
  readonly router: ModelRoute
  readonly worker: ModelRoute
}

export interface PlanOverrides {
  /** `--model <m>`: convenience override for BOTH roles. */
  readonly both?: string
  readonly router?: string
  readonly worker?: string
  readonly baseUrl?: string
  /** Case-level override (weaker than CLI). */
  readonly caseRouter?: string
  readonly caseWorker?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Where the credential actually came from (reference only). */
function credentialRef(env: NodeJS.ProcessEnv): string {
  if (env['QUNO_EVAL_LIVE_API_KEY'] !== undefined && env['QUNO_EVAL_LIVE_API_KEY'] !== '') return 'env:QUNO_EVAL_LIVE_API_KEY'
  if (env['DEEPSEEK_API_KEY'] !== undefined && env['DEEPSEEK_API_KEY'] !== '') return 'env:DEEPSEEK_API_KEY'
  return 'unset'
}

/** Strip query strings and fragments from a base URL (design §7: keys in URLs are dropped). */
export function sanitizeBaseUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return raw.split('?')[0] ?? raw
  }
}

/**
 * Resolve the ModelPlan for one run. Merge order (later wins):
 * builtin default → environment → case override → CLI override.
 */
export function resolveModelPlan(overrides: PlanOverrides = {}): ModelPlan {
  const env = overrides.env ?? process.env
  const envModel = env['QUNO_EVAL_LIVE_MODEL']
  const envBaseUrl = env['QUNO_EVAL_LIVE_BASE_URL']
  const ref = credentialRef(env)

  const route = (model: string): ModelRoute => ({
    provider: 'opencode-go',
    model,
    baseUrl: sanitizeBaseUrl(envBaseUrl ?? 'https://opencode.ai/inference/go/openai/v1'),
    credentialRef: ref,
  })

  const builtinRouter = route('deepseek-v4.1-flash')
  const builtinWorker = route('deepseek-v4.1-flash')

  const afterEnv = {
    router: envModel !== undefined && envModel !== '' ? route(envModel) : builtinRouter,
    worker: envModel !== undefined && envModel !== '' ? route(envModel) : builtinWorker,
  }
  // Optional role-specific env split (undocumented convenience, same rules).
  const envRouterModel = env['QUNO_EVAL_ROUTER_MODEL']
  const envWorkerModel = env['QUNO_EVAL_WORKER_MODEL']
  if (envRouterModel !== undefined && envRouterModel !== '') afterEnv.router = route(envRouterModel)
  if (envWorkerModel !== undefined && envWorkerModel !== '') afterEnv.worker = route(envWorkerModel)

  const afterCase = {
    router: overrides.caseRouter !== undefined ? { ...afterEnv.router, model: overrides.caseRouter } : afterEnv.router,
    worker: overrides.caseWorker !== undefined ? { ...afterEnv.worker, model: overrides.caseWorker } : afterEnv.worker,
  }

  const afterCli = {
    router: overrides.router !== undefined
      ? { ...afterCase.router, model: overrides.router }
      : overrides.both !== undefined ? { ...afterCase.router, model: overrides.both } : afterCase.router,
    worker: overrides.worker !== undefined
      ? { ...afterCase.worker, model: overrides.worker }
      : overrides.both !== undefined ? { ...afterCase.worker, model: overrides.both } : afterCase.worker,
  }

  const baseUrl = overrides.baseUrl !== undefined ? sanitizeBaseUrl(overrides.baseUrl) : undefined
  return {
    router: baseUrl === undefined ? afterCli.router : { ...afterCli.router, baseUrl },
    worker: baseUrl === undefined ? afterCli.worker : { ...afterCli.worker, baseUrl },
  }
}

/** The provider-resolved view of one route (what the adapter actually used). */
export interface ResolvedRoute {
  readonly provider: string
  readonly model: string
  readonly baseUrl: string
}

/** Resolve a route the way the adapter's resolveModel()/request body would. */
export function resolveRoute(route: ModelRoute): ResolvedRoute {
  return { provider: route.provider, model: route.model, baseUrl: route.baseUrl }
}

/** A live plan needs a credential; fail loud before any case runs (design §12). */
export function requireLiveCredential(plan: ModelPlan, env: NodeJS.ProcessEnv = process.env): void {
  if (credentialRef(env) === 'unset') {
    throw new Error(
      'live model mode needs credentials: set QUNO_EVAL_LIVE_API_KEY (or DEEPSEEK_API_KEY); '
      + 'refusing to pretend to pass',
    )
  }
  void plan
}
