-- Migration: 0032_document_request_fingerprint.sql
-- Durable request identity for generated-document authoring: the hash of the
-- immutable start request (document, title, intended sections) travels with
-- the revision row, so an identical retry replays exactly while a reused
-- identity with different content is rejected instead of accepted.

ALTER TABLE document_revisions ADD COLUMN request_fingerprint TEXT;
