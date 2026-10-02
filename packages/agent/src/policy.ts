/**
 * @otis/agent/policy
 * Pure policy rules for explicit intent, date/deadline resolution, bulk thresholds,
 * untrusted prompt injection defense, and contradiction handling.
 * In accordance with plans/006-implementation-handoff.md Section 6.
 */

import type { LeadStatus } from '@otis/contracts';

export const MAX_UNCONFIRMED_BULK_ENTITIES = 3;

/**
 * Checks if the source text contains explicit instruction to mutate lead status.
 * Stated interest ("wants website", "interested in offer") is inferred interest,
 * NOT an explicit command to change lead status.
 */
export function isExplicitStatusIntent(
  sourceText: string,
  proposedStatus: LeadStatus,
): { isExplicit: boolean; reason?: string } {
  const lower = sourceText.toLowerCase();

  // Negation pattern (English, Romanian, Hungarian)
  const negationPattern = /\b(do\s+not|don't|dont|never|not|should\s+not|shouldn't|stop|cannot|can't|nu|nem)\b/i;
  if (negationPattern.test(lower)) {
    return {
      isExplicit: false,
      reason: `Source text contains negation ('${lower.match(negationPattern)?.[0]}'). Not an explicit instruction to set status to '${proposedStatus}'.`,
    };
  }

  // Explicit keywords mapped to statuses
  const explicitKeywords: Record<LeadStatus, RegExp[]> = {
    won: [/\b(won|deal won|we won|closed won|signed|deal closed|closed the deal)\b/i],
    lost: [/\b(lost|deal lost|closed lost|rejected us|not interested anymore|dropped us)\b/i],
    cold: [/\b(mark\b.*?\b(as\s+|it\s+)?cold|set\b.*?\b(to\s+|status\s+to\s+)?cold|status\s+is\s+cold|they\s+are\s+cold|they\s+went\s+cold)\b/i],
    warm: [/\b(mark\b.*?\b(as\s+|it\s+)?warm|set\b.*?\b(to\s+|status\s+to\s+)?warm|status\s+is\s+warm|they\s+are\s+warm)\b/i],
    hot: [/\b(mark\b.*?\b(as\s+|it\s+)?hot|set\b.*?\b(to\s+|status\s+to\s+)?hot|status\s+is\s+hot|they\s+are\s+hot)\b/i],
    deprioritized: [/\b(deprioritize|deprioritised|drop them|drop this lead|mark\b.*?\bdeprioritized)\b/i],
    new: [/\b(mark\b.*?\b(as\s+|it\s+)?new|set\b.*?\b(to\s+|status\s+to\s+)?new)\b/i],
  };

  const regexes = explicitKeywords[proposedStatus] || [];
  for (const rx of regexes) {
    if (rx.test(lower)) {
      return { isExplicit: true };
    }
  }

  // Common inferred interest patterns that must NOT be treated as explicit status change
  const inferredPatterns = [
    /\bwants?\b/i,
    /\binterested\b/i,
    /\blikes?\b/i,
    /\basked for\b/i,
    /\bexpected\b/i,
    /\boffered\b/i,
  ];

  for (const rx of inferredPatterns) {
    if (rx.test(lower)) {
      return {
        isExplicit: false,
        reason: `Source text indicates interest or discussion ('${rx.source}'), not an explicit instruction to set status to '${proposedStatus}'. Requires clarification.`,
      };
    }
  }

  return {
    isExplicit: false,
    reason: `No explicit status mutation directive found in source text for status '${proposedStatus}'.`,
  };
}

/**
 * Checks if the source text contains an explicit statement by a member that they sent a message.
 */
export function isExplicitSentConfirmation(sourceText: string): { isConfirmed: boolean; reason?: string } {
  const lower = sourceText.toLowerCase();
  const explicitSentPatterns = [
    /\b(i\s+)?(sent|already\s+sent|just\s+sent|have\s+sent|delivered|emailed|messaged)\b/i,
    /\b(am\s+trimis|trimis|elküldtem|elküldve)\b/i,
  ];
  for (const rx of explicitSentPatterns) {
    if (rx.test(lower)) {
      return { isConfirmed: true };
    }
  }
  return {
    isConfirmed: false,
    reason: 'No source-backed explicit statement that the member sent the message.',
  };
}

/**
 * Checks whether an operation exceeds the bulk operation limit (more than 3 distinct target entities).
 */
export function checkBulkOperationPolicy(
  targetEntityIds: (string | null | undefined)[],
): { allowed: boolean; uniqueEntitiesCount: number; requiresConfirmation: boolean } {
  const distinct = new Set<string>();
  for (const id of targetEntityIds) {
    if (id && typeof id === 'string' && id.trim()) {
      distinct.add(id.trim());
    }
  }

  if (distinct.size > MAX_UNCONFIRMED_BULK_ENTITIES) {
    return {
      allowed: false,
      uniqueEntitiesCount: distinct.size,
      requiresConfirmation: true,
    };
  }

  return {
    allowed: true,
    uniqueEntitiesCount: distinct.size,
    requiresConfirmation: false,
  };
}

/**
 * Evaluates whether untrusted input (forwarded message, customer quote, or stored memory)
 * attempts to execute privileged mutations.
 */
export function checkUntrustedContentPolicy(
  sourceTrust: 'member' | 'forwarded_client' | 'memory',
  toolName: string,
  sourceText?: string,
): { allowed: boolean; violation?: string } {
  // If source is forwarded customer text or memory, mutating tools are blocked
  const mutatingTools = new Set([
    'upsert_entity',
    'rename_entity',
    'set_fields',
    'resolve_conflict',
    'create_task',
    'update_task',
    'draft_message',
    'update_draft',
    'mark_message_sent',
    'remember_context',
    'update_preference',
    'forget_memory',
    'undo',
  ]);

  if (sourceTrust !== 'member' && mutatingTools.has(toolName)) {
    return {
      allowed: false,
      violation: `Tool '${toolName}' cannot be invoked from lower-trust content (${sourceTrust}). Only report capture and read tools are permitted.`,
    };
  }

  // Check for common prompt injection patterns in forwarded text or memory
  if (sourceText) {
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|earlier)\s+instructions/i,
      /you\s+must\s+now/i,
      /system\s+prompt/i,
      /new\s+role/i,
      /grant\s+(me\s+)?admin/i,
      /elevation\s+of\s+privilege/i,
      /mark\s+all\s+(closed|won|lost)/i,
    ];

    for (const rx of injectionPatterns) {
      if (rx.test(sourceText) && mutatingTools.has(toolName)) {
        return {
          allowed: false,
          violation: `Detected untrusted imperative pattern ('${rx.source}') in source text. Mutation blocked.`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Verifies that communication preferences are strictly member-scoped.
 */
export function checkPreferenceScopePolicy(
  actingUserId: string,
  targetUserId?: string | null,
): { allowed: boolean; violation?: string } {
  if (targetUserId && targetUserId !== actingUserId) {
    return {
      allowed: false,
      violation: `Member '${actingUserId}' cannot alter or be bound by preferences for member '${targetUserId}'.`,
    };
  }
  return { allowed: true };
}

/**
 * Validates that an outward draft or task does not present a disputed field as settled fact.
 */
export function checkDisputedFieldPolicy(
  disputedFields: Set<string>,
  proposedField: string,
): { isDisputed: boolean; reason?: string } {
  if (disputedFields.has(proposedField)) {
    return {
      isDisputed: true,
      reason: `Field '${proposedField}' is currently in dispute. It cannot be used as settled content without explicit clarification.`,
    };
  }
  return { isDisputed: false };
}
