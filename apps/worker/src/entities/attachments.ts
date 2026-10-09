/** Metadata only. Composite bookmarks retain every image in a multi-photo message. */
export async function readChatAttachments(
  db: D1Database,
  workspace: string,
  user: string,
  chat: string,
  options: {
    limit?: number;
    cursor?: string;
    text?: string;
    kind?: string;
    from?: string;
    to?: string;
  },
) {
  const limit = options.limit ?? 25,
    scope = JSON.stringify([
      workspace,
      user,
      chat,
      options.text,
      options.kind,
      options.from,
      options.to,
    ]);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (options.cursor && options.cursor.length > 2000)
  )
    throw new Error('Choose a valid file page size and bookmark.');
  if (options.text && new TextEncoder().encode(options.text).byteLength > 48)
    throw new Error('Use a shorter phrase to filter attachment messages.');
  let after: [number, number, string] | null = null;
  if (options.cursor) {
    try {
      const c = JSON.parse(atob(options.cursor));
      if (
        c.scope !== scope ||
        !Array.isArray(c.after) ||
        c.after.length !== 3 ||
        !Number.isSafeInteger(c.after[0]) ||
        !Number.isSafeInteger(c.after[1]) ||
        typeof c.after[2] !== 'string'
      )
        throw new Error();
      after = c.after;
    } catch {
      throw new Error('This attachment page is invalid.');
    }
  }
  const predicates = [
    'a.workspace_id = ?',
    'cm.workspace_id = a.workspace_id',
    'm.workspace_id = a.workspace_id',
    'cm.chat_id = ?',
    'EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = a.workspace_id AND user_id = ?)',
  ];
  const binds: unknown[] = [workspace, chat, user];
  if (options.text) {
    predicates.push('cm.content_text LIKE ?');
    binds.push(`%${options.text}%`);
  }
  if (options.kind) {
    predicates.push('m.format LIKE ?');
    binds.push(`${options.kind}/%`);
  }
  if (options.from) {
    predicates.push('m.created_at >= ?');
    binds.push(options.from);
  }
  if (options.to) {
    predicates.push('m.created_at < ?');
    binds.push(options.to);
  }
  const from = `FROM message_image_attachments a JOIN chat_messages cm ON cm.id = a.chat_message_id JOIN media_objects m ON m.id = a.media_id WHERE ${predicates.join(' AND ')}`;
  const results = await db.batch([
    db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(...binds),
    db
      .prepare(
        `SELECT a.media_id, a.chat_message_id, cm.sequence, a.position, m.format, m.created_at, m.state, m.expires_at, m.retained, SUBSTR(cm.content_text, 1, 160) AS excerpt ${from}
      ${after ? 'AND (-cm.sequence, a.position, a.media_id) > (?, ?, ?)' : ''} ORDER BY cm.sequence DESC, a.position, a.media_id LIMIT ?`,
      )
      .bind(...binds, ...(after ? [-after[0], after[1], after[2]] : []), limit + 1),
  ]);
  const found = results[1]!.results as Record<string, unknown>[],
    last = found[Math.min(limit, found.length) - 1],
    more = found.length > limit;
  return {
    rows: found.slice(0, limit),
    total: Number((results[0]!.results![0]! as { total: number }).total),
    has_more: more,
    next_cursor: more
      ? btoa(JSON.stringify({ scope, after: [last!.sequence, last!.position, last!.media_id] }))
      : null,
  };
}
