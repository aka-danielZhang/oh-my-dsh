/**
 * Host-side strict Typert contribution for the usageStats namespace.
 *
 * The assembled desktop runtime resolves this plugin's @deepseek-ai deps to
 * its own packed copies, so the Gateway's SRC fallback cannot see the
 * @Remote markers this package's typert-protocol instance records (markers
 * live in a module-private WeakMap; string-keyed services and the
 * typertRemote binding stay cross-instance visible, which is why the row
 * would mount but the endpoints 404). Registering the same strict
 * descriptors the browser half mounts puts the endpoints on the registry's
 * local store directly — claims and dispatch both take the strict path, no
 * marker discovery involved (dsh-web-search-toggle's posture).
 *
 * @module dsh-usage-stats/typert.host
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
  package: 'dsh-usage-stats',
  face: 'host',
  schemas: [],
  model: EMPTY_MODEL,
  invocations: TYPERT_REMOTE.descriptors,
}

export default TYPERT_HOST
