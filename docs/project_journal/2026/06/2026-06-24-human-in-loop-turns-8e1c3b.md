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
- Refresh API and Web deployments after each code-change batch, then run the deployed E2E smoke with budget/safety checks before reporting the slice ready.

## Review Follow-Up
- The final review pass found that permission approvals needed to show the requested `network` and `fileSystem` details before an operator could approve turn or session scope.
- The review also found that dogfood safety pauses must not fake-accept hidden approval/input request events; the connector now fails the affected turn visibly when the control plane rejects a required interaction event.
- App-server input auto-resolution now emits an `input.received` resolution event so Browser clients clear stale pending input controls and late submissions are rejected by the existing resolution guard.
- A later review pass found a connector race where final app-server events could be returned before queued interaction events were dispatched. The connector now drains pending interaction events before returning final turn events.
- The readiness review found three remaining delivery races. Browser responses now require a connector delivery acknowledgement before persistence, Worker auto-resolution expiry honours the connector grace window, and stale resolution claims can be reclaimed after a short timeout.
- Sample HITL data now uses generic workspace paths rather than deployment-instance or local-machine paths.
- The final review found that response delivery acknowledgements still needed to prove the app-server worker consumed the matching interaction response. The connector now tracks the active interaction for each app-server turn and waits for a local worker delivery acknowledgement before the Worker records a browser response.
- Duplicate interaction-resolution insert races now best-effort roll back the sequence number they allocated when the insert loses to the unique constraint, avoiding sequence gaps and unnecessary follow-on accounting.
- App-server v2 command approval compatibility now preserves `availableDecisions`, object-shaped `acceptWithExecpolicyAmendment` responses, `proposedExecpolicyAmendment`, `commandActions`, and `networkApprovalContext` so Thread Centre can render network-specific approvals and send the exact accepted decision back to app-server.
- The WorkspaceDO internal turn-interaction validator now accepts the same object-shaped exec-policy amendment approval decision as the public route, with DO coverage for forwarding that response to the connector.
- Browser-submitted interaction responses now must match the stored request payload: approval decisions are constrained by `available_decisions` when app-server supplied them, input answers must cover exactly the requested questions with non-empty answers, and Thread Centre renders the full network approval context so unknown safety-relevant fields are visible.
- GitHub Codex follow-up fixes remove absolute workspace-shaped sample paths, use checked app-server auto-resolution deadline arithmetic, keep HITL response delivery acknowledgements pending until the app-server response is written, and handle HITL responses that arrive while the connector is still waiting for the request event acknowledgement.
- The independent PR review found two fail-closed gaps. WorkspaceDO now rejects malformed required `approval.requested` and `input.requested` events with a negative ack before any DB write, and app-server `availableDecisions` now preserves an empty `available_decisions` list when supplied decisions are invalid so the browser and API do not fall back to unrestricted defaults.
- Follow-up review found three remaining fail-closed and auditability gaps. Browser responses are now durably stored in the resolution claim before connector delivery, delivered claims can be retried without re-sending to app-server, input requests without valid questions are rejected before they become operator-visible, and malformed resolution payloads are rejected or ignored defensively before DB de-duplication code can throw.
- The latest independent review found that raw input answers must not be retained in D1 claims and that delivered-but-unrecorded claims must outlive the short pending-claim timeout. Resolution claims now keep a recovery-safe resolution summary and payload, never store input answers, reject duplicate pending submissions instead of re-dispatching them, and fail closed when app-server approval choices contain no valid decisions.
- The review re-run found four remaining recovery gaps. Delivered claims are now recovered before auto-resolution deadline checks, dispatch-started claims are not reclaimed by the pending-claim TTL, auto-resolved input events are emitted only after the app-server JSON-RPC result is written, and approval requests now require an explicit non-empty `available_decisions` allow-list across connector, Worker, Durable Object, Web, and sample data paths.

## Cost Notes
- Request and response persistence adds at most two event rows per human-in-the-loop pause.
- Resolution claims are scoped by command plus interaction so repeated app-server request IDs across turns do not strand later responses.
- The response claim now stores a delivered marker and a recovery-safe resolution summary/payload. Approval decisions may be retained for compatibility, but input answers are not stored in the claim. This adds bounded low-frequency writes only when an operator resolves a HITL request, and avoids adding any background sweep or polling path.
- Response claims also store a dispatch-started marker. It is one extra bounded write on the explicit operator response path and prevents ambiguous app-server deliveries from being automatically cleaned up and re-dispatched.
- Stale claim recovery is bounded to the response-dispatch path and does not add a background sweep.
- WebSocket delivery remains the preferred realtime path. The existing 10-second fallback polling remains unchanged.
- The new `turn_interaction` safety action allows the hard-limit and pause controls to block operator responses before they create D1 writes.
