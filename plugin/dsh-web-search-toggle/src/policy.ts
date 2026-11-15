import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

/** Model-facing name registered by @deepseek-ai/dsh-tool-web. */
export const NATIVE_WEB_SEARCH_TOOL = 'web_search'

/** Prompt section registered alongside the native search tool. */
export const NATIVE_WEB_SEARCH_SECTION = 'tool:web_search'

/** Materialized when a stale or indirect call reaches execution while off. */
export const NATIVE_WEB_SEARCH_DISABLED_REASON = 'Web Search is disabled in General settings.'

/**
 * Minimal structural constraint for the system-prompt assembly waterfall. The
 * 0.2.2 presentation carries contexts and variables besides sections and
 * tools; the suppressor stays generic over the full face, so every
 * non-filtered member copies through untouched.
 */
export interface WebSearchAssembly {
  sections: Array<{ name: string }>
  /** Present on complete assemblies; the incomplete waterfall path omits it. */
  tools?: Array<{ name: string }>
}

/** Return the guard denial only for native search while the switch is off. */
export function nativeWebSearchDenial(toolName: string, enabled: boolean): string | undefined {
  return toolName === NATIVE_WEB_SEARCH_TOOL && !enabled
    ? NATIVE_WEB_SEARCH_DISABLED_REASON
    : undefined
}

/**
 * Remove the native search schema and its matching guidance from one final
 * assembly. Other web tools and foreign sections remain owned by their
 * contributors and keep their original object identities.
 */
export function suppressNativeWebSearch<T extends WebSearchAssembly>(assembly: T): T {
  const sections = assembly.sections.filter(section => section.name !== NATIVE_WEB_SEARCH_SECTION)
  const tools = assembly.tools?.filter(tool => tool.name !== NATIVE_WEB_SEARCH_TOOL)
  if (sections.length === assembly.sections.length
    && (tools === undefined || tools.length === assembly.tools?.length)) {
    return assembly
  }
  return { ...assembly, sections, ...(tools === undefined ? {} : { tools }) }
}

/**
 * Install one Host listener that shapes both global and Agent-scoped prompt
 * assemblies. The explicit global option is required by scope-filtered event
 * dispatch; a root-context listener without it does not see Agent assemblies.
 */
export function installNativeWebSearchAssemblyPolicy(
  ctx: Context,
  readEnabled: () => Promise<boolean>,
): () => void {
  return ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return await readEnabled() ? assembled : suppressNativeWebSearch(assembled)
  }, { global: true })
}
