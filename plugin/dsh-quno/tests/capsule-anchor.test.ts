import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CONVERSATION_SESSION_ATTR,
  RIGHT_PANEL_SESSION_SELECTOR,
  escapeSelector,
  findConversationContent,
  isCompactCapsule,
  isSessionContent,
  type AnchorCandidate,
} from '../src/client/capsule-anchor.ts'

/** A structural stand-in for the content container (no jsdom in this suite). */
function candidate(sessionId: string | null, insideRightPanel: boolean): AnchorCandidate {
  return {
    getAttribute: (name: string) => name === CONVERSATION_SESSION_ATTR ? sessionId : null,
    closest: (selector: string) => selector === RIGHT_PANEL_SESSION_SELECTOR && insideRightPanel ? {} : null,
  }
}

test('only the main-pane container of this session is a valid anchor', () => {
  assert.equal(isSessionContent(candidate('session-1', false), 'session-1'), true)
  // Another retained session must never receive the portal.
  assert.equal(isSessionContent(candidate('session-2', false), 'session-1'), false)
  // The same conversation embedded in the right panel must be rejected.
  assert.equal(isSessionContent(candidate('session-1', true), 'session-1'), false)
  assert.equal(isSessionContent(null, 'session-1'), false)
  // A container without the session stamp is not trusted.
  assert.equal(isSessionContent(candidate(null, false), 'session-1'), false)
})

test('the anchor lookup is inert without a DOM', () => {
  assert.equal(findConversationContent(null, 'session-1'), null)
})

test('session ids are escaped before they enter an attribute selector', () => {
  assert.equal(escapeSelector('session-1'), 'session-1')
  const escaped = escapeSelector('weird"id]')
  assert.equal(escaped.includes('"id]'), false)
})

test('the compact pill threshold is width based', () => {
  assert.equal(isCompactCapsule(0), false, 'not measured yet is not compact')
  assert.equal(isCompactCapsule(479), true)
  assert.equal(isCompactCapsule(480), false)
  assert.equal(isCompactCapsule(900), false)
})
