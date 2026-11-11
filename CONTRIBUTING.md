# Contributing to the Lettasphere fork

This is the Lettasphere community layer: a curated fork of [letta-ai/agent-sdk-mobile-app](https://github.com/letta-ai/agent-sdk-mobile-app) that every Lettasphere downstream app inherits from.

```
letta-ai (official)  →  Lettasphere (this repo, curated)  →  your bespoke fork
```

## What belongs here

**Yes — merge it:**
- Generic bug fixes (build, typecheck, crashes, packaging, DX)
- Fixes found by running any downstream app for real
- Features every downstream would want (propose in an issue or Discord first)

**No — keep it in your fork:**
- Theming, branding, custom providers, private integrations
- Anything requiring your credentials, servers, or accounts
- Features only one downstream needs (fine to carry privately — that's the model)

Unsure? Open an issue or ask in the Lettasphere Discord. The community decides scope.

## How to contribute

1. Branch from `main` (`fix/…` or `feat/…`).
2. Keep PRs small and upstream-shaped — one concern each, no bundled downstream context. Small PRs merge fast and can be proposed to letta-ai as-is.
3. PRs need **1 approval**. Stale reviews are dismissed on new pushes; history is linear.
4. CI must pass (typecheck, lint, tests, build).

## Credit

- Apache-2.0 is the license baseline (inherited from upstream).
- Attribution is culture here, not just license: name the author(s) in the PR body — human, team, or AI agent. Carrying a patch from another fork? Credit the original author in the commit message.
- Downstream forks of this repo are encouraged (not required) to credit Lettasphere in their README.

## Relationship to letta-ai

Upstream is the source of truth and merges slowly. This fork does **event-driven syncs** (see [UPSTREAM.md](UPSTREAM.md)): when upstream lands something, it merges down; generic fixes from this fork get proposed upstream as community-reviewed PRs, and are dropped here once upstream takes them.
