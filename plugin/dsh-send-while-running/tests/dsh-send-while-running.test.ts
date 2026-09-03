import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'
import { stopButtonVisible } from '../src/client/facts.ts'
import type { InputFacts, SessionFacts } from '../src/client/facts.ts'
import { StopWhileRunningButton } from '../src/client/send-button.tsx'
import { installStopWhileRunningCss, stopWhileRunningCss } from '../src/client/stylesheet.ts'

test('host half exports a loadable surface entry', () => {
  assert.equal(typeof apply, 'function')
})

test('client half exports a loadable plugin', () => {
  assert.equal(typeof clientApply, 'function')
  assert.ok(Array.isArray(inject) && inject.includes('slots'))
  assert.ok(inject.includes('sessions'), 'interrupt path resolves through the sessions runtime')
})

const idleSession: SessionFacts = { running: false, subagent: null, removed: false }
const runningSession: SessionFacts = { running: true, subagent: null, removed: false }
const continuableSession: SessionFacts = { running: true, subagent: { address: { mode: 'continuable' } }, removed: false }
const removedSession: SessionFacts = { running: true, subagent: null, removed: true }
const emptyInput: InputFacts = { draft: '', imageIds: [] }
const textInput: InputFacts = { draft: 'follow-up', imageIds: [] }
const whitespaceInput: InputFacts = { draft: '   \n\t ', imageIds: [] }
const imageOnlyInput: InputFacts = { draft: '', imageIds: ['img-1'] }

test('button is invisible while the session is not running (stock primary is the Stop)', () => {
  assert.equal(stopButtonVisible(idleSession, textInput), false)
})

test('button is invisible without draft content (stock primary is the Stop)', () => {
  assert.equal(stopButtonVisible(runningSession, emptyInput), false)
  assert.equal(stopButtonVisible(runningSession, whitespaceInput), false)
})

test('button is visible for a running ordinary session with text or images (stock primary stays Send)', () => {
  assert.equal(stopButtonVisible(runningSession, textInput), true)
  assert.equal(stopButtonVisible(runningSession, imageOnlyInput), true)
})

test('button stays off continuable child sessions (their independent Stop is stock)', () => {
  assert.equal(stopButtonVisible(continuableSession, textInput), false)
})

test('button is invisible on removed sessions', () => {
  assert.equal(stopButtonVisible(removedSession, textInput), false)
})

test('component renders null when shares are absent', () => {
  assert.equal(StopWhileRunningButton({}), null)
})

test('component renders null when the visibility terms fail', () => {
  assert.equal(StopWhileRunningButton({
    session: idleSession,
    input: textInput,
    interrupt: () => { /* unreachable in this render test */ },
  }), null)
})

test('component renders the stop affordance with the injected interrupt verb', () => {
  const element = StopWhileRunningButton({
    session: runningSession,
    input: textInput,
    interrupt: () => { /* the cancel path is exercised in the browser */ },
  })
  assert.notEqual(element, null)
})

test('stylesheet targets only documented seams and stays scoped', () => {
  const css = stopWhileRunningCss()
  assert.match(css, /\.dsh-stop-while-running \{/)
  assert.match(css, /\[data-slot="conversation\.input\.right"\]/)
  assert.match(css, /button:last-of-type/)
  // The extra button carries its own red (it is not a direct button child
  // of the trailing row, so the global recolor cannot reach it).
  assert.match(css, /\.dsh-stop-while-running \{[^}]*background: var\(--dsw-static-red-500\)/)
  // No stock CSS-module class names: anchors are the data-slot seam and
  // element structure only, so a module-hash rename cannot break it.
  assert.doesNotMatch(css, /\._/)
})

test('stock stop recolor stays red in every state, anchored on the stop glyph', () => {
  const css = stopWhileRunningCss()
  // The recolor keys on the stop GLYPH (rect; the send glyph is a path), so
  // it follows the stock machine and never needs a JS state mirror.
  assert.match(css, /button:has\(> svg > rect\)/)
  // Light theme: red-500 base, red-400 hover (stock steps one shade lighter).
  assert.match(css, /rect\) \{\s*\n\s*background: var\(--dsw-static-red-500\)/)
  // Dark theme override exists and softens to red-400 on dark surfaces.
  assert.match(css, /body\[data-ds-dark-theme\][^\{]*rect\) \{\s*\n\s*background: var\(--dsw-static-red-400\)/)
})

test('stock stop recolor rule is not gated on the extra button being mounted', () => {
  const css = stopWhileRunningCss()
  // The always-red rule must NOT embed the plugin's own class in its
  // selector (that would limit the red to states where the extra button is
  // visible); only the glyph anchor and the slot seam scope it.
  for (const line of css.split('\n')) {
    if (line.includes('> svg > rect')) {
      assert.equal(line.includes('.dsh-stop-while-running'), false, line)
    }
  }
})

test('order override is scoped to the extra button being mounted', () => {
  const css = stopWhileRunningCss()
  // The stock primary only moves (order: 2) while the extra Stop exists;
  // every other state keeps the shipped layout untouched.
  assert.match(
    css,
    /div:has\(> \[data-slot="conversation\.input\.right"\] \.dsh-stop-while-running\) > button:last-of-type \{\s*\n\s*order: 2;/,
  )
})

test('stylesheet installer appends and removes the style element', () => {
  class StubStyle {
    textContent: string | null = null
    readonly attributes: Record<string, string> = {}
    removed = false
    setAttribute(name: string, value: string): void { this.attributes[name] = value }
    remove(): void { this.removed = true }
  }
  const appended: StubStyle[] = []
  const doc = {
    createElement(tagName: string): StubStyle {
      assert.equal(tagName, 'style')
      return new StubStyle()
    },
    head: { append(...nodes: unknown[]): void { appended.push(...(nodes as StubStyle[])) } },
  }
  const dispose = installStopWhileRunningCss(doc)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].attributes['data-dsh-stop-while-running'], '')
  assert.equal(appended[0].textContent, stopWhileRunningCss())
  assert.equal(appended[0].removed, false)
  dispose()
  assert.equal(appended[0].removed, true)
})
