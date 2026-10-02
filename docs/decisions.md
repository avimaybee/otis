# Decision register

Revised 2026-09-30. This register records user decisions and implementation defaults; it does not claim implementation. Resolve contradictions by updating the owning spec and dependent plans together.

| ID | Decision | Authority / owning document |
|---|---|---|
| D01 | Kerning business-memory dogfood first; no general research agent in v1 | User; product/roadmap |
| D02 | Web and Telegram are complete conversational surfaces | User; product |
| D03 | ChatGPT mobile composition, Codex desktop composition, no extra dashboard | User; design |
| D04 | Dark neutral charcoal, off-white type, restrained monochrome controls | User 2026-09-29; design token table |
| D05 | One identity, equal memberships, protected owner transfer | User; product/architecture |
| D06 | Full teammate chat and retained audio history, including pre-join | User; product |
| D07 | Shared workspace provider keys; handpicked models; `/model` chat override | User; contracts |
| D08 | Gemini and OpenCode Go; private Go integration approved, commercial review later | User; provider plan |
| D09 | Voice notes, text reply default, Android and iPhone required | User; design/provider matrix |
| D10 | Durable memory/context in D1, scoped per workspace, no canonical mutable memory.md | Architecture selected to satisfy user's continuity requirement |
| D11 | Clear complete instructions save directly; missing/uncertain details ask | User 2026-09-29; product/autonomy |
| D12 | Missing deadline asks; never assume today | User 2026-09-29; date contract |
| D13 | Status inferred from sentiment asks before changing existing lead status | User 2026-09-29; tool policy |
| D14 | Default Undo from here reverses selected and later same-run changes; single-action option | User 2026-09-29; undo contract |
| D15 | Member chooses brief time; no hardcoded send time | User 2026-09-29; schedules |
| D16 | Schedule starts disabled; chosen weekdays/timezone; max one daily scheduled brief | Conservative implementation default realizing D15; change only with explicit product choice |
| D17 | Whether Otis may initiate high-confidence follow-ups beyond chosen briefs and explicit reminders is unresolved. Keep such triggers disabled until Avi decides; the agent's implementation must support the chosen policy cleanly. | Open product question; see the proactivity question from 2026-09-30 |
| D18 | Outward messages draft-only, sent record requires explicit confirmation | Existing approved v1 boundary |
| D19 | No Playwright; native browser review with evidence | User; verification |
| D20 | Plain prepared SQL for v1; no speculative ORM or vector infrastructure | Engineering choice; architecture |
| D21 | Private file download through Worker membership check, not public presigned bearer access | Required consequence of revocation contract |
| D22 | Identity → conversation/source → ledger schema order, independent of plan numbers | Engineering repair; architecture/roadmap |
| D23 | Automatic voice routing: use the selected model's verified native transcription path for the actual format; otherwise use workspace-configured Groq STT. Unsupported/unverified native audio does not disqualify a text/tool model. | User 2026-10-01; architecture section 13 and Plan 010 handoff |
| D24 | No additional inference spending for dogfood: existing Go subscription and free Gemini/Groq access only; no automatic paid fallback, upgrade, or quota evasion. | User 2026-10-01; provider/voice plans |

## Remaining measurements, not guessed decisions

- The six initial model IDs are selected in provider-capabilities.md; their live endpoint/audio/tool/cache evidence remains to be measured. Groq Whisper Large V3 and Turbo are selected STT candidates; the production STT default follows accuracy/latency tests.
- Provider budgets/timeouts and practical latency/cost targets from controlled tests.
- Actual provisioned data locations and deployment-specific secrets/rotation configuration.
- Real browser/device acceptance; existing DOM tests cannot supply it.
- Outside-customer wedge, pricing and provider/data-processing arrangements after dogfood.
- Proactive follow-ups outside a chosen brief or explicit reminder (D17).

Do not block work on already settled preferences or ask for API keys in a public report. Record new material choices here with date, reason, owner and affected contracts. Routine file decomposition and component naming do not need a decision-register entry.
