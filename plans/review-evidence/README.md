# Gate 006 review evidence

Round 2 adds `006-repair-agent.repro.test.ts` and `006-repair-memory.repro.test.ts`, containing seven additional bad-behavior assertions. See [the round 2 report](../006-review-round2.md). Run just that pass with:

```powershell
pnpm exec vitest run --config plans/review-evidence/006-review.config.ts plans/review-evidence/006-repair-agent.repro.test.ts plans/review-evidence/006-repair-memory.repro.test.ts
```

Original probes below are historical: repaired behavior can make them fail. Do not interpret a combined run of old and new probes as an acceptance suite.

These are review-only **bug reproductions**, authored independently on 2026-10-02. They intentionally assert the current incorrect behavior. Their 14 passing tests confirm the defects; they do not make Gate 006 acceptable.

Run from repository root:

```powershell
$env:TEMP='D:\wtmp'
$env:TMP='D:\wtmp'
pnpm exec vitest run --config plans/review-evidence/006-review.config.ts
```

The probes use migrated local D1, fake providers and mock transport. No live provider inference is needed. The completed-phase recovery probe deliberately interrupts repeated status reads to demonstrate the loop without hanging the test runner indefinitely.

See [the review contract](../006-review-followup.md) for impact, references and required repairs. Implementation agents should transplant each scenario into the normal owning test suite with **desired-behavior assertions**, then fix the implementation. The original repro may cease passing after its bug is corrected; keep that distinction explicit. Do not change the normal regression to expect defective behavior or count these probes as new acceptance tests.

The fixture seed code follows the existing Worker integration suites. These files are outside the normal root test include paths and are not production code.
