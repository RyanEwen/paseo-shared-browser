# Standalone migration

This repository contains Shared Browser only. It derives from the MIT-licensed
`omercnet/paseo-plugins` monorepo and retains its license, attribution, plugin ID
`shared-browser`, and package name `@omercnet/paseo-shared-browser`.

## Preserved source

The source checkout had a pending upstream reconciliation. The extraction does
not complete or alter that monorepo merge.

| Source | Original commit | Filtered plugin commit |
| --- | --- | --- |
| Fork preview | `0fc2eea61c32238c782949592a2d19ae70aaaee3` | `865ac797c2d2499bcc100f08bc54befe77753d73` |
| Pending upstream merge parent | `daed6eb12f4156ca392f71c48e7a9ccca231ae8c` | `e97345dd67e1168b1dbfa04ce6bd93890354a3a9` |

The two-parent snapshot commit `c72ef42331d2476961da3a06421a56e5662ef991` preserves both filtered histories
and the complete current plugin worktree, including staged reconciliation,
unstaged changes, and new agent-policy files. All 233 files were checked by
SHA-256, executable permissions, and symlink targets before standalone adaptations.

Retained behavior includes Android video integration, direct native keyboard
relay, the agent device tool, WSL graphics support, explicit agent recovery, and
the trusted agent 60-second frame / 300-second idle control and viewer policy.
Compatible upstream video, Xvfb, and JPEG defaults are retained.

## Standalone adaptations

- Plugin files live at the repository root.
- Catalog dependencies use explicit versions; development tooling matches the
  source lockfile, and Bun has its own standalone lockfile. `npm-shrinkwrap.json`
  remains the production installation lockfile. There is no competing npm lock.
- `scripts/build-plugin.mjs` uses the real Paseo compiler. Its server development
  dependency is explicit; the old preview CI failed because it was missing.
- `scripts/shrinkwrap.mjs` is local, and Git dependency preparation works without
  a parent catalog. The isolated development helper stages a private plugin copy
  so production preparation cannot remove the checkout's development tooling.
- CI validates Shared Browser on Linux, macOS, and Windows, including native
  browser smoke tests and Linux video. OMP and release/publishing workflows are
  not included. Package version and changelog are carried over without a bump.
- Mocked hook tests use individual parameterized cases and a custom-hook harness
  name to satisfy the pinned Biome rules without changing runtime behavior.

The original active plugin installation is independent of this checkout. Creating
this repository or Paseo project does not switch an installed plugin's source or
replace any running supervisor.

## Isolated verification

```sh
bun install --frozen-lockfile
npm run build
npm run check
npm run typecheck
npm run test:scripts
npm run test:unit
bash scripts/dev-daemon.sh up
bash scripts/dev-daemon.sh cli plugin ls
bash scripts/dev-daemon.sh down
```

The helper uses a checkout-specific temporary home and explicit daemon targets.
Its private staging copy keeps production dependency preparation away from the
development checkout and is recreated on every fresh start, including deletions.
There is no reload shortcut: after runtime or supervisor edits, stop fixture clients,
run `down`, then `up`. Teardown gracefully stops only the verified supervisor in
that isolated home before stopping its daemon. It refuses mismatched processes. Browser runtime smoke tests also need prepared runtime
assets under an explicitly isolated `PASEO_HOME`; see the CI workflow. Never run
runtime tests against a signed-in user's default home or browser profile.

## Contributing upstream

Upstream remains `https://github.com/omercnet/paseo-plugins`. Its plugin still lives
under `paseo-shared-browser/`; the standalone histories therefore have different
commit IDs. Keep standalone tooling/metadata out of upstream feature patches.

Prepare a feature patch from the relevant standalone commit(s), then apply it to
an isolated, up-to-date monorepo checkout with the directory prefix restored:

```sh
git show --format= --binary FEATURE_COMMIT -- client server shared tests > feature.patch
git -C /path/to/isolated/upstream apply --check --directory=paseo-shared-browser /path/to/feature.patch
git -C /path/to/isolated/upstream apply --directory=paseo-shared-browser /path/to/feature.patch
```

Review compatibility with upstream decisions and its current dependency versions,
run its plugin checks, and open a focused PR. Do not apply patches to the original
checkout while its pending merge is unresolved. No automatic monorepo deletion,
release, npm publication, or live installation cutover is part of this migration.
