/**
 * Re-export shim: the domain model lives in @angus/letta-client-core (Phase 2
 * extraction — one implementation, two shells). This file keeps the app's
 * import paths (`../lib/letta/model`) stable so the UI surface doesn't churn
 * with the package migration; consumers migrate to the package import only
 * when touched. The local module copies were deleted in the same commit —
 * there is exactly one copy fleet-wide (drift guard: the core package pins
 * its extraction source in PROVENANCE.md).
 */
export * from "@angus/letta-client-core";
