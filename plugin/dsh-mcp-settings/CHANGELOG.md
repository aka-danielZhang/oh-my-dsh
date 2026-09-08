# Changelog

All notable changes to this project are documented in this file.

## [0.2.6] - 2026-09-07

### Fixed

- Replace the removed client-runtime entry with the current gateway, renderer, and settings packages on the 0.1.2-rc.1 baseline.
- Typecheck and test against pinned npm packages without a sibling source checkout. Browser registration tests execute the published module factories; MCP SDK mocks remain active inside the published host package.
- Bundle Zod and include generated shared chunks in the distribution, so desktop extraction needs no private dependency install. Declare desktop shipping metadata.

## [0.2.5] - 2026-08-21

### Fixed

- Kept source-checkout installs on the status-capable fork MCP client. The official `@deepseek-ai/dsh-mcp-client@0.1.1-rc.1` connects and registers tools but does not emit the fork-only `mcp-client/status` event, leaving every enabled row displayed as connecting forever.

### Verification

- Added a package-metadata regression test that requires the `@deepseek-ai/dsh-mcp-client` devDependency to remain aliased to `@crazx/dsh-mcp-client@0.1.1-rc.1.zw.1`.

## [0.2.4] - 2026-08-21

### Fixed

- Kept background connection polling and post-save refreshes from replacing the whole list with a loading state; only rows whose live inventory changed now update.
- Ignored stale status responses, registered every optimistic write with SettingsScope immediately so its generation fence can suppress intermediate Host publications, and reserved save notices for the latest write.
- Invalidated only the edited server's previous connection entry, preventing old connected/tool-count data from describing a pending configuration while preserving unaffected rows.

### Verification

- TypeScript project typecheck, production bundle, and 59 Vitest tests, including slow-poll/manual-refresh ordering and overlapping-write notice ownership.

## [0.2.3] - 2026-08-18

### Fixed

- Retried refused credential-dependent spawns once the credentials service becomes available. The profile loader starts rows concurrently, so the settings provider (an earlier row) could wake the manager's first resync before the credentials provider (a later row) mounted; every `authorizationCredentialRef` / `envCredentialRefs` server was then refused once and stayed `failed` for the whole process lifetime — exactly the web-search trio failing after every `dsh web` restart. The manager now re-syncs when the credentials service activates; a live fiber still carries over, so established connections are untouched, and profiles without a credentials provider keep the existing per-server error.

### Verification

- TypeScript project typecheck and 57 Vitest tests, including a new regression test that mounts the manager before the credentials service and asserts the refused rows reconnect after it activates.
- Cold-start reproduction against the real `settings-file` + `credentials-local` providers mounted concurrently like the profile loader: the three credential-dependent HTTP servers all reach `connected` with the fix, permanent `failed` without it.

## [0.2.2] - 2026-08-18

### Fixed

- Mirrored `RECONNECT_DEFAULTS` and `SERVER_NAME_PATTERN` locally instead of reading `McpClient.RECONNECT_DEFAULTS` / `McpClient.SERVER_NAME_PATTERN` at module load: neither is exported by any published `@deepseek-ai/dsh-mcp-client` build, so the manager threw during evaluation against a clean harness and took down every settings-composed MCP server with it. The spawned plugin's own Config schema stays the final gate at spawn.

### Compatibility

- Verified against DeepSeek Harness `0.1.0-rc.7` (`@deepseek-ai/dsh-root` and the in-box `@deepseek-ai/dsh-mcp-client`, both `0.1.0-rc.7`). Since the mirrored constants no longer touch `dsh-mcp-client` exports at import time, the manager loads on clean rc.7 harnesses that removed those exports. The harness must still emit the `mcp-client/status` event.

### Verification

- TypeScript project typecheck and 56 Vitest tests against a harness tree without the unpublished exports.

## [0.2.1] - 2026-08-18

### Changed

- Restyled the MCP server list to match the DSH settings-panel design language shared with the Models and Plugins sections: separate outlined row cards (radius 12, `border-l2`, hover highlight) instead of one filled container with hairline dividers.
- Server rows now lead with the 8px status dot beside the name, use outlined transport/tool tags matching the Models `rowTag`, and dim disabled rows.
- Aligned section typography and controls with the settings panel: 16/24 title, 14/22 intro, 32px search and form fields, caption-sized status text, and a danger hover on the delete action.
- The editor surface now uses the filled module card (`bg-module-platform`, radius 12) like the Models provider editor.

### Removed

- Dropped the per-row plug glyph and the unused `IconPlug` component and legacy `.table` styles.

### Verification

- TypeScript project typecheck.
- 56 Vitest tests.
- Production bundle and JavaScript smoke checks.
- Live verification of the server list and editor in DSH Web, and `git diff --check`.

## [0.2.0] - 2026-08-17

### Added

- Added `authorizationCredentialRef` for Streamable HTTP servers. The manager resolves the DSH credential reference into a Bearer `Authorization` header only when composing the MCP client.
- Added `envCredentialRefs` for stdio servers. Each child environment variable can now reference a DSH-managed credential without storing its value in `mcp.servers`.
- Added Form and JSON editor support, validation, and round-trip coverage for both credential-reference forms.
- Added `pnpm run dev:web` for package-local Host and Client bundle watching during DSH Web development.

### Changed

- Credential reference names now follow the DSH portable environment-variable contract: `[A-Za-z_][A-Za-z0-9_]*`.
- Credential updates restart only MCP servers that reference the changed value, allowing rotations to reach the next process or HTTP connection without editing settings.
- Independent server credentials resolve concurrently so a slow credential source does not block unrelated MCP servers.
- The transport selector now uses the shared DSH menu and icon controls.
- When `authorizationCredentialRef` is configured, its resolved Bearer header replaces every case variant of a literal `Authorization` header.

### Fixed

- Prevented pending credential resolution from spawning an untracked MCP client after manager disposal or HMR unload.
- Reported stdio environment and credential-reference map errors on their respective fields.
- Preserved credential references across Form and JSON editor transitions.

### Verification

- TypeScript project typecheck.
- 56 Vitest tests, including credential projection, rotation, validation, editor round trips, and delayed-resolution disposal.
- Production bundle and JavaScript smoke checks.
- Packed-distribution inspection and `git diff --check`.
