# Operator: land `v0.1.2-alpha.5+zw.1` on aka-danielZhang/deepseek-harness

This Cloud Agent completed the merge locally (`HEAD` `aa77a4b147bb19410c3d645811ca54771c93eb98`) but **cannot push**: GitHub App `cursor[bot]` has no write on `aka-danielZhang/deepseek-harness` (403). Do not fork to GuoxinShan. Push from an account that already has rights on that remote.

Convention (FORK.md + previous PR #10): branch `bump/0.1.2-alpha.5`, PR into `master`, **tag after merge** (`git tag v0.1.2-alpha.5+zw.1 && git push origin v0.1.2-alpha.5+zw.1`) so `.github/workflows/npm-release.yml` publishes `@crazx/*@0.1.2-alpha.5.zw.1`. Do not merge `master` from the agent.

## Replay

```sh
git clone --recurse-submodules git@github.com:aka-danielZhang/deepseek-harness.git
cd deepseek-harness
git remote add official https://github.com/deepseek-ai/deepseek-harness.git
git fetch official tag dsh-v0.1.2-alpha.5
git checkout -b bump/0.1.2-alpha.5 origin/master
git merge dsh-v0.1.2-alpha.5
```

Conflict policy: keep **both** sides' semantics (same as prior baseline bumps).

| Path | Keep |
|---|---|
| `packages/session/session-persistence/src/coordinator.ts` | upstream `SessionLogOffset` + `state.storage` + inherited-prefix check **and** fork single-writer `revision` / `refreshRevision` / `appendBatch` rollback |
| `packages/session/session-persistence/src/index.ts` + persistence docs | writer-guard **and** inherited-prefix append docs |
| `packages/bundle/base/cordis.patch.yml` | fork `todo-completion-guard` row **and** upstream `web_fetch` default comment |
| `packages/extensions/tool-cordis/src/api-catalog.ts` | both |
| `docs/event-producer-consumer.md` / `.zh.md` | upstream `api-session/*` line numbers **and** `todo-completion-guard` on `agent/turn-stopping` |
| `*.i18n.yaml` | `pnpm run verify-translation-pairing --write` |

Reference hunks of the zw side vs pure official alpha.5: [`keep-zw-on-alpha.5.patch`](./keep-zw-on-alpha.5.patch). After a correct merge, apply the guard API fix:

```sh
git am path/to/oh-my-dsh/docs/harness-bump/0.1.2-alpha.5/0001-fix-guard-read-Session.snapshotEvents-after-alpha.4-.patch
```

Expected: `todo-completion-guard` reads `agent.session.snapshotEvents()` (alpha.4 removed `Session.events`). Then:

```sh
git push -u origin bump/0.1.2-alpha.5
gh pr create --base master --head bump/0.1.2-alpha.5 \
  --title 'chore(fork): bump to upstream 0.1.2-alpha.5' \
  --body 'Merge official dsh-v0.1.2-alpha.5; keep +zw patches; guard uses snapshotEvents(). Tag v0.1.2-alpha.5+zw.1 after merge.'
```

After the PR is merged (by a maintainer, not this agent):

```sh
git checkout master && git pull
git tag v0.1.2-alpha.5+zw.1
git push origin v0.1.2-alpha.5+zw.1
```

`publish-fork --list --base 0.1.2-alpha.5` is still the same 11 packages. `prepare-runtime` in oh-my-dsh will fail loud until that npm layer exists.
