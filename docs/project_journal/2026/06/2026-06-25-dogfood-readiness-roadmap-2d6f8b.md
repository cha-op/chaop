---
id: 20260625-2d6f8b
title: Daily Dogfood Readiness Roadmap
status: active
created: 2026-06-25
updated: 2026-06-25
branch: wip/dogfood-readiness-roadmap
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-25-dogfood-readiness-roadmap-2d6f8b.zh-Hans.md) ]

# Daily Dogfood Readiness Roadmap

## Summary
- The previous dogfood usability roadmap is complete through PR E.
- The next goal is to make Chaop reliable enough for daily Browser-to-managed-app-server dogfooding without increasing background cost.
- Cost protection remains the first constraint: no broad inventory sync by default, no background write amplification, and no R2 artefact capture until retention and alerts are explicit.

## PR Plan
- PR F, Readiness Roadmap Closeout: mark the previous roadmap complete, record this next plan, and keep the top-level project state recoverable.
- PR G, Connector And Budget Preflight: add a low-cost readiness path that clearly reports Budget Board posture, connector online state, managed app-server availability, and the next safe operator action before a user starts work.
- PR H, Opt-In Managed Thread E2E: add an explicit operator-triggered smoke for the managed app-server conversation path: budget gate, create or select a small test thread, submit one bounded prompt, observe the final assistant answer, and clean up or archive.
- PR I, Thread Centre Daily Polish: tighten the default conversation surface around one thing: current turn status, final answer, pending input/approval, and actionable error messages. Avoid new high-frequency polling.

## Cost Rules
- Passive readiness checks can read budget, connector, and app-server state, but must not refresh broad Host Session inventory unless the user explicitly opts in.
- Write-path smoke must be explicit, bounded, and guarded by Budget Board posture before and after the run.
- Connector-side debounce, batching, and rate limits remain global per connector; multiple Browser listeners must not multiply connector reports.
- R2 remains deferred until artefact retention, budget alerts, and product value are clear.

## Next Steps
- Implement PR G next.
- Keep PR H behind an explicit operator flag because it intentionally exercises a real app-server turn.
- Continue running the tracked deployed smoke after any API, Web, Access, connector, app-server, or cost-posture change.

## Evidence
- Dogfood usability roadmap: [2026-06-23-dogfood-usability-roadmap-3f8a91.md](2026-06-23-dogfood-usability-roadmap-3f8a91.md).
- Deployed E2E cost gates: [2026-06-25-dogfood-e2e-cost-gates-5e8a12.md](2026-06-25-dogfood-e2e-cost-gates-5e8a12.md).
- PR #23 merged the tracked deployed smoke runner and cost gates.
