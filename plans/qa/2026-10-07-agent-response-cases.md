# Otis response-quality cases

Status: proposed evaluation corpus, not executed against live models. Synthetic records only. This is a manual/offline model comparison alongside deterministic integration tests, not a production grader or a new evaluation service.

## Shared fixture

Clock: 2026-10-07 10:00 Asia/Kolkata. Workspace: Sample Studio. Acting member: Nora; teammate: Owen. Lead records: Cedar Works (warm, owner Nora), Bluebird Coffee Ltd (warm, owner Owen, alias Bluebird), Meridian Studio (hot, unassigned). Each has a stable ID in the tool fixture, never in normal user-facing prose. Cedar's stated preference is email; Bluebird's is WhatsApp. Preserve those subject associations even if the note body contains only “Prefers email”/“Prefers WhatsApp”.

Cedar has an open “Send revised quote” task due 2026-10-06 as a local date, and last effective contact on 2026-10-04. Bluebird has no open task or saved deadline. Meridian has an explicitly undated open task “Confirm project scope”. Cedar's latest offered quote is EUR 650 (stored as 65000 minor units); expected budget is EUR 900 (90000). An older contact dated 2026-10-06 has been undone and must not replace the effective contact. One forgotten note says “Prefers calls”; it is retained for audited history and excluded from normal agent recall. No outcome below permits sending real external messages.

Use per-case overrides as specified. For model comparisons, construct real tool fixtures and replayable conversations from these facts; do not merely place the expected answer into the prompt. For implementation tests, assert facts, effects and scope rather than exact prose.

## Cases

| ID | User input / fixture override | What a good response does |
|---|---|---|
| R01 | “Save this: Cedar asked for a revised quote. Remind me to send it on 13 October.” | Saves the note and dated task; confirms both briefly with readable date. Does not change lead status or ask an unnecessary question. |
| R02 | “Cedar asked for a revised quote. Remind me to send it.” | Saves only the independently complete fact if the existing execution policy permits; asks for the missing deadline once. Clearly states any completed part. |
| R03 | “What's happening with Cedar?” | Gives confirmed status, effective last contact, overdue next step and relevant quote context. Does not dump all fields/events. |
| R04 | “Give me the full picture on Cedar—history, money, risks and what you'd do next.” | Provides enough detail for all four asks. Distinguishes offered/expected amounts, saved facts and its recommendation. No arbitrary one-sentence ceiling. |
| R05 | “Which leads should I focus on today, and why?” | Uses overdue/open work and available context to prioritize, explaining the reason for each suggestion. Does not silently update statuses or create tasks. |
| R06 | “What's the status of all leads?” Override: 41 matching leads, first page 25, accurate full-set counts and cursor. | Counts all 41, states 25 currently shown, and makes remaining records accessible. Does not call 25 rows “all leads”. |
| R07 | “Compare Cedar and Bluebird. How should I contact each?” | Keeps email attached to Cedar and WhatsApp to Bluebird. Useful comparison, not unattributed preferences. |
| R08 | “Hey can you remind me what we agreed about Bluebird's payment terms?” Override: saved entity note requiring a deposit. | Retrieves the aliased entity/topic despite filler words; reports only the actual saved terms. No guessing from generic recency notes. |
| R09 | “What did we decide earlier about a staged deposit?” Override: discussion 15 messages back, never filed as business state. | Retrieves authorized older chat text, describes it as a discussion, and does not claim it was saved/agreed unless history supports that. |
| R10 | “Make that shorter.” Immediately after an outreach draft. | Revises the referenced draft, retaining key facts and tone. No new fact lookup or unrelated conversation. Updates the saved draft only when the request/context authorizes that. |
| R11 | “Mark the second one done.” Latest visible list: Cedar's quote task second; older brief has a different second task. | Resolves the current presented-list item and correct stable task ID; revalidates the task before mutation. Asks only if the reference is actually ambiguous. |
| R12 | “Remind Jordan tomorrow.” Override: two equally plausible Jordans. | Asks which Jordan with readable choices, without exposing IDs or guessing. Uses known timezone for tomorrow after identity resolution. |
| R13 | “Any update on Harbor?” Override: no matching lead or earlier discussion. | Says no record was found within the actual searched scope; asks for a useful identifying detail only if needed. Does not invent a status. |
| R14 | “Did you save that?” Override: input accepted but no business receipt yet. | Distinguishes received input from completed filing. Does not claim the requested business change is saved before a receipt commits. |
| R15 | “Save the note and create the follow-up.” Override: note commits; task/provider subsequently fails. | Specifies the saved note and unfinished follow-up. Recovery continues the unfinished work without repeating the note. |
| R16 | “Who owns Cedar?” Override: owner field disputed. | Reports the dispute/last confirmed ownership with explicit qualification if available. Does not select a candidate as settled. |
| R17 | “When did we last speak to Cedar?” | Uses 4 October, excluding the undone 6 October contact and any draft/open-link activity. |
| R18 | “How much have we quoted?” Override: additional RON quote, offered/expected values separate. | Computes confirmed offered totals in code, grouped by currency. Does not add expected budgets or mix EUR/RON into a single total. |
| R19 | “Write a WhatsApp follow-up for Bluebird. Warm, direct, no salesy stuff.” | Produces a usable draft in the requested channel/tone with saved facts and no invented agreement. Stores it as a draft when requested; does not claim sending. |
| R20 | “?” During ongoing work or after a clarification. | Interprets the visible situation, gives a brief status or restates the actual question. No panic, apology monologue or generic capabilities pitch. |
| R21 | “Ce trebuie să fac azi?” | Answers naturally in Romanian using current due work and understandable dates. No announcement about switching languages. |
| R22 | “Mi a helyzet a Cedarrel? Részletesen.” | Answers in Hungarian with requested detail and accurate Cedar facts. English stopword heuristics cannot determine relevance. |
| R23 | “From now on give me detailed explanations unless I ask for a quick answer.” | Saves an explicit acting-member communication preference through the current memory owner; follows it without changing teammates' defaults. |
| R24 | “Can you look at the photo again?” Original image earlier in the chat. | Uses actual retained pixels/re-read tools; says plainly if the image cannot be loaded or the chosen model cannot inspect it. No guessed visual details or unnecessary re-upload demand. |
| R25 | “Explain why this request failed.” Override: known provider connection failure. | Gives the relevant plain limitation and next action, plus committed effects if any. Does not evade because the prompt forbids mentioning mechanics, and does not expose secrets/raw upstream bodies. |
| R26 | Successful provider terminal stream with empty output. | Preserves any committed outcomes and shows a truthful recoverable no-answer state. No blank completed bubble; no blind repeat of previous writes. |
| R27 | “Compare these three quotes in a detailed table.” Supplied text: A costs EUR 600 for design only; B costs EUR 950 for design/build with two revision rounds; C costs EUR 800 for design/build, hosting extra, revision count unknown. | Chooses useful columns for price, scope, revisions, exclusions and tradeoffs. Uses supplied information without a lead lookup; unknown revision count stays unknown. No invented currency conversions. |
| R28 | “Give me Cedar's history as a timeline table: date, what happened, outcome, next action.” | Retrieves appropriate history and chooses timeline columns rather than lead-status columns. Undone activity is qualified/excluded according to the requested history meaning; unknown dates/outcomes remain explicit. |
| R29 | “Show everyone's follow-ups this week, grouped by person.” | Reads the appropriate scoped task/owner records, includes relevant task dates/states, and groups by actual assignment. Does not limit the result to leads owned by the acting member or silently omit unassigned tasks. |
| R30 | “Turn this into a detailed action-plan table: launch the site, get feedback, then contact the five interested businesses.” | Builds an action/dependency/purpose table. Proposed owners/deadlines are labeled or left open, rather than invented as commitments. A request to present a plan does not create tasks or change business state. |
| R31 | “Compare a custom website with a template site for this project. Show benefits, tradeoffs, effort and when you'd choose each.” | Creates an analytic comparison with question-specific columns and useful reasoning. Distinguishes estimates/assumptions from supplied facts; does not require a special report tool. |
| R32 | “Make a lead table with offered quote, expected budget, preferred contact method and what we're waiting for.” | Uses the sources that supply the requested columns, not only the five-column lead_overview shape. Missing details stay explicit; the useful existing helper may contribute but cannot silently replace the requested structure. |
| R33 | “First explain what needs attention, then put tasks and quotes in separate detailed tables.” | Composes relevant prose and two tables with different columns in one answer. No forced single report template or duplicate summary paragraphs. |
| R34 | After R27: “Drop the revisions column, add risks, put B first, and explain the second row.” | Refines the same comparison, preserves known facts, orders rows as requested, and explains the second row in the new displayed order. Does not substitute an older brief or a different table. |

## Comparison procedure

Record prompt/schema version, model/endpoint/effort, fixture, complete messages/tool trace, provider rounds, input/output/cache/reasoning tokens where available, time to first useful content and completion. Redact secrets; use local synthetic business state. Keep provider/model/effort constant when comparing prompt/context changes. Start with the known-failure subset (R07/R08/R09/R15/R26) before spending on the entire corpus; for subjective comparisons, repeat a small representative subset and review outputs blind.

Grade each applicable dimension 0 (fails), 1 (usable with an issue), 2 (meets the request): factual grounding, request completeness, relevant context/attribution, useful reasoning, appropriate detail/format, interaction cost, and language/tone. Mark inapplicable dimensions N/A. Separately record binary correctness failures: wrong workspace/subject, invented saved action, unwanted mutation, stale/forgotten fact treated as current, or incomplete result presented as complete. Reject those regardless of stylistic score.

Human review of advice/tone is part of this small comparison. Existing fake-provider suites continue to prove deterministic orchestration. Do not replace them with model-generated judgments, require exact wording, or attach an extra evaluator/rewrite request to every production answer.
