import type { ReactNode } from 'react'
import type { McpInventorySnapshot } from '../inventory-types.ts'
import type { McpServerEntry } from './drafts.ts'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpSettingsLocaleKey } from './locales.ts'
import { McpServersTab } from './McpServersTab.tsx'
import css from './McpSettingsSection.module.css'

/** Registration-side face used by the MCP section. */
export interface McpSettingsSectionInjected {
  /** Settings transport for the `mcp` namespace. */
  scope: SettingsScope<{ servers: McpServerEntry[] }>
  /** Read a current Host status snapshot. */
  listStatus: () => Promise<McpInventorySnapshot>
  /** Translate this section's copy. */
  t: TranslateSection
}

/** Section-local translate signature matching the framework `Translate`. */
export type TranslateSection = (key: McpSettingsLocaleKey, params?: Record<string, unknown>) => string

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpSettingsSectionInjected>

/** MCP settings section with live status merged into the server list. */
export function McpSettingsSection({ scope, listStatus, t }: McpSettingsSectionProps): ReactNode {
  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      <McpServersTab scope={scope} listStatus={listStatus} t={t} />
    </div>
  )
}
