# Model Plugin Remote Injection Regression

Desktop rc.37 shipped both model editors at 0.1.2 with
`inject = ['locale', 'settingsScope', 'remote.settings']`, but their `apply`
reads `ctx.remote.settings`. Cordis checks `remote` before accessing the
independently traced `remote.settings` namespace. Both fibers therefore throw
`cannot get property "remote" without inject`; Loader aggregates the failures
as `loader fibers failed` and the browser never finishes booting.

The installed client bundles were byte-identical to the app's plugin tarballs.
The published rc.37 source has the same omission. This is not an upgrade cache
issue; fresh installations fail too. Adding `remote` in an isolated test of
both installed bundles against the installed Cordis restores activation.

Both plugins now declare the root and namespace services, ship at 0.1.3, and
Desktop ships at rc.38. The typed settings mutation path and revision fence
are unchanged. No fork runtime or npm release is needed.

`smoke-model-plugin-clients.mjs` is called from the existing packaged-profile
smoke, including release preparation on macOS and Windows. It evaluates the
extracted client bundles with the assembled runtime's Cordis, a minimal DOM,
and external service fixtures in a separate provider fiber. It verifies two
mount/dispose cycles, resource cleanup, and zero startup writes. Removing
either `remote` or `remote.settings` in memory must reproduce the access error.
Providing services on the root would accidentally grant inherited access and
invalidate this regression test. Full browser interaction remains a separate
release check; the fixture deliberately does not simulate model editing UI.

The user explicitly requested removing the rc.33, rc.34, and rc.37 GitHub
Releases after the replacement is published. This is an exception to the
normal historical-asset retention rule: keep Git tags, remove only those
three releases and their assets, and verify rc.38 still owns Latest. Clients
on removed versions may need a full download instead of a differential update.
