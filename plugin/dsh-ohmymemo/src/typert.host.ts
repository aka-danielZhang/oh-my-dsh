/** Strict Host descriptor contribution for the OhMyMemo UI Remote. */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'
import TYPERT_REMOTE from './typert.remote-client.ts'

export const TYPERT_HOST: TypertContribution = {
  package: 'dsh-ohmymemo',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: TYPERT_REMOTE.descriptors,
}

export default TYPERT_HOST
