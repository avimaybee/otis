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
// @ts-expect-error Vite raw SQL import
import sql11 from '../../../migrations/0012_voice_media.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql12 from '../../../migrations/0013_briefs.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql13 from '../../../migrations/0014_media_images.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql14 from '../../../migrations/0015_message_image_attachments.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql15 from '../../../migrations/0016_brief_next_due.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql16 from '../../../migrations/0017_task_markers.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql17 from '../../../migrations/0018_reminders.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql18 from '../../../migrations/0019_workspace_erasures.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql19 from '../../../migrations/0020_quote_text_major_units.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql20 from '../../../migrations/0021_entity_deleted_kind.sql?raw';
// @ts-expect-error Vite raw SQL import
import sql21 from '../../../migrations/0022_member_interpretation_timezone.sql?raw';
export async function applyMigrationSql(db: D1Database, sql: string) {
  let statement = ''; let trigger = false;
  const run = async (stmt: string) => { await db.prepare(stmt).run(); };
  for (const line of sql.split('\n')) {
    if (!line.trim() || line.trim().startsWith('--')) continue;
    statement += line + '\n';
    if (/\bBEGIN\b/i.test(line)) trigger = true;
    if ((trigger && /\bEND;\s*$/i.test(line)) || (!trigger && line.trim().endsWith(';'))) { await run(statement); statement = ''; trigger = false; }
  }
  if (statement.trim()) await run(statement);
}
export async function applyMigrations(db: D1Database) {
  for (const sql of [sql0, sql1, sql2, sql3, sql4, sql5, sql6, sql7, sql8, sql9, sql10, sql11, sql12, sql13, sql14, sql15, sql16, sql17, sql18, sql19, sql20, sql21]) {
    await applyMigrationSql(db, sql);
  }
}
