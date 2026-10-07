-- Migration: 0020_quote_text_major_units.sql
-- Quote display text was rendered from integer minor units as though they
-- were major units, so 4000 RON stored as 400000 read back as 400000 RON in
-- entity state and model context. New events format major units in the
-- reducer. This backfill recomputes the display text of existing quote rows
-- from their machine payloads, which always carried correct minor units.
-- Zero-decimal currencies keep the stored amount, all others divide by one
-- hundred with trailing zeros trimmed. Event history is untouched.

UPDATE entity_state
SET value_text =
  CASE
    WHEN UPPER(json_extract(value_json, '$.currency')) IN ('BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF')
    THEN CAST(json_extract(value_json, '$.amount') AS TEXT)
    ELSE TRIM(RTRIM(PRINTF('%.2f', json_extract(value_json, '$.amount') / 100.0), '0'), '.')
  END
  || ' ' || json_extract(value_json, '$.currency')
  || ' (' || json_extract(value_json, '$.role') || ')',
  last_confirmed_value_text =
  CASE
    WHEN UPPER(json_extract(value_json, '$.currency')) IN ('BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF')
    THEN CAST(json_extract(value_json, '$.amount') AS TEXT)
    ELSE TRIM(RTRIM(PRINTF('%.2f', json_extract(value_json, '$.amount') / 100.0), '0'), '.')
  END
  || ' ' || json_extract(value_json, '$.currency')
  || ' (' || json_extract(value_json, '$.role') || ')'
WHERE field_name = 'quote' AND value_json IS NOT NULL;

-- Disputed rows carry no live value but keep a confirmed display snapshot
-- from the same machine payload shape: recompute it from there as well.
UPDATE entity_state
SET last_confirmed_value_text =
  CASE
    WHEN UPPER(json_extract(last_confirmed_value_json, '$.currency')) IN ('BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF')
    THEN CAST(json_extract(last_confirmed_value_json, '$.amount') AS TEXT)
    ELSE TRIM(RTRIM(PRINTF('%.2f', json_extract(last_confirmed_value_json, '$.amount') / 100.0), '0'), '.')
  END
  || ' ' || json_extract(last_confirmed_value_json, '$.currency')
  || ' (' || json_extract(last_confirmed_value_json, '$.role') || ')'
WHERE field_name = 'quote' AND value_json IS NULL AND last_confirmed_value_json IS NOT NULL;
