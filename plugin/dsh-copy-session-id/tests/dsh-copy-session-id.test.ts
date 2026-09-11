import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'
import { copyText, legacyCopyText, type LegacyDocument } from '../src/client/copy-text.ts'
import { isSessionLogController } from '../src/client/download-state.ts'
import { en, zh } from '../src/client/locales.ts'
import { installSessionActionsCss, sessionActionsCss, type InstalledStyle, type StylesheetHost } from '../src/client/stylesheet.ts'

test('host half exports a loadable surface entry', () => {
  assert.equal(typeof apply, 'function')
})

test('client half exports a loadable plugin', () => {
  assert.equal(typeof clientApply, 'function')
  assert.ok(Array.isArray(inject) && inject.includes('slots') && inject.includes('locale') && inject.includes('timer'))
})

test('dictionaries cover the same keys in both locales', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
})

/** A fake document that records the textarea lifecycle for the legacy carrier. */
function fakeLegacyDocument(result: boolean | Error): { doc: LegacyDocument; state: { appended: string[]; removed: number; commands: string[] } } {
  const state = { appended: [] as string[], removed: 0, commands: [] as string[] }
  const doc: LegacyDocument = {
    createElement: () => ({
      value: '',
      style: { position: '', left: '' },
      setAttribute: () => {},
      select: () => {},
    }),
    body: {
      appendChild: (node) => {
        state.appended.push(node.value)
        return node
      },
      removeChild: () => {
        state.removed += 1
        return undefined
      },
    },
    execCommand: (commandId) => {
      state.commands.push(commandId)
      if (result instanceof Error) throw result
      return result
    },
  }
  return { doc, state }
}

test('copyText prefers the async clipboard carrier', async () => {
  const written: string[] = []
  await copyText('ses_42', { clipboard: { writeText: async (text) => { written.push(text) } } })
  assert.deepEqual(written, ['ses_42'])
})

test('copyText falls back to the legacy carrier when the async one rejects', async () => {
  const { doc, state } = fakeLegacyDocument(true)
  await copyText('ses_43', { clipboard: { writeText: async () => { throw new Error('denied') } }, document: doc })
  assert.deepEqual(state.appended, ['ses_43'])
  assert.deepEqual(state.commands, ['copy'])
  assert.equal(state.removed, 1)
})

test('copyText rejects when both carriers are unavailable or failing', async () => {
  await assert.rejects(copyText('ses_44', {}))
  await assert.rejects(copyText('ses_44', { clipboard: { writeText: async () => { throw new Error('denied') } } }))
  const failing = fakeLegacyDocument(false)
  assert.equal(legacyCopyText('ses_44', failing.doc), false)
  assert.equal(failing.state.removed, 1)
})

test('isSessionLogController accepts the stock face and rejects drift or absence', () => {
  const store = { getSnapshot: () => ({ bySession: {} }), subscribe: () => () => {} }
  assert.equal(isSessionLogController({ store, download: () => Promise.resolve(), dismiss: () => {} }), true)
  assert.equal(isSessionLogController(undefined), false)
  assert.equal(isSessionLogController({}), false)
  assert.equal(isSessionLogController({ store, download: () => Promise.resolve() }), false)
  assert.equal(isSessionLogController({ store: { getSnapshot: () => ({ bySession: {} }) }, download: () => Promise.resolve(), dismiss: () => {} }), false)
})

/** A fake document head recording inserted style elements. */
function fakeStylesheetHost(): { host: StylesheetHost; children: InstalledStyle[] } {
  const children: InstalledStyle[] = []
  const host: StylesheetHost = {
    querySelector: (selectors) => {
      const match = /data-plugin-css="([^"]+)"/.exec(selectors)
      if (match === null) return null
      return children.find(child => child.dataset.pluginCss === match[1]) ?? null
    },
    createElement: () => {
      const style: InstalledStyle & { removed: boolean } = {
        dataset: {},
        removed: false,
        setAttribute: () => {},
        textContent: null,
        remove: () => { style.removed = true },
      }
      return style
    },
    head: {
      append: (...nodes) => { children.push(...(nodes as InstalledStyle[])) },
    },
  }
  return { host, children }
}

test('the stylesheet installs once per document and its disposer removes it', () => {
  const { host, children } = fakeStylesheetHost()
  const dispose = installSessionActionsCss(host)
  assert.equal(children.length, 1)
  assert.equal(children[0]?.dataset.plugin, 'dsh-copy-session-id')
  assert.equal(children[0]?.dataset.pluginCss, 'dsh-copy-session-id/session-actions')
  assert.equal(children[0]?.textContent, sessionActionsCss())
  // A second install (HMR remount) is a no-op while the sheet is present.
  const disposeAgain = installSessionActionsCss(host)
  assert.equal(children.length, 1)
  disposeAgain()
  assert.equal(children.length, 1)
  dispose()
  assert.equal((children[0] as InstalledStyle & { removed: boolean }).removed, true)
})

test('the stylesheet styles only semantic tokens and its own class namespace', () => {
  const css = sessionActionsCss()
  assert.ok(css.includes('var(--dsw-alias-bg-overlay)'))
  assert.ok(css.includes('var(--dsw-alias-label-primary)'))
  assert.ok(css.includes('.dsh-csid-anchor'))
  // Every declaration block belongs to this plugin's namespace: no bare
  // element or stock-CSS-module selector leaks into the page.
  const selectors = css.split('\n').filter(line => line.trim().endsWith('{')).map(line => line.trim())
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    assert.ok(selector.startsWith('.dsh-csid-'), `unexpected selector: ${selector}`)
  }
})
