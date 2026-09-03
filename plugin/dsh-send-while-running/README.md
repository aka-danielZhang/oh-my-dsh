# dsh-send-while-running

Browser-only DSH web plugin, riding one additive
`conversation.input.right` list-seat entry declared by ui-conversation plus
a seam-anchored stylesheet. No harness source is modified.

**0.2.0 pivot — the button is now a Stop.** The 0.1.2-alpha composer
changed `primaryStops` to `running && subagent === null && (empty ||
blocked)`: while a running ordinary session has draft content, the stock
primary **stays Send** and the trailing row offers **no stop affordance at
all** (the only way to interrupt was to clear the draft first). This seat
fills that gap with a danger-red **Stop** beside the Send primary, wired to
the same session-scoped conversation `cancel()` the stock stop prop calls.
The 0.1.x behavior (an extra Send twin) is obsolete on this composer: the
stock primary already sends while running, so a twin only duplicated it.

Unchanged from 0.1.1: the **Stop recolor** — every stock stop-shaped button
in the composer trailing row is danger-red in every state (toned down per
theme), so the destructive action always reads apart from the blue Send.

## Behavior

- Visible exactly when `session.running && session.subagent === null
  && !session.removed` and the draft is non-blank or holds at least one
  image — precisely the state where the stock primary stays Send and no
  other Stop exists. When the draft empties, the stock primary flips back
  to Stop and this button stands down, so the two never duplicate.
- Clicking cancels the running turn through the stock path:
  `sessions.scope(sessionId).get('conversation').cancel()` — resolved by
  the registration's per-session `inject`, lazily at click time; failures
  are swallowed like the stock handler.
- Continuable child sessions are excluded (their independent Stop is stock
  and already rendered); idle sessions need no stop.
- The button never disables on machine-busy phases: the stock stop only
  disables on a missing stop verb, which this seat models by rendering
  nothing.
- Known edge (accepted): the seat cannot see the composer's routability
  block, so a running + blocked + non-empty-draft session would briefly
  show two Stops; a running turn implies the route was servable, so the
  overlap is transient at worst.
- Locale-aware label (`停止` / `Stop`) via the plugin's own
  `send-while-running` dictionary namespace.

## Stop recolor (0.1.1, retained)

The stock primary swaps its GLYPH when it flips Send→Stop (arrow =
`<path>`, stop = `<rect>`), so the stylesheet recolors
`button:has(> svg > rect)` inside the composer trailing row — pure CSS
that follows the stock state machine for free, in every state (running
with or without draft, subagent Stop), and never touches the blue Send.
One shade softer than the theme error-primary fill after visual review:
light theme red-500 (coral) base / red-400 hover; dark theme red-400 base
with a brightness-step hover (the static red scale has no shade between
400 and the near-white 100). The extra button renders inside the slot
wrapper (not as a direct button child of the trailing row), so it carries
the same red explicitly instead of relying on that rule.

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-send-while-running
```

The bundle patch mounts the `dsh-send-while-running` row for every profile
that installs this plugin. Terminal `dsh web`, plain browsers, and the
desktop shell all get the same composer (no desktop gate).

## Client half

`lib/client.js` is the ModuleLoader closure artifact
(`window.__ModuleLoader__.load`) with platform modules externalized — the
build contract lives in this package's `tsdown.config.ts`; keep
`CLIENT_EXTERNALS` in sync with the harness `PLATFORM_MODULES` baseline
when it moves. Zero `@deepseek-ai/*` value imports: the ui-conversation,
locale, and client-runtime packages appear only as type-only imports
(erased at build), so no runtime peer linkage is needed. The `sessions`
runtime service is consumed at click time through `ctx.get` behind a
structural type.

## Layout anchoring

The button styles itself as the stock primary's twin (34px circle,
mirrored rect glyph, −2px optical lift) in the recolor's red, and is
positioned through documented seams only: the render machinery's
`[data-slot="conversation.input.right"]` anchor plus
`div:has(...) > button:last-of-type` for the stock primary. The `:has()`
rule applies `order: 2` to the stock primary only while this button is
mounted ([model][meter][stop][send]); every other state keeps the shipped
layout untouched. No stock CSS-module class names are referenced
(module-hash renames cannot break it); known edges: the
`button:last-of-type` anchor assumes the stock primary stays the last
direct button child of the composer's trailing row, and the recolor's
`svg > rect` anchor assumes the stop glyph stays a rect while the send
glyph stays a path (ui-conversation structure changes need these selectors
re-checked). The visibility terms track the composer's `primaryStops`
formula — a baseline that changes it again needs this predicate re-checked.

## Config

None — visibility is fully derived from the slot's owner share; there is
nothing to configure.

## Design notes

- Decision records: `docs/notes/2026-08-22-dsh-send-while-running.md` and
  `docs/notes/2026-09-03-stop-while-running-rework.md` (repo root).
- Contracts live in the repo root `AGENTS.md` (plugin monorepo rules, npm
  dependency discipline, client bundle build contract).
