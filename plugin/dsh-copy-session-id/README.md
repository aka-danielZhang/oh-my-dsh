# dsh-copy-session-id

Browser-only DSH web plugin: the session-header ellipsis menu gains a
**Copy Session ID** item beside the stock **Download Session Log** entry.

No harness source is modified. The plugin takes over the shipped cell
`session-log-download` in the additive
`conversation.session.header.utilities` list seat (declared by
ui-conversation's conversation entry) — that seat's only occupant IS the
stock session-log-export ellipsis action, so extending the menu means
re-rendering it rather than growing a second button beside it.

## Behavior

- The header keeps exactly one ellipsis button, at the stock 28px size and
  dress. Opening it shows, in order:
  1. **复制会话 ID / Copy Session ID** — copies the current session id
     through `navigator.clipboard.writeText`, with a hidden-textarea
     `execCommand('copy')` fallback. The item confirms with a check glyph
     ("已复制" / "copied") for 1.6 s; hovering it shows the full id.
  2. **下载 Session 日志 / Download Session Log** — the stock action,
     unchanged, driven by the stock controller (see below). It greys out
     while a download is in flight.
- The stock download status dialog is re-rendered by this plugin (the
  takeover displaces the component that owned it), with the same phases —
  preparing / started / failed — and the same dismissal semantics, plus an
  automatic close 5 s after success.
- Locale-aware through the plugin's own `copy-session-id` dictionary
  namespace (zh + en).

## Takeover mechanism (why `priority: -1`)

A list cell is one `id`; the stock action registers `session-log-download`
at the default priority 0. Registering the same id at the SAME priority is
a hard error (`slot "…" already has an entry with id "…" — register at a
different priority to shadow it`), so this plugin registers the cell at
`priority: -1`. Priority sorts ascending and the LOWEST live entry renders,
so this entry wins the cell; the stock entry stays on the slot ledger and
resumes the instant this plugin's fiber is disposed. That makes the
takeover fully reversible: uninstalling the plugin restores the stock menu
verbatim.

## Stock controller, not a stock import

Download stays the stock session-log-export plugin's job. This plugin never
imports it: it consumes the `sessionLogDownload` cordis service face
(`store.getSnapshot` / `store.subscribe` / `download` / `dismiss`),
duck-checked in `src/client/download-state.ts`. A runtime whose controller
shape drifts, or that lacks the stock plugin entirely, degrades to a
copy-only menu instead of failing the header.

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-copy-session-id
```

The bundle patch mounts the `dsh-copy-session-id` row for every profile
that installs this plugin. Terminal `dsh web`, plain browsers, and the
desktop shell all get the same menu (no desktop gate). The package is also
`dsh.desktop.ship`, so it rides the desktop release as
`copy-session-id.tar.gz` → `~/.dsh-desktop/plugins/dsh-copy-session-id/`.

## Client half

`lib/client.js` is the ModuleLoader closure artifact
(`window.__ModuleLoader__.load`) with platform modules externalized — the
build contract lives in this package's `tsdown.config.ts`; keep
`CLIENT_EXTERNALS` in sync with the harness `PLATFORM_MODULES` baseline
when it moves. Zero `@deepseek-ai/*` value imports: locale, ui-conversation,
ui-renderer, and the timer plugin appear only as type-only imports (erased
at build), so no runtime peer linkage is needed (the bundle's only requires
are `react` and `react/jsx-runtime`).

The stylesheet is pre-claimed with `data-plugin`/`data-plugin-css` and
dedup-guarded: the client module system attributes every UNTAGGED `<style>`
to whichever plugin materializes next, and that plugin's next HMR reload
deletes the claimed sheet (the 2026-09-08 bridge incident).

## Config

None — the menu is fully derived from the session-scoped slot props and the
stock controller's state.

## Design notes

- Decision record: `docs/notes/2026-09-11-dsh-copy-session-id.md` (repo root).
- Contracts live in the repo root `AGENTS.md` (plugin monorepo rules, npm
  dependency discipline, client bundle build contract).
