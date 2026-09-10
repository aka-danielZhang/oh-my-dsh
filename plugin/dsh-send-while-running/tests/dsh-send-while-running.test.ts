import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/index.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'
import { stopButtonVisible } from '../src/client/facts.ts'
import type { InputFacts, SessionFacts } from '../src/client/facts.ts'
import { StopWhileRunningButton } from '../src/client/send-button.tsx'
import type { StopWhileRunningProps } from '../src/client/send-button.tsx'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installStopWhileRunningCss, stopWhileRunningCss } from '../src/client/stylesheet.ts'

test('host half exports a loadable surface entry', () => {
  assert.equal(typeof apply, 'function')
})

test('client half exports a loadable plugin', () => {
  assert.equal(typeof clientApply, 'function')
  assert.ok(Array.isArray(inject) && inject.includes('slots'))
  // sessions is consumed lazily at click time through ctx.get, not declared
  // as a mount-order hard dependency.
  assert.equal(inject.includes('sessions'), false)
})

const idleSession: SessionFacts = { running: false, subagent: null, removed: false }
const runningSession: SessionFacts = { running: true, subagent: null, removed: false }
const continuableSession: SessionFacts = { running: true, subagent: { address: { mode: 'continuable' } }, removed: false }
const removedSession: SessionFacts = { running: true, subagent: null, removed: true }
const emptyInput: InputFacts = { draft: '', attachmentIds: [] }
const textInput: InputFacts = { draft: 'follow-up', attachmentIds: [] }
const whitespaceInput: InputFacts = { draft: '   \n\t ', attachmentIds: [] }
const attachmentOnlyInput: InputFacts = { draft: '', attachmentIds: ['att-1'] }

test('button is invisible while the session is not running (stock primary is the Stop)', () => {
  assert.equal(stopButtonVisible(idleSession, textInput), false)
})

test('button is invisible without draft content (stock primary is the Stop)', () => {
  assert.equal(stopButtonVisible(runningSession, emptyInput), false)
  assert.equal(stopButtonVisible(runningSession, whitespaceInput), false)
})

test('button is visible for a running ordinary session with text or attachments (stock primary stays Send)', () => {
  assert.equal(stopButtonVisible(runningSession, textInput), true)
  assert.equal(stopButtonVisible(runningSession, attachmentOnlyInput), true)
})

test('button stays off continuable child sessions (their independent Stop is stock)', () => {
  assert.equal(stopButtonVisible(continuableSession, textInput), false)
})

test('button is invisible on removed sessions', () => {
  assert.equal(stopButtonVisible(removedSession, textInput), false)
})

/** Hook stubs matching the framework seats the slot serves the component. */
function snapshotOf(facts: SessionFacts): SessionSnapshot {
  return {
    sessionId: 's1' as SessionSnapshot['sessionId'],
    queue: [],
    pendingSubmissions: [],
    openState: 'open',
    openError: null,
    hasMore: false,
    loadingOlder: false,
    promptError: null,
    blank: false,
    lastAgentError: null,
    promptAttempted: true,
    awaitingFirstTurn: false,
    running: facts.running,
    removed: facts.removed,
    subagent: facts.subagent as SessionSnapshot['subagent'],
  }
}

function inputOf(facts: InputFacts): InputState {
  return {
    draft: facts.draft,
    attachmentIds: facts.attachmentIds as InputState['attachmentIds'],
    draftRev: 0,
    phase: 'plain',
    occurrences: [],
    queue: [],
  }
}

function mountProps(session: SessionFacts, input: InputFacts): StopWhileRunningProps {
  const snapshot = snapshotOf(session)
  const state = inputOf(input)
  // Seats this component never reads get trivial stubs; the two it does
  // (useSession, useInput) serve the real snapshot/state objects.
  const unused = (() => undefined) as never
  return {
    sessionId: snapshot.sessionId,
    useSession: selector => selector(snapshot),
    useInput: selector => selector(state),
    useProjection: unused as StopWhileRunningProps['useProjection'],
    useConversation: unused as StopWhileRunningProps['useConversation'],
    inputActions: {} as StopWhileRunningProps['inputActions'],
    useSessions: unused as StopWhileRunningProps['useSessions'],
    useSessionPendingInteraction: unused as StopWhileRunningProps['useSessionPendingInteraction'],
    useWorkspaces: unused as StopWhileRunningProps['useWorkspaces'],
    interrupt: () => { /* the cancel path is exercised in the browser */ },
    t: (key => `t:${key}`) as StopWhileRunningProps['t'],
  }
}

test('component renders null when the visibility terms fail', () => {
  assert.equal(StopWhileRunningButton(mountProps(idleSession, textInput)), null)
  assert.equal(StopWhileRunningButton(mountProps(runningSession, emptyInput)), null)
})

test('component renders the stop affordance for the running ordinary draft state', () => {
  const element = StopWhileRunningButton(mountProps(runningSession, textInput))
  assert.notEqual(element, null)
  const button = element as { props: { 'aria-label'?: string } }
  assert.equal(button.props['aria-label'], 't:stop.label')
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
  // The base recolor selector contains only the stock glyph anchor and slot
  // scope, so it remains active when the fallback entry is absent.
  assert.match(
    css,
    /div:has\(> \[data-slot="conversation\.input\.right"\]\) > button:has\(> svg > rect\) \{/,
  )
})

test('a direct stock Stop hides the nested fallback Stop', () => {
  const css = stopWhileRunningCss()
  assert.match(
    css,
    /div:has\(> \[data-slot="conversation\.input\.right"\]\):has\(> button:has\(> svg > rect\)\) \[data-slot="conversation\.input\.right"\] \.dsh-stop-while-running \{\s*\n\s*display: none;/,
  )
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

test('stylesheet installer appends a claimed style element and removes it', () => {
  class StubStyle {
    textContent: string | null = null
    readonly attributes: Record<string, string> = {}
    readonly dataset: Record<string, string> = {}
    removed = false
    setAttribute(name: string, value: string): void { this.attributes[name] = value }
    remove(): void { this.removed = true }
  }
  const appended: StubStyle[] = []
  const doc = {
    querySelector: () => null,
    createElement(tagName: string): StubStyle {
      assert.equal(tagName, 'style')
      return new StubStyle()
    },
    head: { append(...nodes: unknown[]): void { appended.push(...(nodes as StubStyle[])) } },
  }
  const dispose = installStopWhileRunningCss(doc)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].attributes['data-dsh-stop-while-running'], '')
  assert.equal(appended[0].dataset.plugin, 'dsh-send-while-running')
  assert.equal(appended[0].dataset.pluginCss, 'dsh-send-while-running/stop-while-running')
  assert.equal(appended[0].textContent, stopWhileRunningCss())
  assert.equal(appended[0].removed, false)
  dispose()
  assert.equal(appended[0].removed, true)
})

test('stylesheet installer dedups against a live tag (no-op disposer)', () => {
  const appended: unknown[] = []
  const dispose = installStopWhileRunningCss({
    querySelector: () => ({ dataset: { pluginCss: 'dsh-send-while-running/stop-while-running' } }),
    createElement: () => { throw new Error('must not create a second style element') },
    head: { append(...nodes: unknown[]): void { appended.push(...nodes) } },
  })
  assert.equal(appended.length, 0)
  dispose()
})
