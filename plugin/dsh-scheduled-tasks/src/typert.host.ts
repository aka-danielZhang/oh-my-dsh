/**
 * Host-side strict Typert contribution for the `scheduledTasks` namespace.
 *
 * The assembled desktop runtime resolves this plugin's @deepseek-ai deps to
 * its own packed copies, so the service's protocol-package instance differs
 * from the registry's — @Remote markers live in a module-private WeakMap and
 * would never be discovered (the "row mounts but endpoints 404" failure the
 * repo's typert.host.ts files exist to prevent). Registering the same strict
 * descriptors the browser half mounts puts the endpoints on the registry's
 * local store directly; claims and dispatch both take the strict path.
 * @module dsh-scheduled-tasks/typert.host
 */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { TYPERT_REMOTE } from './typert.remote-client.ts'

const EMPTY_MODEL = {
  services: [],
  events: [],
  objects: [],
} as const

/** Host contribution mirroring the client descriptors for gateway dispatch. */
export const TYPERT_HOST: TypertContribution = {
  package: 'dsh-scheduled-tasks',
  face: 'host',
  schemas: [],
  model: EMPTY_MODEL,
  invocations: TYPERT_REMOTE.descriptors,
}

export default TYPERT_HOST
