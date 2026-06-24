---
id: 20260623-3f8a91
title: Dogfood Usability Roadmap
status: active
created: 2026-06-23
updated: 2026-06-24
branch: wip/dogfood-safety-gate
pr:
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-23-dogfood-usability-roadmap-3f8a91.zh-Hans.md) ]

# Dogfood Usability Roadmap

## Summary
- The next product goal is to keep Chaop cost-safe while making it usable enough for daily dogfooding from the Browser.
- Cost protection stays first: broad inventory sync remains opt-in, write paths must be bounded, and the UI should make the current bottleneck visible before users start expensive operations.
- Usability then focuses on one practical path: create or select a managed app-server thread, send a prompt, watch live progress, and read the final assistant response without dropping to raw event logs.
- Each implementation slice will land as its own PR. Every PR must pass the full local/CI test set, three review lanes, resolved GitHub conversations, merge, master refresh, and a fresh branch before the next slice starts.

## PR Plan
- PR A, Dogfood Safety Gate: add a clearer top-level cost posture, server-side guards for command creation and broad refresh actions, an emergency pause or stop path, and docs for the safe operating envelope.
- PR B, Thread Centre Chat MVP: make the managed app-server path the default visible workflow, support creating/selecting a thread, submit prompts, stream progress, and render the assistant final answer above low-level events.
- PR C, Human-In-The-Loop Turns: surface approval and input-needed states from Codex/app-server turns, and add approve, deny, and provide-input actions in Thread Centre.
- PR D, Persistent Connector Dogfood Runbook: add scripts and documentation for starting, stopping, observing, and recovering the connector/app-server pair during dogfood sessions.
- PR E, Cost And E2E Hardening: extend deployed smoke coverage around the dogfood path, keep cost telemetry checks in the gate, and add exact D1 write-attribution only if lower-cost telemetry shows unexplained growth.

## Delivery Rules
- Keep `master` green and shippable after every merge.
- Do not start the next implementation PR until the previous PR is merged, `master` is updated locally, and a new topic branch exists.
- Record each non-trivial slice in `docs/project_journal/` with paired English and Simplified Chinese entries.
- Keep deployment-instance values in ignored local files or the private ops repository, never in tracked Chaop docs.
- Prefer managed app-server execution for user-visible product flows. Keep `codex_exec` private or hidden unless it is deliberately needed as an operator fallback.

## Validation Gate
- Run the full project test/build gate for each PR.
- Run the project journal validator when docs change.
- Run the deployed E2E smoke when a slice changes production-facing API, Web, Access, connector, app-server, or cost-posture behaviour.
- Run three review lanes before merge, then resolve or explicitly close every GitHub conversation.

## Current Next Step
- PR A landed through [PR #19](https://github.com/cha-op/chaop/pull/19).
- PR B is implemented on `wip/thread-centre-chat-mvp`.
- PR C is the next planned slice: human-in-the-loop approval and input handling for Codex app-server turns.
