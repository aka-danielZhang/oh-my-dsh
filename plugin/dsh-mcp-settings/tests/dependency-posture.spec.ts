import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

const SOURCE_SPEC = 'link:../deepseek-harness/packages/mcp/mcp-client'
// The registry spec rides the manifest as a single source of truth: the
// candidate aliases track the fork release the manifest pins, so deriving
// the expectation from the manifest keeps the bump a one-file change.
const registrySpec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client'] ?? ''
const registryVersion = registrySpec.match(/^npm:@crazx\/dsh-mcp-client@(\S+)$/)?.[1]

test('managed installs use the status-capable MCP client', () => {
  const spec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client']
  expect([SOURCE_SPEC, registrySpec]).toContain(spec)
  expect(registrySpec === SOURCE_SPEC || registryVersion !== undefined).toBe(true)

  const clientPackage = require('@deepseek-ai/dsh-mcp-client/package.json') as {
    name: string
    version: string
  }
  expect(clientPackage).toMatchObject(spec === SOURCE_SPEC
    ? { name: '@deepseek-ai/dsh-mcp-client', version: '0.1.5-alpha.1' }
    : { name: '@crazx/dsh-mcp-client', version: registryVersion })
  expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
    'mcp-client/status',
  )
})
