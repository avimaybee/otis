/**
 * @otis/agent/policy
 * Pure policy rules for explicit intent, date/deadline resolution, bulk thresholds,
 * untrusted prompt injection defense, and contradiction handling.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 6.
 */

import type { LeadStatus } from '@otis/contracts';

export const MAX_UNCONFIRMED_BULK_ENTITIES = 3;

/**
 * Checks if the source text contains explicit instruction to mutate lead status.
 * Stated interest ("wants website", "interested in offer") is inferred interest,
 * NOT an explicit command to change lead status.
 */
function stripQuotes(text: string): string {
  return text
    .replace(/"[^"\r\n]*"/g, ' ')
    .replace(/[“”][^“”\r\n]*[“”]/g, ' ')
    .replace(/«[^»\r\n]*»/g, ' ')
    .replace(/(?:^|\s)'[^'\r\n]+'(?:\s|$)/g, ' ');
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const NEGATION_PATTERN = /\b(do\s+not|don't|dont|never|not|didn't|didnt|haven't|havent|hasn't|hasnt|won't|wont|cannot|can't|cant|should\s+not|shouldn't|stop|nu|niciodată|nem|soha)\b/i;
const CONDITIONAL_PATTERN = /\b(if|whether|dacă|ha|suppose|assuming|maybe|perhaps|could|would)\b/i;

/**
 * Checks if the source text contains explicit instruction to mutate lead status.
 * Stated interest ("wants website", "interested in offer") is inferred interest,
 * NOT an explicit command to change lead status. Questions, quotes, and conditionals
 * are not explicit commands.
 */
export function isExplicitStatusIntent(
  sourceText: string,
  proposedStatus: LeadStatus,
): { isExplicit: boolean; reason?: string } {
  const unquoted = stripQuotes(sourceText).trim();
  if (!unquoted) {
    return {
      isExplicit: false,
      reason: 'No explicit status mutation directive found in source text.',
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

  // Common inferred interest patterns that must NOT be treated as explicit status change
  const inferredPatterns = [
    /\bwants?\b/i,
    /\binterested\b/i,
    /\blikes?\b/i,
    /\basked for\b/i,
    /\bexpected\b/i,
    /\boffered\b/i,
  ];

  const sentences = splitSentences(unquoted);
  const regexes = explicitKeywords[proposedStatus] || [];

  let foundCandidate = false;
  let rejectedReason: string | undefined;

  for (const sentence of sentences) {
    const sLower = sentence.toLowerCase();
    const matchesKeyword = regexes.some((rx) => rx.test(sLower));
    if (!matchesKeyword) continue;

    foundCandidate = true;

    // Questions are inquiries, not direct mutation instructions
    if (sentence.includes('?') || /^(has|have|did|is|are|will|would|could|can)\s+[a-z0-9_-]+\s+/i.test(sentence)) {
      rejectedReason = 'Source text contains question or inquiry about status, not an explicit instruction.';
      continue;
    }

    // Conditional / hypothetical check
    if (CONDITIONAL_PATTERN.test(sLower)) {
      rejectedReason = 'Source text is conditional or hypothetical, not an explicit instruction.';
      continue;
    }

    // Negation check
    if (NEGATION_PATTERN.test(sLower)) {
      rejectedReason = `Source text contains negation ('${sLower.match(NEGATION_PATTERN)?.[0]}'). Not an explicit instruction to set status to '${proposedStatus}'.`;
      continue;
    }

    // Inferred pattern check within sentence
    const inferred = inferredPatterns.find((rx) => rx.test(sLower));
    if (inferred) {
      rejectedReason = `Source text indicates interest or discussion ('${inferred.source}'), not an explicit instruction to set status to '${proposedStatus}'. Requires clarification.`;
      continue;
    }

    // Valid affirmative instruction
    return { isExplicit: true };
  }

  if (foundCandidate && rejectedReason) {
    return { isExplicit: false, reason: rejectedReason };
  }

  for (const rx of inferredPatterns) {
    if (rx.test(unquoted.toLowerCase())) {
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
 * Phone-like sequences named inside a confirmation. Dates, ISO instants and
 * clock times are stripped first: "sent it on 2026-10-07" names no
 * recipient, while "sent it to +40 711 222 333" does.
 */
const DATE_LIKE_PATTERN = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const PHONE_LIKE_PATTERN = /\+?\d[\d\s\-().]{5,}\d/g;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Checks a send confirmation against the draft's recipient. A confirmation
 * that names a phone-like number which matches neither the draft recipient
 * nor its absence is about a different send: the draft must not be marked
 * sent. Sources naming no number confirm this draft's send.
 *
 * Comparison is digit-exact after stripping separators and leading zeros.
 * Variants that only differ by truncatable prefixes (country code present on
 * one side, leading zero on the other) do not match and clarify instead:
 * asking is always safer than recording the wrong send. Drafts without a
 * comparable recipient (absent, or fewer than 7 digits) accept any
 * confirmation, matching historical behavior.
 */
export function sentConfirmationMatchesTarget(
  sourceText: string,
  draftRecipient: string | null,
): { matches: boolean; reason?: string } {
  if (!draftRecipient || !draftRecipient.trim()) return { matches: true };
  const draftDigits = digitsOnly(draftRecipient).replace(/^0+/, '');
  if (draftDigits.length < 7) return { matches: true };
  const scrubbed = sourceText.replace(DATE_LIKE_PATTERN, ' ');
  const sourceNumbers = new Map<string, string>();
  for (const match of scrubbed.matchAll(PHONE_LIKE_PATTERN)) {
    const digits = digitsOnly(match[0]).replace(/^0+/, '');
    if (digits.length >= 7 && !sourceNumbers.has(digits)) sourceNumbers.set(digits, match[0].trim());
  }
  if (sourceNumbers.size === 0) return { matches: true };
  for (const candidate of sourceNumbers.keys()) {
    if (candidate === draftDigits) return { matches: true };
  }
  return {
    matches: false,
    reason: `The confirmation names ${[...sourceNumbers.values()][0]} but the draft is addressed to ${draftRecipient.trim()}.`,
  };
}

/**
 * Checks if the source text contains an explicit statement by a member that
 * they promise to do something. Only affirmative first-person commitments
 * count; questions, quotes, conditionals, negations, and reported speech
 * about someone else's promise are rejected. Used to rank promised work
 * above ordinary tasks — never to invent obligations.
 */
export function isExplicitPromise(sourceText: string): { isPromise: boolean; reason?: string } {
  const unquoted = stripQuotes(sourceText).trim();
  if (!unquoted) {
    return {
      isPromise: false,
      reason: 'No source-backed explicit promise found.',
    };
  }

  const promisePatterns = [
    /\b(i\s+promise|i\s+promised|i['’]ll\s+promise|promise\s+(to|that)|promised\s+(to|that))\b/i,
    /\b(promit|am\s+promis)\b/i,
    /\b(meg)?ígér\w*/iu,
  ];

  const sentences = splitSentences(unquoted);
  let foundCandidate = false;
  let rejectedReason: string | undefined;

  for (const sentence of sentences) {
    const sLower = sentence.toLowerCase();
    if (!promisePatterns.some((rx) => rx.test(sLower))) continue;

    foundCandidate = true;

    // Questions are inquiries, not commitments
    if (sentence.includes('?') || /^(did|have|has|would|could|can|will)\s+/i.test(sentence)) {
      rejectedReason = 'Source text is a question, not an explicit promise.';
      continue;
    }

    // Conditional / hypothetical check
    if (CONDITIONAL_PATTERN.test(sLower)) {
      rejectedReason = 'Source text is conditional or hypothetical, not an explicit promise.';
      continue;
    }

    // Negation check
    if (NEGATION_PATTERN.test(sLower)) {
      rejectedReason = `Source text contains negation ('${sLower.match(NEGATION_PATTERN)?.[0]}'). Not an explicit promise.`;
      continue;
    }

    return { isPromise: true };
  }

  if (foundCandidate && rejectedReason) {
    return { isPromise: false, reason: rejectedReason };
  }

  return {
    isPromise: false,
    reason: 'No source-backed explicit promise found.',
  };
}

/**
 * Checks if the source text contains an explicit statement by a member that
 * they sent a message. Questions, quotes, conditionals, and negations are
 * rejected; only an explicit member statement confirms.
 */
export function isExplicitSentConfirmation(sourceText: string): { isConfirmed: boolean; reason?: string } {
  const unquoted = stripQuotes(sourceText).trim();
  if (!unquoted) {
    return {
      isConfirmed: false,
      reason: 'No source-backed explicit statement that the member sent the message.',
    };
  }

  const explicitSentPatterns = [
    /\b(i\s+)?(sent|already\s+sent|just\s+sent|have\s+sent|delivered|emailed|messaged)\b/i,
    /\b(am\s+trimis|trimis|elküldtem|elküldve)\b/i,
  ];

  const sentences = splitSentences(unquoted);
  let foundCandidate = false;
  let rejectedReason: string | undefined;

  for (const sentence of sentences) {
    const sLower = sentence.toLowerCase();
    const matchesKeyword = explicitSentPatterns.some((rx) => rx.test(sLower));
    if (!matchesKeyword) continue;

    foundCandidate = true;

    // Questions are inquiries, not confirmed actions
    if (sentence.includes('?') || /^(did|have|has|would|could|can)\s+/i.test(sentence)) {
      rejectedReason = 'Source text is a question, not an explicit confirmation that the message was sent.';
      continue;
    }

    // Conditional / hypothetical check
    if (CONDITIONAL_PATTERN.test(sLower)) {
      rejectedReason = 'Source text is conditional or hypothetical, not a completed send confirmation.';
      continue;
    }

    // Negation check
    if (NEGATION_PATTERN.test(sLower)) {
      rejectedReason = `Source text contains negation ('${sLower.match(NEGATION_PATTERN)?.[0]}'). Message was not confirmed sent.`;
      continue;
    }

    return { isConfirmed: true };
  }

  if (foundCandidate && rejectedReason) {
    return { isConfirmed: false, reason: rejectedReason };
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
    'set_chat_thinking',
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
