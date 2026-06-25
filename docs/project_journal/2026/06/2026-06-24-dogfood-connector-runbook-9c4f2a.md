---
id: 20260624-9c4f2a
title: Dogfood Connector Runbook
status: completed
created: 2026-06-24
updated: 2026-06-24
branch: wip/dogfood-runbook
pr:
supersedes: []
superseded_by:
---

[ British English | [简体中文](2026-06-24-dogfood-connector-runbook-9c4f2a.zh-Hans.md) ]

# Dogfood Connector Runbook

## Summary
- PR D turns the ad-hoc connector launch path into a persistent dogfood operating path.
- The new script manages connector PID and logs in a durable user state directory, starts and stops the existing `chaop-agent --connect` loop, supports one-shot smoke runs, and can touch the managed app-server upgrade marker.
- The paired runbook documents cost-safe start, stop, observation, recovery, and upgrade scheduling without committing deployment-instance values.

## Current State
- `scripts/dogfood-connector.sh` provides `start`, `stop`, `restart`, `recover`, `status`, `logs`, `doctor`, `once`, and `schedule-upgrade`.
- `pnpm dogfood:connector -- <command>` is the documented operator entrypoint.
- `docs/dogfood-runbook.md` and `docs/dogfood-runbook.zh-Hans.md` are the user-facing runbooks.
- README and deployment guide entrypoints now point daily dogfood usage at the persistent script rather than a temporary `cargo run` loop.

## Next Steps
- PR E should harden deployed dogfood E2E and cost telemetry gates, keeping exact D1 write attribution deferred unless unexplained growth reappears.

## Evidence
- Local shell, project, and deployed smoke validation will be recorded in the PR readiness report before merge.
