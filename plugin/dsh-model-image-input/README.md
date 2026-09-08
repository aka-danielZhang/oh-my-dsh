# dsh-model-image-input

A browser-only Web plugin that adds a compact, styled **image input** control
to every saved custom pi-ai model row inside the stock Models settings card:
**Settings → Models → provider → Customized settings → Models**. It does not
add another settings page and does not patch the harness.

The pi-ai adapter already honors `providers.<route>.models[].input` modality
declarations, and the API proxy rejects image attachments when `image` is not
declared. This plugin supplies the missing editing surface.

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-model-image-input
```

The bundle patch mounts the `dsh-model-image-input` client row for every Web
profile that installs the package. It requires the stock locale, the typed
`remote.settings` Remote (supplied by the api-gateway client), and the
ui-settings settings-scope peers provided by a normal `dsh web` profile
(0.1.2+ posture — writes go through `remote.settings.mutate`, not the removed
`connection.api` facade).

## Behavior

- Watches the stock Models editor and decorates every saved pi-ai custom-model
  row with a 26px image icon between the name field and the row disclosure.
- Clicking the icon opens a custom popup — no native `<select>`:
  **Provider default**, **Text only**, or **Text + images**, with a check mark
  on the stored state.
- The popup is 196px wide, aligns its right edge with the row button so it
  grows left inside the desktop settings panel, and flips above the button
  when the rendered height cannot fit below it.
- An image-capable row uses the product brand color; neutral rows use the
  stock tertiary label color.
- Writes one whole `providers.<route>.models` array op through
  `settings.mutate`, with the namespace revision fence. The adapter updates
  immediately; no restart and no extra Apply action are required.
- Only user-owned catalogs are writable. New unsaved rows and catalog-served
  preset routes stay read-only until the card is saved/reopened.

## Known DOM Contract

The stock `ui-settings-models` provider card exposes no slot inside its
hand-written Customized settings fold. This plugin therefore follows the
existing `dsh-provider-balance` DOM-injection posture. It identifies rows by
both of these stock anchors:

- `Model ID <n>` / `模型 ID <n>` input aria labels;
- the pi-ai-only `Fetch available models` / `获取可用模型` action, which
  excludes the DeepSeek catalog editor (its schema has no `input` field).

A harness UI copy or structure change may silence the injection; update the
anchors in `src/client/drafts.ts` when that happens. Failure is invisible and
non-destructive — no matching row means no injected control and no write.

The control writes immediately while the stock card owns a separate React
draft. If you change image input and then edit other fields in the already-open
card, reopen the card before pressing Apply so its draft includes the new
`input` declaration.

## Client Half

`lib/client.js` is the ModuleLoader closure artifact
(`window.__ModuleLoader__.load`) with platform modules externalized. The
client bundle carries no `@deepseek-ai/*` value imports; cross-package work
go through Cordis services and all Harness imports are type-only.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

Decision record: `docs/notes/2026-08-21-dsh-model-image-input.md`.
