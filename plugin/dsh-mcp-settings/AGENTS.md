# Repository guidance

This repository is one installable DSH bundle with three Cordis entries: `./manager`, `./inventory`, and the root dual-face Web UI plugin. Keep `cordis.patch.yml`, `package.json` exports, the Typert descriptors, and README installation commands synchronized.

Framework types and tests use pinned npm packages; no sibling Harness checkout is required. Browser registration tests execute published browser factories with explicit imports. Run `pnpm run typecheck`, `pnpm test`, and `pnpm run bundle` after behavior changes. The consumer-side `prepare` build must remain self-contained. Host Zod is bundled; keep all generated shared chunks in `files` and the desktop tarball.

Never commit MCP credentials, user settings, `lib/`, `node_modules/`, or coverage output.
