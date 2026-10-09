-- Canonical messages remain the source. FTS is disposable, scoped acceleration.
CREATE VIRTUAL TABLE chat_message_fts USING fts5(scope_token, body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE conversation_search_backfill (id INTEGER PRIMARY KEY CHECK(id = 1), after_rowid INTEGER NOT NULL DEFAULT 0);
INSERT INTO conversation_search_backfill (id, after_rowid) VALUES (1, 0);
CREATE TRIGGER chat_message_search_insert AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_message_fts(rowid, scope_token, body) VALUES (new.rowid, 'w' || hex(new.workspace_id), COALESCE(new.content_text, ''));
END;
CREATE TRIGGER chat_message_search_delete AFTER DELETE ON chat_messages BEGIN
  DELETE FROM chat_message_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER chat_message_search_update AFTER UPDATE OF content_text, workspace_id ON chat_messages BEGIN
  DELETE FROM chat_message_fts WHERE rowid = old.rowid;
  INSERT INTO chat_message_fts(rowid, scope_token, body) VALUES (new.rowid, 'w' || hex(new.workspace_id), COALESCE(new.content_text, ''));
END;
