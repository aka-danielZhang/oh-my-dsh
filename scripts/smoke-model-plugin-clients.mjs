/**
 * Execute the shipped model editor bundles with the packaged Cordis runtime.
 * Only DOM and external services are fixtures: injection checks and plugin
 * lifecycle are real. This does not replace a full browser interaction test.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'

const [runtimeDir, pluginsDir] = process.argv.slice(2)
assert.ok(runtimeDir && pluginsDir, 'usage: smoke-model-plugin-clients.mjs <runtime dsh dir> <plugins dir>')
const require = createRequire(join(resolve(runtimeDir), 'package.json'))
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)

// A traced service must resolve the namespace with the consumer's context,
// just like the gateway. A plain { settings: ... } would miss subpath errors.
class Remote extends Service {
  constructor(ctx) { super(ctx, 'remote') }
  get settings() { return this.ctx['remote.settings'] }
}

function browserFixture() {
  const resources = new Set()
  const acquire = (name) => {
    const token = { name }
    resources.add(token)
    return () => resources.delete(token)
  }
  const eventTarget = () => {
    const listeners = new Set()
    return {
      addEventListener(_type, listener) { listeners.add(listener); resources.add(listener) },
      removeEventListener(_type, listener) { listeners.delete(listener); resources.delete(listener) },
    }
  }
  return {
    resources,
    acquire,
    globals: {
      window: eventTarget(),
      document: {
        ...eventTarget(),
        head: { appendChild(tag) { tag.remove = acquire('style') } },
        body: {},
        createElement() { return { dataset: {}, setAttribute() {} } },
        querySelector() { return null },
        querySelectorAll() { return [] },
      },
      MutationObserver: class {
        observe() { this.dispose = acquire('observer') }
        disconnect() { this.dispose?.() }
      },
    },
  }
}

for (const name of ['dsh-model-efforts-editor', 'dsh-model-image-input']) {
  const filename = join(resolve(pluginsDir), name, 'lib/client.js')
  const code = readFileSync(filename, 'utf8')
  // Negative controls prove both independent injection requirements are
  // enforced, instead of accidentally granting access from the root fiber.
  for (const omitted of [undefined, 'remote', 'remote.settings']) {
    const fixture = browserFixture()
    let plugin
    fixture.globals.window.__ModuleLoader__ = {
      load({ id, factory }) {
        assert.equal(id, name)
        plugin = factory((id) => { throw new Error(`unexpected client import: ${id}`) })
      },
    }
    runInNewContext(code, fixture.globals, { filename, timeout: 5000 })
    assert.equal(typeof plugin?.apply, 'function')
    if (omitted) plugin = { ...plugin, inject: plugin.inject.filter(key => key !== omitted) }

    const ctx = new Context()
    const provider = ctx.plugin({
      apply(ctx) {
        ctx.provide('locale', {
          register: () => fixture.acquire('dictionary'),
          bind: () => key => key,
        })
        ctx.provide('settingsScope', {
          bind({ namespace }) {
            assert.equal(namespace, 'llm-pi-ai')
            return {
              getSnapshot: () => ({ user: {}, revision: 'client-smoke' }),
              subscribe: () => fixture.acquire('settings subscription'),
            }
          },
        })
        new Remote(ctx)
        ctx.provide('remote.settings', {
          mutate() { assert.fail('plugin startup must not write settings') },
        })
      },
    })
    try {
      await provider.await()
      for (let boot = 1; boot <= 2; boot++) {
        const fiber = ctx.plugin(plugin)
        try {
          if (omitted) {
            await assert.rejects(fiber.await(), {
              message: `cannot get property "${omitted}" without inject`,
            })
          } else {
            await fiber.await()
            for (const name of ['dictionary', 'style', 'observer', 'settings subscription']) {
              assert.ok([...fixture.resources].some(item => item.name === name), `missing ${name}`)
            }
          }
        } finally {
          await fiber.dispose()
        }
        assert.equal(fixture.resources.size, 0, `${name}: leaked resources after boot ${boot}`)
      }
    } finally {
      await provider.dispose()
    }
    console.log(`smoke-model-plugin-clients: ${name} ${omitted ? `rejects missing ${omitted}` : 'boots and disposes twice'}`)
  }
}
