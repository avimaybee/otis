# Otis browser QA and acceptance

Reviewer-authored, 2026-10-04. User requires hands-on deployed-app testing. The user initially assigned Luna high, then chose Antigravity after connected browser control was unavailable in this session. Antigravity is the current browser QA owner; do not restart Luna or command-driven isolated-browser QA as a substitute. This supplements source review and automated tests; it does not replace either or authorize deployment.

## Release identity comes first

Record the tested URL, date, browser, viewport and observable deployment/build identifier where available. Separate the local working tree, local preview and deployed app. A feature present only locally is not a production success, and an older deployment cannot prove the current patch failed. If no reliable version identifier is available, say so.

Commit and push to the connected branch automatically deploy to Cloudflare. Do not use push as routine housekeeping. Prepare the reviewed release, remote-schema/configuration checklist and rollback information before any required release approval. Apply remote migrations or deploy only with authorization.

## Every relevant review cycle

1. Reviewer inspects the changed source and meaningful failure boundaries.
2. Run appropriate targeted checks and required root checks. Record exact results, not another agent's claimed results.
3. Browser QA exercises production components locally for unpublished changes and the actual deployed app for released behavior. Use native browser controls; no Playwright. Antigravity currently owns hands-on QA under the user's latest instruction. Do not silently replace runtime testing with fixture screenshots.
4. For each finding record reproduction steps, expected behavior, actual behavior, URL/viewport, evidence path and impact. Distinguish reproduced failures from suspicions and version mismatch.
5. Reviewer validates findings, writes a bounded implementation assignment and sends it to the existing OpenCode session. The implementation agent cannot self-accept or independently pick the next feature.
6. Repeat the failed browser scenario after repair. After deployment, repeat the critical actual-model conversation path in production before calling it ready.

## Practical QA scope

The critical journey is sign in, open a chat, send a clearly labeled synthetic message, receive an actual reply, save a synthetic fact, retrieve it later and reload without losing or duplicating it. Check optimistic feedback, stream visibility, author attribution, current model/thinking state, functional commands, follow-up during work, Stop, retry and understandable errors.

Also inspect history/search/deep links, scroll and jump-to-latest, settings, keyboard/focus, long content/markdown and mobile layout. Check widths 360, 390, 900, 1280 and 1440 where relevant. Use approved tokens and references. Browser viewport emulation does not establish actual iPhone microphone/keyboard behavior.

Test offline/weak connection only in an isolated review browser, restoring its network state afterwards. Do not alter the user's active browser connectivity. Do not delete real history, change shared credentials/membership/ownership, disconnect accounts or contact people through Telegram. Use reversible own-chat settings and restore them. Clearly label synthetic QA data.

## Evidence and limits

Keep reports and screenshots under `plans/qa/`. Never include authentication tokens, API keys, link codes, raw cookies or private prompts in reports/network dumps. List what was tested, failed, blocked and not tested. Authentication requiring human interaction is a real blocker for protected journeys; do not bypass it, extract another profile's credentials or claim unauthenticated screenshots prove chat works.

Local acceptance, browser fixture acceptance and deployed acceptance are separate verdicts. No broad claim such as 'everything works' follows from a narrow successful scenario. Record actual reply latency and behavior rather than inventing a fixed provider response promise.

This is a review process, not a scheduled automation or permission for unattended external outreach.
