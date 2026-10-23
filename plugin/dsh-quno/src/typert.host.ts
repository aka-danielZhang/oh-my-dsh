/**
 * Host-side strict Typert contribution for the `quno` namespace. Registers the
 * same descriptors the browser half mounts so `/api/quno/*` routes under the
 * assembled desktop runtime (no marker scanning involved).
 *
 * @module dsh-quno/typert.host
 */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import { TYPERT_REMOTE } from './typert.remote-client.ts'

/** Host contribution mirroring the client descriptors for gateway dispatch. */
export const TYPERT_HOST: TypertContribution = {
  package: 'dsh-quno',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: TYPERT_REMOTE.descriptors,
}

export default TYPERT_HOST
