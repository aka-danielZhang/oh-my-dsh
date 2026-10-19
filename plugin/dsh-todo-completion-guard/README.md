# dsh-todo-completion-guard

English | [中文](README.zh.md)

An advisory turn-end guard: when an otherwise completed turn is about to close while its standing todo list still has unfinished items, it steers one plugin-notice into the same turn telling the model to finish and check off the items, rewrite the list around a deliberate drop, or state explicitly why the list stays open. It never vetoes a turn, never appears in the tool list, advises at most once per turn, and never loops.

## Installation

```sh
dsh plugin add <repo-root>/plugin/dsh-todo-completion-guard
```

No configuration. Every knob the guard could expose (reminder text, per-turn cap, exemptions) is a correctness property of the advisory contract, not a deployment choice.

## Behavior

- Fires on `agent/turn-stopping` — the boundary just before a completed turn closes.
- Reads the standing list: the latest `todo/write` after the current turn's own `turn/start` (a list from an earlier turn is already cleared by the todo projection's rule and is never nagged about).
- `pending` and `in_progress` both count as unfinished; a forgotten `pending` item is exactly the residue this guard exists for.
- Exempt: wall-bounded turns — if any step finished on `max-tokens`, forcing another step would most likely hit the same ceiling again, so the guard stays quiet.
- Once per agent per turn: a steered turn that still ends open is allowed to end. The decision — finish, rewrite, or defer with an explicit statement — stays with the model.
- The reminder is one `notice`-form context message sourced `dsh-todo-completion-guard`, model-visible, source-attributed, and reconstructable from the session log.
- Mounting without the todo tool (`todo_write`) in the composition is inert: no turn ever writes the event.
- Subagent lists are invisible by design — the guard reads each agent's own session log; a child's unfinished list never steers the parent.
