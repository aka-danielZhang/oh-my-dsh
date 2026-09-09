/**
 * Branding plugin, browser half. Always mounted — no desktop gate: the
 * wordmark and the document-title rebranding apply to every surface this
 * profile serves (terminal `dsh web`, a plain browser, the desktop shell)
 * through one code path. Effects are reversible and collected by the
 * plugin fiber.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-sidebar's SlotMap declarations ('sidebar.brand.name')
// for the wordmark registration below — no runtime edge to ui-sidebar.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BrandWordmark } from './wordmark.tsx'
import { installTitleRebrand } from './title.ts'

/** The build title ui-renderer projects when no DSH_CLIENT_TITLE override. */
export const BUILD_TITLE = 'DSH Local Build'

/** This deployment's product name. */
export const PRODUCT_TITLE = 'Oh My DSH'

/** Required services: the slot registry. */
export const inject = ['slots']

/**
 * Client plugin body: occupy the brand-name seat and rebrand the title.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Occupy ui-sidebar's `sidebar.brand.name` single seat, replacing the
  // generic "DSH Local Build" fallback (and its build-hash pill); the whale
  // mark stays on the shell's fallback. Declaration-aware inject waits for
  // ui-sidebar's declaration whatever the activation order, reruns after
  // redeclaration, and leaves with this fiber.
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name' }, BrandWordmark),
  )
  ctx.effect(() => installTitleRebrand(document, BUILD_TITLE, PRODUCT_TITLE), 'dsh-branding: document title')
}
