import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { devDependencies?: Record<string, string> }

const SOURCE_SPEC = 'link:../deepseek-harness/packages/mcp/mcp-client'
const REGISTRY_SPEC = 'npm:@crazx/dsh-mcp-client@0.1.5-alpha.1.zw.1'

test('managed installs use the status-capable MCP client', () => {
  const spec = packageJson.devDependencies?.['@deepseek-ai/dsh-mcp-client']
  expect([SOURCE_SPEC, REGISTRY_SPEC]).toContain(spec)

  const clientPackage = require('@deepseek-ai/dsh-mcp-client/package.json') as {
    name: string
    version: string
  }
  expect(clientPackage).toMatchObject(spec === SOURCE_SPEC
    ? { name: '@deepseek-ai/dsh-mcp-client', version: '0.1.5-alpha.1' }
    : { name: '@crazx/dsh-mcp-client', version: '0.1.5-alpha.1.zw.1' })
  expect(readFileSync(require.resolve('@deepseek-ai/dsh-mcp-client'), 'utf8')).toContain(
    'mcp-client/status',
  )
})
