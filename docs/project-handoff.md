# Shared Browser project handoff

Shared Browser is maintained in this standalone repository. The previous local
`paseo-plugins` project and its feature worktrees were retired at the owner's
request on 2026-10-16. The upstream monorepo and the original GitHub fork were
not deleted. See [standalone migration](standalone-migration.md) for the original
commit mapping and instructions for future upstream contributions.

## Feature decisions

Keep all existing fork features active, including Android video, direct native
keyboard input, the agent device tool, WSL graphics, explicit agent recovery,
and independent browser tabs. Adopt compatible upstream fixes and defaults;
upstream deferral of a feature is not permission to remove it here.

Trusted agent attachment selects a 60-second screenshot receipt and five-minute
idle control and viewer leases. Public viewer attachment keeps its existing
5-second frame, 30-second control, and 45-second heartbeat policy. Never infer
agent trust from a label. Receipt authority is separated between human and agent
observations of the same cached frame. Human takeover remains immediate, and
navigation, viewport, document, runtime, attachment, and control fences still
apply. Native gesture cleanup has a separate five-second idle timer; it does not
reduce the agent screenshot lifetime. Effective policy is exposed in agent state
and descriptions.

## Runtime and deployment lessons

Plugin reload replaces the bridge, then reconnects to an existing detached
supervisor. It does not activate supervisor or capture implementation changes.
A runtime replacement can close browser sessions and lose unsaved page state;
obtain explicit approval for that concrete disruption after inventorying all
supervisor-owned sessions. Never restart Paseo or unrelated agents to activate
this plugin.

A previous JPEG failure followed a resolution change: the current schema allowed
800,000 bytes while an older detached supervisor emitted larger frames under the
same protocol version. Validate the exact plugin/runtime combination in an
isolated home. A protocol compatibility preflight before disconnecting the
working bridge remains a future safeguard, not a completed migration feature.

The retirement source cutover changed only the registered plugin directory. It
verified the same daemon, supervisor, immutable runtime, browser processes, and
tab identities and URLs before and after bridge reload. Future development must
use the isolated helper documented in AGENTS.md; this one approved cutover does
not authorize further production lifecycle operations.

## Validation baseline

The standalone baseline passed 784 unit tests, five script tests, build,
typecheck, lint, and shrinkwrap checks. Linux, macOS, and Windows CI passed,
including Linux native-video capture/decode. The exact GitHub-install path was
also exercised on an isolated daemon and cleaned up.

- [Standalone CI run](https://github.com/RyanEwen/paseo-shared-browser/actions/runs/38944617359)
- Baseline commit: `adfee6820601412eb3fda5f9a252da63de1e431f`
- Original snapshot commit: `c72ef42331d2476961da3a06421a56e5662ef991`

The old fork's two OMP compatibility nightlies were disabled at the owner's
request. Do not transplant those unrelated workflows into this repository.
Package identity and runtime ID remain compatible; no npm release was requested.

## Local recovery and conversation history

The ignored `.local-history/paseo-plugins-2026-10-16/` directory holds a verified
Git bundle of all old references and both unfinished-merge parents, binary
staged/unstaged patches, untracked source archives for all six old checkouts,
provenance, policy verification receipts, and private project handoff details.
It includes unfinished Feature Kickstart work, which is not part of this plugin.
The bundle was independently cloned and its commit connectivity checked. This
archive is local recovery data and must never be committed or uploaded.

Old workspace and agent conversations remain archived in Paseo. Their IDs and
restoration instructions are recorded in the private handoff. Use the new
Shared Browser project for future work, and recover a monorepo checkout from
the bundle only when a separate task requires it.
