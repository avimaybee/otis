// @ts-expect-error Vite raw SQL import
import sql0 from '../../../migrations/0001_identity.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql1 from '../../../migrations/0002_conversations_sources.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql2 from '../../../migrations/0003_ledger.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql3 from '../../../migrations/0004_lifecycle_settings.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql4 from '../../../migrations/0005_actor_dispatch.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql5 from '../../../migrations/0006_actor_hardening.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql6 from '../../../migrations/0007_outbox_claim_owner.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql7 from '../../../migrations/0008_memory_and_agent_runs.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql8 from '../../../migrations/0009_thinking_controls.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql9 from '../../../migrations/0010_outbox_retry_at.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql10 from '../../../migrations/0011_link_workspace_intent.sql?raw';
export async function applyMigrations(db: D1Database) {
  for (const sql of [sql0, sql1, sql2, sql3, sql4, sql5, sql6, sql7, sql8, sql9, sql10]) {
    let statement = ''; let trigger = false;
    for (const line of sql.split('\n')) {
      if (!line.trim() || line.trim().startsWith('--')) continue;
      statement += line + '\n';
      if (/\bBEGIN\b/i.test(line)) trigger = true;
      if ((trigger && /\bEND;\s*$/i.test(line)) || (!trigger && line.trim().endsWith(';'))) { await db.prepare(statement).run(); statement = ''; trigger = false; }
    }
    if (statement.trim()) await db.prepare(statement).run();
  }
}
