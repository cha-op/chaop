---
id: 20260624-8e1c3b
title: Human-In-The-Loop Turns
status: active
created: 2026-06-24
updated: 2026-06-24
branch: wip/human-in-loop-turns
pr: 21
supersedes:
superseded_by:
---

[ British English | [简体中文](2026-06-24-human-in-loop-turns-8e1c3b.zh-Hans.md) ]

# Human-In-The-Loop Turns

## Summary
- PR C follows the merged Thread Centre chat MVP and keeps the dogfood safety gate in front of every write-producing operator action.
- The product goal is to let a managed Codex app-server turn pause for approval or user input, show that pending action inside the relevant Thread Centre turn, and resume the app-server turn after the operator responds.
- The slice stays cost-bounded: a pending interaction is one structured thread event, and a response is one structured resolution event. It does not add a polling table or broad connector sync.

## Planned Scope
- Extend the shared protocol with structured `turn_interaction` request and resolution payloads.
- Persist optional event payload JSON in D1 so approval/input requests survive refresh and can be resolved from another browser.
- Add a browser API for resolving one pending interaction, guarded by the `turn_interaction` dogfood safety action.
- Forward Codex app-server approval and input JSON-RPC requests through the connector to Chaop, then send the browser response back to app-server.
- Render approval and input controls directly inside the relevant Thread Centre turn.

## Validation Plan
- Run focused Web and Worker tests for turn aggregation, payload persistence, safety posture, and interaction resolution.
- Run focused Rust connector tests for command approval and request-user-input app-server flows.
- Run the full local test/build gate before PR review.
- Refresh API and Web deployments after the final code changes, then run the deployed E2E smoke with budget/safety checks.

## Review Follow-Up
- The final review pass found that permission approvals needed to show the requested `network` and `fileSystem` details before an operator could approve turn or session scope.
- The review also found that dogfood safety pauses must not fake-accept hidden approval/input request events; the connector now fails the affected turn visibly when the control plane rejects a required interaction event.
- App-server input auto-resolution now emits an `input.received` resolution event so Browser clients clear stale pending input controls and late submissions are rejected by the existing resolution guard.
- A later review pass found a connector race where final app-server events could be returned before queued interaction events were dispatched. The connector now drains pending interaction events before returning final turn events.
- Sample HITL data now uses generic workspace paths rather than deployment-instance or local-machine paths.

## Cost Notes
- Request and response persistence adds at most two event rows per human-in-the-loop pause.
- Resolution claims are scoped by command plus interaction so repeated app-server request IDs across turns do not strand later responses.
- WebSocket delivery remains the preferred realtime path. The existing 10-second fallback polling remains unchanged.
- The new `turn_interaction` safety action allows the hard-limit and pause controls to block operator responses before they create D1 writes.
