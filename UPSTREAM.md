# Upstream sync policy

This fork tracks [letta-ai/agent-sdk-mobile-app](https://github.com/letta-ai/agent-sdk-mobile-app).

## Cadence

Event-driven, not scheduled: upstream pushes rarely. Sync when any of these hold:

- Upstream `main` has new commits (check before any planned sync — the GitHub "Sync fork" indicator is enough)
- A downstream needs an upstream fix
- Quarterly, as a floor

## Sync procedure

1. Merge `letta-ai/main` into `Lettasphere/main` via a PR (true merge — history is shared).
2. Resolve conflicts in favor of semantics, not text: our patches are small and isolated, so conflicts should be rare.
3. After merging, walk the `upstream:`-labeled PRs (below) and drop any patch upstream has now taken.

## Patch tracking

Every PR that changes behavior upstream will eventually have gets an `upstream:` label:

| Label | Meaning | Action on sync |
|---|---|---|
| `upstream:pending` | PR raised to letta-ai, awaiting them | keep carrying |
| `upstream:merged` | letta-ai took it | drop our patch on next sync |
| `upstream:rejected` | letta-ai declined | keep carrying permanently |
| `upstream:none` | lettasphere-only by design | keep carrying |

Link the letta-ai PR in ours when raised. This table is the sync owner's checklist.

## Sync ownership

The sync owner is whoever merges the sync PR — rotating is fine, but each sync PR names its owner. If you need a sync and nobody's done one in a while, that's the signal to do it.
