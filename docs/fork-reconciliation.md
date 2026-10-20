# Fork reconciliation with upstream

Historical reconciliation notes from the retired monorepo preview. Current fork behaviour is described in the [README](../README.md); current contribution guidance is in [standalone migration](standalone-migration.md).

Upstream PRs 274, 275 and 280 are merged. Display controls and optional Xvfb from 292 and 293 were incorporated through 274; those separate PRs are superseded.

The fork adopts upstream's receipt freshness, decoding, tab focus/order, Compose, owned-process, explicit display-loss recovery, packaging and SDK corrections. Video and Xvfb are opt-in. Medium JPEG and the 800 KB frame bound are the defaults.

The preview retains Android host-canvas video, native live keyboard input, the agent device tool, WSL hardware graphics, agent connection recovery, hidden-panel suspension, and the larger agent viewport range. Android video requires the matching Paseo fork; the published SDK does not provide that optional host extension. Explicit previously supported 0.11 beta allowances remain in the Shared Browser manifest.

The monorepo contribution workflow kept main identical to upstream and prepared each contribution from upstream main. That branch policy does not apply to this standalone fork. The preview merge retained original fork history instead of replaying squashed contributions or replacing cumulative PR branches.
