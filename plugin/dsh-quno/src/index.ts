/**
 * dsh-quno host entry: the always-on Quno Host service, its Sense registry and
 * the restricted ingress facade.
 *
 * The profile row stays thin on purpose: state, scheduling, analysis,
 * delivery and task orchestration all live in `./service.ts`; the browser half
 * talks to this service through the `quno` Remote namespace.
 *
 * Boundary: no shell/bridge/IPC change and no harness-loop change. Every
 * registration is a Cordis effect and unwinds on unload (HMR included).
 *
 * @module dsh-quno
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import TYPERT_HOST from './typert.host.ts'
import { QunoHost, type QunoPluginConfig } from './service.ts'
import type { QunoSensesService } from './senses.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-quno'

/** The Host cannot operate without its durable and model seams. */
export const inject = [
  'agents',
  'sessions',
  'tools',
  'systemPrompt',
  'sessionPersistence',
  'sessionQuery',
  'jobs',
  'timer',
]

/** Row configuration. Zero-config defaults target the shipped desktop product. */
export const Config = z.object({
  /** Data directory; empty = `$DSH_HOME/quno`. */
  root: z.string().default(''),
  name: z.string().default('Quno'),
  timeZone: z.string().default('Asia/Shanghai'),
  checkIntervalSec: z.number().default(300),
  dryRun: z.boolean().default(false),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The process-wide Quno orchestrator. */
    quno: QunoHost
    /** Sense registration and lifecycle. */
    qunoSenses: QunoSensesService
    /** Generation-checked restricted ingestion entry. */
    qunoIngress: {
      ingest: (instanceId: string, generation: number, batch: unknown) => unknown
    }
  }
}

interface TypertRegister {
  register(contribution: typeof TYPERT_HOST): () => void | Promise<void>
}

/**
 * Host plugin body.
 * @param ctx - host root context.
 * @param config - normalized row configuration.
 */
export async function apply(ctx: Context, config: QunoPluginConfig = {}): Promise<void> {
  const logger = {
    info: (message: string): void => { ctx.logger.info(message) },
    warn: (message: string): void => { ctx.logger.warn(message) },
  }
  const root = config.root === undefined || config.root === '' ? undefined : config.root
  const host = new QunoHost(ctx, { ...config, ...(root === undefined ? {} : { root }) }, logger)

  // Provided before any await so the preset rows (which inject `quno`) and the
  // Sense plugins (which inject `qunoSenses`) can mount in the same boot.
  ctx.provide('quno', host)
  ctx.provide('qunoSenses', host.senses)
  ctx.provide('qunoIngress', {
    ingest: (instanceId: string, generation: number, batch: unknown) =>
      host.senses.ingest(instanceId, generation, batch),
  })

  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    host.observeSession(String(session.id), event)
  })

  let disposeTypert: (() => void | Promise<void>) | undefined
  try {
    const typert = ctx.get('typert') as TypertRegister | undefined
    if (typert === undefined) {
      logger.warn('dsh-quno: typert registry is not mounted; the settings page will not receive data')
    } else {
      disposeTypert = typert.register(TYPERT_HOST)
    }
    await host.start()
  } catch (error) {
    void disposeTypert?.()
    disposeSessionEvents()
    await host.stop().catch(() => {})
    throw error
  }

  ctx.effect(() => () => {
    disposeSessionEvents()
    void disposeTypert?.()
    void host.stop()
  }, 'dsh-quno: lifecycle')
}
