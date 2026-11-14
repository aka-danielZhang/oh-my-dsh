/**
 * The production model seam for Live mode: Live 主路径走生产原链路.
 *
 * Mounts the REAL `llm-pi-ai` PiAiAdapter over a route built from the pi-ai
 * builtin catalog (`@earendil-works/pi-ai/providers/all` + `createProvider`) —
 * the same adapter semantics, catalog metadata, session-affinity headers,
 * retry policy and usage details the desktop serves. The eval gateway wraps
 * this adapter for recording only; nothing here re-implements the wire
 * protocol. No production code is modified.
 *
 * @module dsh-quno/evals/models/production
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'

/** Profile defaults mirrored from llm-pi-ai/src/config.ts (shipped values). */
const STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const REQUEST_IMAGE_PIXEL_BUDGET = 2048 * 2048
const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/** OpenCode session affinity, matching llm-pi-ai's effectiveSessionAffinityHeaders. */
const OPENCODE_AFFINITY_HEADERS = ['x-opencode-session', 'x-client-request-id'] as const

export interface ProductionMountInput {
  /** The harness route key (e.g. 'opencode-go'). */
  readonly provider: string
  /** Models the eval plan names for this route; empty = whole catalog. */
  readonly models: readonly string[]
  /** Resolves the credential at request time (never recorded). */
  readonly apiKey: () => string | undefined
  readonly logger: { warn(message: string): void }
}

/**
 * Build the production PiAiAdapter for the plan's route. The pi-ai dependency
 * is reached through the fork package's own node_modules (it is not a direct
 * dependency of the plugin), located by walking up from the fork's entry.
 */
export async function createProductionAdapter(input: ProductionMountInput): Promise<PiAiAdapter> {
  const { piAi, providersAll, completionsFactory } = await loadPiAi()

  const catalogModels = [...providersAll.getBuiltinModels(input.provider)]
  if (catalogModels.length === 0) {
    throw new Error(`eval production adapter: the pi-ai catalog has no models for route "${input.provider}"`)
  }
  const wanted = input.models.length > 0
    ? catalogModels.filter(model => input.models.includes(model.id))
    : catalogModels
  const missing = input.models.filter(id => !catalogModels.some(model => model.id === id))
  if (missing.length > 0) {
    throw new Error(`eval production adapter: models not in the "${input.provider}" catalog: ${missing.join(', ')}`)
  }
  const apis = new Set(wanted.map(model => String(model.api)))
  if (apis.size !== 1) {
    throw new Error(`eval production adapter: mixed wire protocols on one route: ${[...apis].join(', ')}`)
  }
  const apiName = [...apis][0] ?? 'openai-completions'
  if (apiName !== 'openai-completions') {
    throw new Error(`eval production adapter: only the openai-completions protocol is wired for eval routes; route asks for ${apiName}`)
  }
  const models = wanted.map(model => structuredClone(model))
  const baseUrl: string = typeof models[0]?.baseUrl === 'string' ? models[0].baseUrl : `https://${input.provider}`

  const piProvider = piAi.createProvider({
    id: input.provider,
    name: input.provider,
    baseUrl,
    auth: {
      // pi-ai ApiKeyAuth face (same shape as llm-pi-ai's harnessApiKeyAuth).
      apiKey: {
        name: input.provider,
        resolve: ({ credential }: { credential?: { key?: string } }) => {
          const key = credential?.key ?? input.apiKey()
          return Promise.resolve({
            auth: key === undefined || key === '' ? {} : { apiKey: key },
            source: input.provider,
          })
        },
      },
    },
    models,
    api: completionsFactory(),
  })

  const retryPolicy: ResolvedRetryPolicy = resolveRetryPolicy(undefined, 'eval production adapter retry policy')
  const profile = {
    provider: input.provider,
    displayName: input.provider,
    apiKeyEnv: 'QUNO_EVAL_LIVE_API_KEY',
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: REQUEST_IMAGE_MAX_BYTES,
    retryPolicy,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    sessionAffinityHeaders: [...OPENCODE_AFFINITY_HEADERS],
    piProvider,
  } as unknown as ResolvedPiAiProviderProfile
  const profiles = new Map([[input.provider, profile]])

  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => {
      const key = input.apiKey()
      if (key === undefined || key === '') {
        throw Object.assign(
          new Error(`no credential for provider route "${input.provider}"; set QUNO_EVAL_LIVE_API_KEY`),
          { name: 'LlmError' },
        )
      }
      return key
    },
    // The pi-ai auth types are structural; the eval store/context satisfy them
    // without importing the transitive package by name.
    auth: {
      credentials: minimalCredentialStore(),
      authContext: minimalAuthContext(),
    } as PiAiAdapterOptions['auth'],
    resolveAttachments: () => undefined,
    onReplayDegrade: ({ reason }) => {
      input.logger.warn(`eval production adapter: replay degrade ${reason}`)
    },
  })
}

/** Load pi-ai through the fork package's own dependency tree (pnpm layout). */
async function loadPiAi(): Promise<{
  readonly piAi: { createProvider(spec: Record<string, unknown>): unknown }
  readonly providersAll: { readonly getBuiltinModels: (provider: string) => readonly { readonly id: string; readonly api: unknown; readonly baseUrl?: string }[] }
  readonly completionsFactory: () => unknown
}> {
  const req = createRequire(import.meta.url)
  const forkEntry = req.resolve('@deepseek-ai/dsh-llm-pi-ai')
  // Walk up from the fork entry until its sibling node_modules carries pi-ai.
  let dir = dirname(forkEntry)
  let piRoot: string | undefined
  for (let depth = 0; depth < 8; depth += 1) {
    dir = dirname(dir)
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist')
    if (existsSync(join(candidate, 'providers', 'all.js'))) {
      piRoot = candidate
      break
    }
  }
  if (piRoot === undefined) {
    throw new Error('eval production adapter: cannot locate @earendil-works/pi-ai next to the llm-pi-ai fork')
  }
  // The pi-ai dist is ESM-only: dynamic import, not require.
  const piAi = await import(pathToFileURL(join(piRoot, 'index.js')).href) as {
    createProvider(spec: Record<string, unknown>): unknown
  }
  const providersAll = await import(pathToFileURL(join(piRoot, 'providers', 'all.js')).href) as {
    getBuiltinModels(provider: string): readonly { id: string; api: unknown; baseUrl?: string }[]
  }
  const completionsLazy = await import(pathToFileURL(join(piRoot, 'api', 'openai-completions.lazy.js')).href) as {
    openAICompletionsApi(): unknown
  }
  return {
    piAi,
    providersAll,
    completionsFactory: () => completionsLazy.openAICompletionsApi(),
  }
}

/** No-op credential store: the eval route authenticates via resolveApiKey only. */
/** Minimal pi-ai CredentialStore face (the eval route authenticates via resolveApiKey). */
function minimalCredentialStore(): unknown {
  return {
    async read() { return undefined },
    async list() { return [] },
    async write() { throw new Error('eval credential store is read-only') },
    async delete() { throw new Error('eval credential store is read-only') },
  }
}

/** Ambient lookups over the eval process environment (pi-ai AuthContext face). */
function minimalAuthContext(): unknown {
  return {
    async env(name: string) { return process.env[name] },
    async fileExists() { return false },
    async readFile() { throw new Error('eval auth context reads no files') },
  }
}
