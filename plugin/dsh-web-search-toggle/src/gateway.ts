/**
 * Host gateway serving the web_search toggle over the Typert Remote seam.
 *
 * `get` projects the toggle state plus whether the DeepSeek search credential
 * resolves; `set` rewrites the managed block in the home patch file. The same
 * service enforces that state across Agent Preset scopes by filtering the final
 * prompt assembly and guarding stale or indirect executions. The harness keeps
 * ownership of every actual tool and provider row.
 *
 * @module dsh-web-search-toggle/gateway
 */

import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { toggleStateFromText, withToggleEntry } from './patch-file.ts'
import {
  NATIVE_WEB_SEARCH_TOOL,
  installNativeWebSearchAssemblyPolicy,
  nativeWebSearchDenial,
} from './policy.ts'
import type { WebSearchToggleSnapshot } from './toggle-types.ts'

/** Default credential reference web-search-deepseek resolves. */
const DEFAULT_KEY_REF = 'DEEPSEEK_API_KEY'

/** The settings namespace carrying the search provider's section. */
const WEB_SEARCH_NS = 'web-search-deepseek' as SettingsNamespace

/**
 * Resolve the home patch file path exactly like the harness's `homePatchPath`:
 * `$DSH_HOME/cordis.patch.yml`, defaulting to `~/.dsh`.
 * @param env - environment to read; injectable for tests.
 * @returns the absolute path of the home patch layer.
 */
export function homePatchPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.DSH_HOME !== undefined && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(root, 'cordis.patch.yml')
}

/** Read the patch file's text, mapping absence to undefined. */
async function readPatchText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Synchronous twin used only on an attempted web_search execution. */
function readPatchTextSync(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

/** Remote gateway plus the host-wide native web_search policy. */
export class WebSearchToggleGateway extends TypertRemoteService {
  static inject = ['settings', 'credentials', 'systemPrompt', 'tools']

  constructor(ctx: Context) {
    super(ctx, 'webSearchToggle')

    // Agent presets own their model-facing tool rows. Filtering the final
    // structured assembly reaches every preset scope without rewriting shipped
    // compositions or enumerating existing and future Agents.
    installNativeWebSearchAssemblyPolicy(ctx, async () => {
      return toggleStateFromText(await readPatchText(homePatchPath()))
    })

    // A stale request, replay, or Code Mode sub-dispatch can bypass the visible
    // schema. Deny it before provider selection while the same switch is off.
    ctx.tools.guard(execution => {
      if (execution.name !== NATIVE_WEB_SEARCH_TOOL) return undefined
      const enabled = toggleStateFromText(readPatchTextSync(homePatchPath()))
      return nativeWebSearchDenial(execution.name, enabled)
    })
  }

  /**
   * Project the toggle and credential state.
   * @returns one snapshot for the settings row.
   */
  @Remote('get')
  async get(): Promise<WebSearchToggleSnapshot> {
    const text = await readPatchText(homePatchPath())
    return {
      enabled: toggleStateFromText(text),
      ...(await this.keyState()),
    }
  }

  /**
   * Flip the toggle by rewriting the managed block; the file's live watcher
   * re-composes the composition, so the change applies without a restart.
   * @param params - the requested state.
   * @returns the snapshot after the write.
   */
  @Remote('set')
  async set(params: { enabled: boolean }): Promise<WebSearchToggleSnapshot> {
    const path = homePatchPath()
    const text = await readPatchText(path)
    const next = withToggleEntry(text, params.enabled)
    if (next !== text) await writeFile(path, next, 'utf8')
    return {
      enabled: toggleStateFromText(next),
      ...(await this.keyState()),
    }
  }

  /** Resolve the search credential the provider would use, mirroring its order. */
  private async keyState(): Promise<Pick<WebSearchToggleSnapshot, 'keyConfigured' | 'keyRef'>> {
    // Settings sections are live config entries now: the shared describe
    // projection is the read path for another plugin's namespace.
    const section = this.ctx.settings.describe()
      .find(descriptor => descriptor.ns === WEB_SEARCH_NS)?.value as
      | { apiKey?: unknown; apiKeyEnv?: unknown }
      | undefined
    const literal = typeof section?.apiKey === 'string' && section.apiKey.length > 0
      ? section.apiKey
      : undefined
    const ref = typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0
      ? section.apiKeyEnv
      : DEFAULT_KEY_REF
    if (literal !== undefined) return { keyConfigured: true, keyRef: ref }
    try {
      const hit = await this.ctx.credentials.resolve(credentialRef(ref))
      return { keyConfigured: (hit?.value?.length ?? 0) > 0, keyRef: ref }
    } catch {
      // A refusal answers nothing; the row shows "not configured" and the
      // toggle keeps working — the credential hint is advisory, not a gate.
      return { keyConfigured: false, keyRef: ref }
    }
  }
}

export default WebSearchToggleGateway
