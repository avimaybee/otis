-- C1 repair: retain explicit quote decisions and canonical projection snapshots.
-- Event bodies and applied migrations stay unchanged; this metadata rebuilds from events.
ALTER TABLE entity_state ADD COLUMN quote_authority_json TEXT;

UPDATE interaction_state
SET head_value_json = CASE WHEN json_type(head_value_json, '$.amount') IN ('integer', 'real')
  AND json_type(head_value_json, '$.currency') = 'text' AND json_type(head_value_json, '$.role') = 'text' THEN json_object(
  'amount', json_extract(head_value_json, '$.amount'),
  'currency', json_extract(head_value_json, '$.currency'),
  'role', json_extract(head_value_json, '$.role')
) ELSE NULL END
WHERE kind = 'quote' AND head_value_json IS NOT NULL;

UPDATE interaction_state
SET occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
WHERE strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL
  AND strftime('%Y-%m-%d', substr(occurred_at, 1, 19)) = substr(occurred_at, 1, 10)
  AND (occurred_at GLOB '????-??-??T??:??:??*Z' OR (
    occurred_at GLOB '????-??-??T??:??:??*' AND substr(occurred_at, -6, 1) IN ('+', '-')
  ));

WITH active AS (
  SELECT e.* FROM events e
  WHERE e.kind != 'revert' AND NOT EXISTS (
    SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
      AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id)
  )
), decisions AS (
  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY workspace_id, entity_id ORDER BY sequence DESC) AS decision_rank
  FROM active e
  WHERE json_extract(payload_json, '$.field_name') = 'quote'
    AND (kind = 'conflict_resolved' OR (kind = 'field_change' AND (
      supersedes_event_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM entity_state f WHERE f.workspace_id = e.workspace_id
          AND f.entity_id = e.entity_id AND f.source_event_id = e.id
      )
    )))
), heads AS (
  SELECT d.id AS decision_id, q.*, COALESCE(json_extract(q.payload_json, '$.interaction_id'), q.id) AS root,
    ROW_NUMBER() OVER (
      PARTITION BY d.id, COALESCE(json_extract(q.payload_json, '$.interaction_id'), q.id)
      ORDER BY q.sequence DESC
    ) AS head_rank
  FROM decisions d JOIN active q ON q.workspace_id = d.workspace_id AND q.entity_id = d.entity_id
    AND q.kind = 'quote' AND q.sequence < d.sequence
  WHERE d.decision_rank = 1 AND NOT EXISTS (
    SELECT 1 FROM active removal WHERE removal.workspace_id = q.workspace_id
      AND removal.kind = 'interaction_removed' AND removal.sequence < d.sequence
      AND json_extract(removal.payload_json, '$.root_event_id') = COALESCE(json_extract(q.payload_json, '$.interaction_id'), q.id)
  )
)
UPDATE entity_state AS f
SET quote_authority_json = (
  SELECT json_object(
    'event_id', d.id,
    'value_text', CASE WHEN json_type(d.payload_json, CASE WHEN d.kind = 'conflict_resolved' THEN '$.resolved_value' ELSE '$.new_value' END) IN ('object', 'array') THEN NULL
      ELSE CAST(json_extract(d.payload_json, CASE WHEN d.kind = 'conflict_resolved' THEN '$.resolved_value' ELSE '$.new_value' END) AS TEXT) END,
    'value_json', CASE WHEN json_type(d.payload_json, CASE WHEN d.kind = 'conflict_resolved' THEN '$.resolved_value' ELSE '$.new_value' END) IN ('object', 'array')
      THEN json_extract(d.payload_json, CASE WHEN d.kind = 'conflict_resolved' THEN '$.resolved_value' ELSE '$.new_value' END) || '' ELSE NULL END,
    'provenance', CASE WHEN d.kind = 'conflict_resolved' THEN 'stated' ELSE d.provenance END,
    'covered', json(COALESCE((SELECT json_group_object(root, json_object(
      'amount', json_extract(payload_json, '$.amount'), 'currency', json_extract(payload_json, '$.currency'), 'role', json_extract(payload_json, '$.role')
    ) || '') FROM (SELECT root, payload_json FROM heads
      WHERE decision_id = d.id AND head_rank = 1 ORDER BY root)), '{}'))
  ) FROM decisions d WHERE d.workspace_id = f.workspace_id AND d.entity_id = f.entity_id AND d.decision_rank = 1
)
WHERE field_name = 'quote';

-- Preserve unresolved field reports alongside interaction roots, including legacy disputes.
UPDATE entity_state AS f
SET quote_authority_json = json_set(COALESCE(quote_authority_json,
  '{"event_id":null,"value_text":null,"value_json":null,"provenance":"stated","covered":{}}'),
  '$.pending_claims', json((SELECT json_group_array(json_object(
    'id', e.id, 'sequence', e.sequence,
    'text', CASE WHEN json_type(e.payload_json, '$.new_value') IN ('object', 'array') THEN NULL ELSE CAST(json_extract(e.payload_json, '$.new_value') AS TEXT) END,
    'json', CASE WHEN json_type(e.payload_json, '$.new_value') IN ('object', 'array') THEN json_extract(e.payload_json, '$.new_value') || '' ELSE NULL END
  )) FROM (SELECT e.* FROM events e WHERE e.workspace_id = f.workspace_id AND e.kind = 'field_change'
    AND e.id IN (SELECT value FROM json_each(f.candidate_event_ids_json))
    AND NOT EXISTS (SELECT 1 FROM events r WHERE r.workspace_id = e.workspace_id AND r.kind = 'revert'
      AND (r.reverts_event_id = e.id OR json_extract(r.payload_json, '$.target_event_id') = e.id))
    AND e.sequence > COALESCE((SELECT sequence FROM events a WHERE a.workspace_id = f.workspace_id
      AND a.id = json_extract(f.quote_authority_json, '$.event_id')), -1)
    ORDER BY e.sequence
  ) e)))
WHERE field_name = 'quote' AND EXISTS (
  SELECT 1 FROM events e WHERE e.workspace_id = f.workspace_id AND e.kind = 'field_change'
    AND e.id IN (SELECT value FROM json_each(f.candidate_event_ids_json))
);

CREATE INDEX idx_interaction_current ON interaction_state(workspace_id, state, sequence DESC);
