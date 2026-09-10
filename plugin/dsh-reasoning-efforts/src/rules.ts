/**
 * Pure planning logic for dsh-reasoning-efforts.
 *
 * The plugin's one job: give hand-declared `llm-pi-ai` models the
 * `reasoningEfforts` declaration they lack — and, where a rule opts in, the
 * compat switches (`supportsReasoningEffort`, `thinkingFormat`) that let the
 * declared efforts actually reach the wire on vendors whose auto-detection
 * would suppress them — so the composer's model picker offers reasoning
 * levels for them (upstream discussion #843 — the GUI has no editor for
 * these fields, and gateway model listings carry no reasoning metadata at
 * all).
 *
 * A model becomes a fill candidate through three gates, split so this module
 * stays synchronous and side-effect free:
 *
 * 1. the raw user layer does not already declare what a rule would add — an
 *    explicit statement (including `false`) is never overridden; the efforts
 *    piece gates on the whole `reasoningEfforts` key, the compat piece field
 *    by field;
 * 2. an ordered rule matches the route and model id — first match wins, so a
 *    narrowing rule (e.g. pin `*-non-reasoning` to `false`) can precede a
 *    broad filling rule;
 * 3. the live adapter does not already offer efforts for the route/model —
 *    catalog-inherited capability (an `openai` route serving `gpt-5.1`)
 *    must not be flattened into a rule's preset. This gate applies only to
 *    the efforts piece; it reads the `llm` service, so the apply side runs
 *    it between {@link collectCandidates} and {@link buildFillOps}.
 *
 * Writes are path-addressed `set` ops against the raw user layer (never the
 * schema-resolved view — persisting materialized defaults would bake them
 * into `settings.yaml`). The plugin only ever sets keys; removing a
 * declaration stays a hand edit, deliberately.
 */

/** Every pi-ai thinking level, mirroring llm-pi-ai's THINKING_LEVELS. */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * One pi-ai thinking level.
 */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * Every reasoning-dispatch wire format pi-ai's OpenAI-completions dispatch
 * knows. A deliberate local mirror of llm-pi-ai's SUPPORTED_THINKING_FORMATS:
 * validation names a drift here instead of linking a harness package for
 * values, which the host bundle must never do.
 */
export const THINKING_FORMATS = [
  'openai',
  'deepseek',
  'openrouter',
  'together',
  'baseten',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
] as const

/** One pi-ai wire thinking format. */
export type ThinkingFormat = (typeof THINKING_FORMATS)[number]

/**
 * The compat switches a rule may fill: llm-pi-ai accepts these on an
 * OpenAI-completions profile, and they decide whether the declared efforts
 * actually reach the wire (`supportsReasoningEffort`) and how dispatch spells
 * them (`thinkingFormat`). Vendors like Z.ai detect to `false` on both, so a
 * hand-declared model must state them explicitly or its selector does nothing.
 * Unknown fields are refused at config time — resolution fail-louds on them,
 * so writing one would brick the route rather than help.
 */
export interface CompatDeclaration {
  /** Whether dispatch may send `reasoning_effort`. */
  readonly supportsReasoningEffort?: boolean
  /** Which wire format dispatch uses to spell thinking params. */
  readonly thinkingFormat?: ThinkingFormat
}

/**
 * One `reasoningEfforts` declaration as llm-pi-ai's schema accepts it:
 * `false` pins a non-reasoning model; a dict declares the offered levels and
 * their wire spellings, where only `off` may leave the value empty ("send
 * nothing") and every other level needs the wire value dispatch sends.
 */
export type EffortsDeclaration = false | Partial<Record<ThinkingLevel, string | null>>

/** One validated fill rule. */
export interface EffortRule {
  /** Route ids (settings dict keys) this rule applies to; exact match. */
  readonly routes: readonly string[]
  /** Regex a model id must match. */
  readonly include: RegExp
  /** Optional regex that wins over {@link include} when it matches. */
  readonly exclude: RegExp | undefined
  /** The declaration a matched model receives. */
  readonly efforts: EffortsDeclaration
  /**
   * Optional compat switches filled alongside the efforts — but only the
   * fields the model entry does not already declare (field-level gate 1).
   */
  readonly compat: CompatDeclaration | undefined
}

/** Validated plugin configuration. */
export interface ReasoningEffortsConfig {
  readonly rules: readonly EffortRule[]
}

/** One model the two pure gates selected for a fill, split by need. */
export interface FillCandidate {
  readonly route: string
  readonly modelId: string
  /**
   * The efforts declaration to write — absent only when the model entry
   * already declares `reasoningEfforts` (gate 1) and the live adapter gate
   * {@link CollectContext} dropped the piece.
   */
  readonly efforts: EffortsDeclaration | undefined
  /**
   * The compat fields to merge in — exactly the rule's compat fields the
   * entry does not already declare; undefined when there is nothing to add.
   */
  readonly compatFill?: CompatDeclaration | undefined
  /** Where the entry lives: a `models` array index, or a `modelOverrides` key. */
  readonly source: 'models' | 'modelOverrides'
  /** Index into the route's `models` array; meaningless for modelOverrides. */
  readonly index: number
}

/** One path-addressed user-layer write, shaped like dsh-settings' set op. */
export interface PathSetOp {
  readonly op: 'set'
  readonly path: readonly string[]
  readonly value: unknown
}

/** Plain-object check that excludes arrays (settings path ops treat arrays as opaque values). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate the plugin configuration, failing loud at the earliest point.
 * Mirrors the checks llm-pi-ai's own profile resolution makes, so a fill can
 * never write a section the settings namespace validator would reject.
 * @param raw - the composition row's `config` value.
 * @returns the validated rules (an absent `rules` key is the dormant posture).
 * @throws Error naming the offending rule and field.
 */
export function validateConfig(raw: unknown): ReasoningEffortsConfig {
  if (raw === undefined || raw === null) return { rules: [] }
  if (!isPlainObject(raw)) {
    throw new Error('dsh-reasoning-efforts: config must be an object with a "rules" array')
  }
  const rawRules = raw.rules
  if (rawRules === undefined) return { rules: [] }
  if (!Array.isArray(rawRules)) {
    throw new Error('dsh-reasoning-efforts: config.rules must be an array')
  }
  const rules = rawRules.map((rawRule, position) => {
    const where = `dsh-reasoning-efforts: rules[${position}]`
    if (!isPlainObject(rawRule)) throw new Error(`${where} must be an object`)
    const { routes, include, exclude, efforts } = rawRule
    if (!Array.isArray(routes) || routes.length === 0
      || routes.some(route => typeof route !== 'string' || route.length === 0)) {
      throw new Error(`${where}.routes must be a non-empty array of non-empty route ids`)
    }
    if (typeof include !== 'string' || include.length === 0) {
      throw new Error(`${where}.include must be a non-empty regex source`)
    }
    const includeRe = compile(include, `${where}.include`)
    if (exclude !== undefined && typeof exclude !== 'string') {
      throw new Error(`${where}.exclude must be a regex source string`)
    }
    const excludeRe = exclude === undefined ? undefined : compile(exclude, `${where}.exclude`)
    return {
      routes: [...routes],
      include: includeRe,
      exclude: excludeRe,
      efforts: validateEfforts(efforts, `${where}.efforts`),
      compat: rawRule.compat === undefined
        ? undefined
        : validateCompat(rawRule.compat, `${where}.compat`),
    }
  })
  return { rules }
}

/** Compile one regex source, naming the field on failure. */
function compile(source: string, field: string): RegExp {
  try {
    return new RegExp(source)
  } catch (error) {
    throw new Error(`${field} is not a valid regex: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Validate one compat declaration. Only the two fields llm-pi-ai's
 * OpenAI-completions profiles take are accepted, with their exact value
 * types; an empty dict is meaningless and refused.
 * @param raw - the configured declaration.
 * @param field - the config path naming this declaration in diagnostics.
 * @returns the validated declaration.
 * @throws Error naming the offending entry.
 */
export function validateCompat(raw: unknown, field: string): CompatDeclaration {
  if (!isPlainObject(raw)) {
    throw new Error(`${field} must be an object with supportsReasoningEffort and/or thinkingFormat`)
  }
  const entries = Object.entries(raw)
  if (entries.length === 0) {
    throw new Error(`${field} is empty; declare at least one compat switch`)
  }
  const validated: { supportsReasoningEffort?: boolean; thinkingFormat?: ThinkingFormat } = {}
  for (const [key, value] of entries) {
    if (key === 'supportsReasoningEffort') {
      if (typeof value !== 'boolean') {
        throw new Error(`${field}.supportsReasoningEffort must be true or false`)
      }
      validated.supportsReasoningEffort = value
    } else if (key === 'thinkingFormat') {
      if (!(THINKING_FORMATS as readonly string[]).includes(value as string)) {
        throw new Error(`${field}.${value} is not a pi-ai thinking format (${THINKING_FORMATS.join(', ')})`)
      }
      validated.thinkingFormat = value as ThinkingFormat
    } else {
      throw new Error(`${field}.${key} is not a fillable compat switch (supportsReasoningEffort, thinkingFormat)`
        + '; llm-pi-ai fail-louds on unknown switches instead of ignoring them')
    }
  }
  return validated
}

/**
 * Validate one efforts declaration against llm-pi-ai's resolution rules:
 * level names from {@link THINKING_LEVELS}; `off` may be valueless (send
 * nothing) or carry a wire value; every other declared level needs a
 * non-empty wire value; at least one level beyond `off` must be offered.
 * @param raw - the configured declaration.
 * @param field - the config path naming this declaration in diagnostics.
 * @returns the validated declaration.
 * @throws Error naming the offending entry.
 */
export function validateEfforts(raw: unknown, field: string): EffortsDeclaration {
  if (raw === false) return false
  if (!isPlainObject(raw)) {
    throw new Error(`${field} must be false or a dict of level -> wire value`)
  }
  const entries = Object.entries(raw)
  if (entries.length === 0) {
    throw new Error(`${field} is empty; declare the offered levels, or set false for a non-reasoning model`)
  }
  for (const [level, wire] of entries) {
    if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new Error(`${field}.${level} is not a pi-ai thinking level (${THINKING_LEVELS.join(', ')})`)
    }
    if (wire === null || wire === undefined) {
      if (level !== 'off') {
        throw new Error(`${field}.${level} needs the wire value dispatch should send; only "off" may leave it empty`)
      }
    } else if (typeof wire !== 'string' || wire.length === 0) {
      throw new Error(`${field}.${level} must be a non-empty string or null`)
    }
  }
  if (!entries.some(([level]) => level !== 'off')) {
    throw new Error(`${field} offers no level beyond "off"; declare a thinking level, or set false`)
  }
  const declaration: Partial<Record<ThinkingLevel, string | null>> = {}
  for (const [level, wire] of entries) {
    // Validation above guarantees every value is null (off only) or a
    // non-empty string; the undefined case normalizes to null so a YAML
    // `off:` survives as "supported, send nothing".
    declaration[level as ThinkingLevel] = wire === undefined || wire === null
      ? null
      : wire as string
  }
  return declaration
}

/** The first rule matching one route/model, or none. */
function matchRule(rules: readonly EffortRule[], route: string, modelId: string): EffortRule | undefined {
  return rules.find(rule => rule.routes.includes(route)
    && rule.include.test(modelId)
    && !(rule.exclude?.test(modelId) ?? false))
}

/**
 * The rule's compat fields one model entry does not already declare.
 * Field-level gate 1: an explicit value of any kind is never overridden, so
 * an entry pinning `thinkingFormat` while omitting `supportsReasoningEffort`
 * receives only the latter. Entries without a `compat` object receive every
 * declared field.
 */
function missingCompatFields(
  entry: Readonly<Record<string, unknown>>,
  compat: CompatDeclaration | undefined,
): CompatDeclaration | undefined {
  if (compat === undefined) return undefined
  const existing = isPlainObject(entry.compat) ? entry.compat : {}
  const fill: { supportsReasoningEffort?: boolean; thinkingFormat?: ThinkingFormat } = {}
  if (compat.supportsReasoningEffort !== undefined
    && !('supportsReasoningEffort' in existing)) {
    fill.supportsReasoningEffort = compat.supportsReasoningEffort
  }
  if (compat.thinkingFormat !== undefined && !('thinkingFormat' in existing)) {
    fill.thinkingFormat = compat.thinkingFormat
  }
  return Object.keys(fill).length === 0 ? undefined : fill
}

/**
 * Collect fill candidates from the raw `llm-pi-ai` user layer: gates 1 and 2
 * only. Each candidate carries exactly what its model entry lacks — an
 * efforts declaration, compat switches, or both; entries that declare
 * everything a matching rule would add, non-object entries, and routes no
 * rule names are invisible here.
 *
 * The live-adapter gate (catalog inheritance) applies only to the efforts
 * piece and runs between {@link collectCandidates} and {@link buildFillOps},
 * since it reads the `llm` service.
 * @param userProviders - the user layer's `providers` dict, verbatim.
 * @param rules - validated rules, first match wins.
 * @returns candidates in route/model order.
 */
export function collectCandidates(
  userProviders: Readonly<Record<string, unknown>>,
  rules: readonly EffortRule[],
): FillCandidate[] {
  const candidates: FillCandidate[] = []
  if (rules.length === 0) return candidates
  for (const [route, profile] of Object.entries(userProviders)) {
    if (!isPlainObject(profile)) continue
    if (Array.isArray(profile.models)) {
      profile.models.forEach((entry, index) => {
        if (!isPlainObject(entry)) return
        if (typeof entry.id !== 'string' || entry.id.length === 0) return
        const rule = matchRule(rules, route, entry.id)
        if (rule === undefined) return
        const needsEfforts = !('reasoningEfforts' in entry)
        const compatFill = missingCompatFields(entry, rule.compat)
        if (!needsEfforts && compatFill === undefined) return
        candidates.push({
          route,
          modelId: entry.id,
          efforts: needsEfforts ? rule.efforts : undefined,
          compatFill,
          source: 'models',
          index,
        })
      })
    }
    if (isPlainObject(profile.modelOverrides)) {
      for (const [id, entry] of Object.entries(profile.modelOverrides)) {
        if (!isPlainObject(entry)) continue
        const rule = matchRule(rules, route, id)
        if (rule === undefined) continue
        const needsEfforts = !('reasoningEfforts' in entry)
        const compatFill = missingCompatFields(entry, rule.compat)
        if (!needsEfforts && compatFill === undefined) continue
        candidates.push({
          route,
          modelId: id,
          efforts: needsEfforts ? rule.efforts : undefined,
          compatFill,
          source: 'modelOverrides',
          index: -1,
        })
      }
    }
  }
  return candidates
}

/** Own a declaration's data before it crosses into a settings write. */
function detachEfforts(efforts: EffortsDeclaration): EffortsDeclaration {
  if (efforts === false) return false
  return { ...efforts }
}

/**
 * Turn surviving candidates into path-addressed user-layer writes.
 *
 * `models` is an array, and settings path ops treat arrays as opaque values,
 * so one route's fill is a single `set` of the whole next array; both pieces
 * (efforts declaration and merged compat dict) fold into that literal. The
 * write rides the namespace's serialized queue with the caller's read
 * revision, so a concurrent edit rejects instead of being silently clobbered.
 * `modelOverrides` is a dict, so those fills stay surgical per model — one op
 * per piece; compat is written as one whole-dict set (existing declared
 * fields preserved by construction) rather than per-field paths, which keeps
 * the ops independent of whether settings path ops create missing parents.
 * @param candidates - candidates that survived gate 3.
 * @param userProviders - the user layer's `providers` dict the candidates were read from.
 * @returns the ordered set ops for one `settings.mutate` call.
 */
export function buildFillOps(
  candidates: readonly FillCandidate[],
  userProviders: Readonly<Record<string, unknown>>,
): PathSetOp[] {
  const modelsByRoute = new Map<string, Map<number, FillCandidate>>()
  const overridesByRoute = new Map<string, Map<string, FillCandidate>>()
  for (const candidate of candidates) {
    if (candidate.efforts === undefined && candidate.compatFill === undefined) continue
    if (candidate.source === 'models') {
      let perRoute = modelsByRoute.get(candidate.route)
      if (perRoute === undefined) modelsByRoute.set(candidate.route, perRoute = new Map())
      perRoute.set(candidate.index, candidate)
    } else {
      let perRoute = overridesByRoute.get(candidate.route)
      if (perRoute === undefined) overridesByRoute.set(candidate.route, perRoute = new Map())
      perRoute.set(candidate.modelId, candidate)
    }
  }
  /** One models-array entry with its candidate's pieces folded in. */
  const withFill = (entry: Readonly<Record<string, unknown>>, candidate: FillCandidate):
    Record<string, unknown> => {
    const next: Record<string, unknown> = { ...entry }
    if (candidate.efforts !== undefined) next.reasoningEfforts = detachEfforts(candidate.efforts)
    if (candidate.compatFill !== undefined) {
      next.compat = { ...(isPlainObject(entry.compat) ? entry.compat : {}), ...candidate.compatFill }
    }
    return next
  }
  const ops: PathSetOp[] = []
  for (const [route, candidatesForRoute] of modelsByRoute) {
    const profile = userProviders[route]
    const models = isPlainObject(profile) && Array.isArray(profile.models)
      ? profile.models as unknown[]
      : []
    const nextModels = models.map((entry, index) => {
      const candidate = candidatesForRoute.get(index)
      return candidate !== undefined && isPlainObject(entry)
        ? withFill(entry, candidate)
        : entry
    })
    ops.push({ op: 'set', path: ['providers', route, 'models'], value: nextModels })
  }
  for (const [route, candidatesForRoute] of overridesByRoute) {
    for (const [modelId, candidate] of candidatesForRoute) {
      if (candidate.efforts !== undefined) {
        ops.push({
          op: 'set',
          path: ['providers', route, 'modelOverrides', modelId, 'reasoningEfforts'],
          value: detachEfforts(candidate.efforts),
        })
      }
      if (candidate.compatFill !== undefined) {
        const profile = userProviders[route]
        const entry = isPlainObject(profile) && isPlainObject(profile.modelOverrides)
          ? profile.modelOverrides[modelId]
          : undefined
        ops.push({
          op: 'set',
          path: ['providers', route, 'modelOverrides', modelId, 'compat'],
          value: {
            ...(isPlainObject(entry) && isPlainObject(entry.compat) ? entry.compat : {}),
            ...candidate.compatFill,
          },
        })
      }
    }
  }
  return ops
}
