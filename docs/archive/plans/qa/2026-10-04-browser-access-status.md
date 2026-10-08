> Historical record, archived 2026-10-07 from `plans/qa/2026-10-04-browser-access-status.md`. Its claims apply to the original baseline. Use [current implementation status](../../../status.md) for active work; old proposals and DONE labels are not current authority.

# Deployed browser QA access — not completed

Reviewer record, 2026-10-04.

The user requested Luna high to use the connected default browser and test the deployed app, then explicitly rejected command-driven isolated-browser substitution. The Luna QA agent was interrupted. No deployed conversation, actual model reply, authenticated settings or comprehensive production QA is accepted from this attempt.

The currently exposed tool catalog contains no connected-browser navigation/interaction tool, `node_repl` or computer-use runtime. The computer-use skill is installed, but its required runtime is not exposed; an installed skill is not evidence of usable browser control.

An attempted default-browser launch via `Start-Process` was rejected by policy. It was not retried through another shell/helper. The supported `open_in_codex` browser-opening tool returned `queued` for the production URL; that does not prove default-browser navigation or interactive access.

Resume through the connected browser integration when it becomes available. Retain the explicit user choice; do not resume isolated CDP or shell-driven browser QA as a substitute. Opening a tab, unauthenticated reachability and fixture screenshots do not close the requested production QA.

OpenCode's 009A completion report was read and agrees with the independently verified local 633-test result. OpenCode is instructed to wait for the reviewer's next assignment. Commit/push automatically deploys and has not been authorized or performed in this attempt.
