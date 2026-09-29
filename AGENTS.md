# Instructions for AI Agents Working on Daybook

Welcome. Before making any code or design changes in this repository, you must read and adhere to these guidelines.

---

## 1. Source of Truth

- **Product & Business Logic:** Read [product.md](product.md) before implementing features.
- **Design & Layout:** Read [design.md](design.md) before creating or modifying UI components.
- **Execution Plans:** Check [plans/README.md](plans/README.md) and execute the assigned plan in sequential order. Do not skip ahead or implement unapproved features.

---

## 2. Hard Invariants

1. **The Ledger is the Sole Writer of Business State:**
   - The `events` table is append-only. Never run `UPDATE` or `DELETE` on `events`.
   - `entity_state` and `tasks` are deterministic projections derived from `events`.
   - Undo appends a `revert` event pointing to the target event; it never deletes historical rows.
2. **Workspace Scope:**
   - Every business query, ledger mutation, and tool call must be explicitly scoped by `workspace_id`.
   - The repository layer must refuse workspace-data access without an authenticated `workspace_id`.
   - Never leak data or preferences across workspace boundaries.
3. **No LLM in Deterministic Logic:**
   - Authentication, permissions, date parsing/resolution, selection algorithms, and morning brief generation must be plain TypeScript code.
   - LLMs interpret language, draft text, and propose tool calls.
4. **Outward Actions are Drafts Only:**
   - The agent never autonomously sends a message or email to a third party.
5. **No Secret Leakage:**
   - Secrets belong exclusively in Cloudflare Worker secrets or local `.env`. Never commit credentials or expose them in client responses or prompts.

---

## 3. Verification Protocol

Before declaring any task or plan step complete, ensure all baseline verification commands exit with code 0:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Do not claim a command has passed without running it.
