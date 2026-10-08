> Historical record, archived 2026-10-07 from `plans/qa/2026-10-04-stream-economics-check.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Source-verified stream economics for browser QA

Reviewer, 2026-10-04. Current local source inspected directly; this is not deployed usage measurement or acceptance of 014.

## What is actually repaired locally

`packages/identity/src/session.ts` verifies sessions with a SELECT and no last-seen mutation. `apps/worker/src/chat/activity.ts` returns before reading `run_activity` when the requested cursor equals the stored cursor. `apps/worker/src/chat/stream.ts` checks membership on initial/heartbeat cadence or before delivering new activity, not twice unconditionally on every empty tick. It rotates cleanly after its internal query budget rather than forcing a full snapshot reload.

These changes remove the identified idle read-side write amplifier from this local path. They do not establish that the deployed version contains the fix. Local D1 economics tests cover zero-row-write idle behavior; the prior acceptance reports specify their metadata limitations.

## What still exists locally

`packages/contracts/src/chat.ts` still sets the SSE poll interval to **500ms**, heartbeat to15s and nominal stream lifetime to5min. Query-budget rotation can close sooner. Every idle poll still reads the chat cursor. A per-invocation budget prevents one request exceeding its bound; it does not remove aggregate daily polling reads.

`apps/worker/src/agent/streamPublish.ts` buffers text/thinking, but publishes intermediate batches through `publishAgentActivity` in the agent handler. This remains persisted activity, not the zero-D1-preview transport specified by 014. Text can flush every300ms subject to its buffer/cap; thinking every400ms subject to its buffer/budget. These are active-run costs, separate from the former idle write incident. No per-tab-hour or percentage saving is newly measured here.

## What Antigravity should establish

- Record the tested deployment identity and distinguish it from unpublished local source.
- Observe whether idle streaming repeatedly reconnects, reloads snapshots, produces console transport errors or changes visible UI. Capture request cadence/status without cookies or raw payload secrets.
- Keep an idle tab open for a bounded observed interval, then perform one clearly labelled synthetic actual-model conversation. Report both timings separately. If authorized dashboard usage evidence is accessible, compare idle versus active row-write/read deltas; network request counts are not D1 billed rows.
- Verify the stream can stop/reconnect/reload without losing or duplicating the final answer and without blocking another follow-up.

If production still has the old idle-write behavior, it is a demonstrated urgent release/runtime issue. If it has the current containment, acknowledge that repair and keep residual polling/preview costs explicit. Do not call 014 implemented, recommend another speculative transport service, or treat fixture screenshots as cost evidence.
