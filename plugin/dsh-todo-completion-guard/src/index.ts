/**
 * Advisory turn-end todo guard: at `agent/turn-stopping` it inspects the
 * current turn's standing todo list and steers one notice when items remain
 * unfinished. Whether to finish, rewrite, or legitimately defer stays with the
 * model. Configuration-free; semantics live in the package README; rationale
 * lives in the todo-completion-guard Agent Note.
 * @module dsh-todo-completion-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'todo-completion-guard': { kind: 'todo-completion-guard' } & ContextFormed
  }
}

/**
 * Standing-plan row. Same fields as `@deepseek-ai/dsh-tool-todo`'s `TodoItem`.
 * Declared here so this overlay does not import the tool plugin's host face.
 */
interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'todo/write': { todos: TodoItem[] }
  }
}

export const name = 'todo-completion-guard'

/**
 * The current turn's standing plan: the latest `todo/write` after the turn's
 * own `turn/start` (matching the todo projection's clearing rule), or `null`
 * when the turn wrote no list. `wallBounded` records that some step of the
 * turn finished on `max-tokens` — the sticky turn outcome — where forcing
 * another step would most likely hit the same output ceiling again.
 * @param events - the agent's whole session log; only the current turn's tail is read.
 * @returns the standing list and the wall-bounded flag.
 */
function inspectTurn(events: readonly SessionEvent[]): { todos: TodoItem[] | null; wallBounded: boolean } {
  // findLastIndex is -1 only outside a live turn, which cannot reach this
  // guard; scanning from the log head then is the harmless fallback.
  const turnStart = events.findLastIndex(event => event.type === 'turn/start')
  const scope = events.slice(turnStart + 1)
  const todos = scope.findLast(event => event.type === 'todo/write')?.data.todos ?? null
  const wallBounded = scope.some(event => (
    event.type === 'assistant/message' || event.type === 'assistant/attempt'
  ) && event.data.stream.some(record => record.type === 'chunk'
    && record.chunk.type === 'finish' && record.chunk.reason.kind === 'max-tokens'))
  return { todos, wallBounded }
}

/**
 * Build the one-page reminder naming every unfinished item with its status.
 * @param open - standing items whose status is not `completed`, in list order.
 * @returns the frozen plugin-notice user message ready to steer.
 */
function reminder(open: readonly TodoItem[]): UserMessage {
  const lines = open.map(item => `- [${item.status}] ${item.content}`).join('\n')
  const text = `The todo list still has ${open.length} unfinished item(s) while this turn is about to end:\n`
    + `${lines}\n`
    + 'Before finishing the reply: complete the remaining item(s) and mark them completed with todo_write; '
    + 'or, if items are genuinely dropped or deferred, rewrite the list to reflect that and say why in one line. '
    + 'If the work legitimately continues in a later turn or you are blocked waiting for the user, '
    + 'state that explicitly in the reply and the list may stay as is.'
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'todo-completion-guard', form: 'notice', summary: `todos: ${open.length} unfinished` },
  })
}

/**
 * Install the guard's listener.
 * @param ctx - plugin context; the listener is scoped to it and disposed with it.
 */
export function apply(ctx: Context): void {
  // One nudge per agent per turn: a steered turn that still ends with the
  // same open list is allowed to end — the guard advises once, never loops.
  // Object lifetime bounds the weak entry without a disposal listener.
  const lastReminded = new WeakMap<Agent, number>()

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (lastReminded.get(agent) === turn) return
    const { todos, wallBounded } = inspectTurn(agent.session.snapshotEvents())
    // `pending` counts as unfinished too — a forgotten pending item is exactly
    // the residue this guard exists for. A wall-bounded turn is left alone.
    if (todos === null || wallBounded) return
    const open = todos.filter(item => item.status !== 'completed')
    if (open.length === 0) return
    lastReminded.set(agent, turn)
    agent.steer(reminder(open))
  })
}
