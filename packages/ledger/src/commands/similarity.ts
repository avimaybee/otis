/**
 * @otis/ledger/commands/similarity
 * Duplicate and near-duplicate entity name matching with Unicode normalization,
 * Romanian/Hungarian diacritics handling, and candidate ranking.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 5.
 */

export const MATCH_MIN_SCORE = 0.85;
export const MATCH_MIN_MARGIN = 0.10;

/**
 * Strips diacritics and accents using Unicode NFKD normalization.
 * E.g. "Ștefan" -> "stefan", "Kávézó" -> "kavezo".
 */
export function foldDiacritics(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Normalizes text for matching by folding diacritics and stripping non-alphanumeric chars.
 */
export function normalizeName(name: string): string {
  return foldDiacritics(name).replace(/[^a-z0-9]/g, '');
}

/**
 * Case-folded, trimmed string preserving diacritics.
 */
export function canonicalCaseFold(text: string): string {
  return text.trim().toLowerCase();
}

export function levenshteinDistance(a: string, b: string): number {
  const an = a.length;
  const bn = b.length;
  if (an === 0) return bn;
  if (bn === 0) return an;

  const matrix: number[][] = [];
  for (let i = 0; i <= bn; i++) matrix[i] = [i];
  for (let j = 0; j <= an; j++) matrix[0]![j] = j;

  for (let i = 1; i <= bn; i++) {
    for (let j = 1; j <= an; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1, // substitution
          Math.min(
            matrix[i]![j - 1]! + 1, // insertion
            matrix[i - 1]![j]! + 1, // deletion
          ),
        );
      }
    }
  }

  return matrix[bn]![an]!;
}

export interface EntityMatchCandidate {
  id: string;
  name: string;
  score: number;
  isExact: boolean;
  isAlias: boolean;
  isAccentFolded: boolean;
  matchedAlias?: string;
}

export interface EntityMatchResult {
  candidates: EntityMatchCandidate[];
  bestMatch?: EntityMatchCandidate;
  isAmbiguous: boolean;
  ambiguityReason?: 'accent_fold_collision' | 'score_margin_too_close' | 'multiple_exact_matches';
}

/**
 * Computes a string similarity score in range [0, 1].
 */
export function computeSimilarityScore(a: string, b: string): number {
  const normA = normalizeName(a);
  const normB = normalizeName(b);
  if (normA === normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const maxLen = Math.max(normA.length, normB.length);
  const dist = levenshteinDistance(normA, normB);
  const editScore = 1.0 - dist / maxLen;

  // Word token match bonus for multi-word leads (e.g. "thai" in "Thai Shop" and "Thai Garden")
  const wordsA = foldDiacritics(a).split(/\s+/).filter(Boolean);
  const wordsB = foldDiacritics(b).split(/\s+/).filter(Boolean);
  let wordScore = 0;
  if (wordsA.some((wa) => wordsB.some((wb) => wa === wb || (wa.length >= 4 && (wb.startsWith(wa) || wa.startsWith(wb)))))) {
    wordScore = 0.85;
  }

  // Substring inclusion bonus for multi-word leads
  let subScore = 0;
  if (normA.length >= 4 && normB.length >= 4) {
    if (normA.includes(normB) || normB.includes(normA)) {
      subScore = Math.min(normA.length, normB.length) / maxLen;
    }
  }

  return Math.max(editScore, subScore, wordScore);
}

/**
 * Matches an entity query against existing entities and aliases.
 * Collects and ranks ALL candidates, preserving order-independence.
 */
export function rankEntityMatches(
  query: string,
  entities: Array<{ id: string; name: string }>,
  aliases?: Array<{ id: string; entity_id: string; alias: string }>,
): EntityMatchResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { candidates: [], isAmbiguous: false };
  }

  const queryExactFold = canonicalCaseFold(trimmedQuery);
  const queryDiacriticFold = foldDiacritics(trimmedQuery);
  const queryNorm = normalizeName(trimmedQuery);

  const candidateMap = new Map<string, EntityMatchCandidate>();

  for (const entity of entities) {
    const entityExactFold = canonicalCaseFold(entity.name);
    const entityDiacriticFold = foldDiacritics(entity.name);
    const entityNorm = normalizeName(entity.name);

    let score = 0;
    let isExact = false;
    let isAccentFolded = false;

    if (queryExactFold === entityExactFold) {
      score = 1.0;
      isExact = true;
    } else if (queryDiacriticFold === entityDiacriticFold) {
      score = 0.95;
      isAccentFolded = true;
    } else {
      score = computeSimilarityScore(queryNorm, entityNorm);
    }

    if (score >= 0.5) {
      candidateMap.set(entity.id, {
        id: entity.id,
        name: entity.name,
        score,
        isExact,
        isAlias: false,
        isAccentFolded,
      });
    }
  }

  // Check aliases if supplied
  if (aliases) {
    for (const alias of aliases) {
      const aliasExactFold = canonicalCaseFold(alias.alias);
      const aliasDiacriticFold = foldDiacritics(alias.alias);
      const aliasNorm = normalizeName(alias.alias);

      let score = 0;
      let isExact = false;
      let isAccentFolded = false;

      if (queryExactFold === aliasExactFold) {
        score = 1.0;
        isExact = true;
      } else if (queryDiacriticFold === aliasDiacriticFold) {
        score = 0.95;
        isAccentFolded = true;
      } else {
        score = computeSimilarityScore(queryNorm, aliasNorm);
      }

      if (score >= 0.5) {
        const existing = candidateMap.get(alias.entity_id);
        if (!existing || score > existing.score) {
          const parentEntity = entities.find((e) => e.id === alias.entity_id);
          candidateMap.set(alias.entity_id, {
            id: alias.entity_id,
            name: parentEntity?.name || alias.alias,
            score,
            isExact,
            isAlias: true,
            isAccentFolded,
            matchedAlias: alias.alias,
          });
        }
      }
    }
  }

  // Sort candidates deterministically:
  // 1. score descending
  // 2. isExact descending
  // 3. isAccentFolded descending
  // 4. entity ID ascending (order-independence tie breaker)
  const ranked = Array.from(candidateMap.values()).sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.0001) return b.score - a.score;
    if (a.isExact !== b.isExact) return a.isExact ? -1 : 1;
    if (a.isAccentFolded !== b.isAccentFolded) return a.isAccentFolded ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  if (ranked.length === 0) {
    return { candidates: [], isAmbiguous: false };
  }

  const best = ranked[0]!;
  const runnerUp = ranked[1];

  // 1. Check multiple exact matches
  const exactMatches = ranked.filter((c) => c.isExact);
  if (exactMatches.length > 1) {
    return {
      candidates: ranked,
      bestMatch: undefined,
      isAmbiguous: true,
      ambiguityReason: 'multiple_exact_matches',
    };
  }

  // 2. Check accent fold collision: two different entities share the same accent-folded query
  const accentMatches = ranked.filter((c) => c.isAccentFolded);
  if (accentMatches.length > 1) {
    return {
      candidates: ranked,
      bestMatch: undefined,
      isAmbiguous: true,
      ambiguityReason: 'accent_fold_collision',
    };
  }

  // 3. Check fuzzy score margin
  if (runnerUp && best.score >= MATCH_MIN_SCORE && !best.isExact) {
    if (best.score - runnerUp.score < MATCH_MIN_MARGIN) {
      return {
        candidates: ranked,
        bestMatch: undefined,
        isAmbiguous: true,
        ambiguityReason: 'score_margin_too_close',
      };
    }
  }

  const isEligible = best.score >= MATCH_MIN_SCORE || best.isExact;
  return {
    candidates: ranked,
    bestMatch: isEligible ? best : undefined,
    isAmbiguous: false,
  };
}

/**
 * Backward-compatible helper for entity creation duplicate checks.
 */
export function findPotentialDuplicate(
  newName: string,
  existingNames: { id: string; name: string }[],
): { exactMatch?: { id: string; name: string }; nearDuplicate?: { id: string; name: string } } {
  const result = rankEntityMatches(newName, existingNames);
  if (result.bestMatch?.isExact) {
    return { exactMatch: { id: result.bestMatch.id, name: result.bestMatch.name } };
  }
  if (result.bestMatch && result.bestMatch.score >= MATCH_MIN_SCORE) {
    return { nearDuplicate: { id: result.bestMatch.id, name: result.bestMatch.name } };
  }
  // Check runner-up / candidates for near duplicate
  if (result.candidates.length > 0 && result.candidates[0]!.score >= 0.75) {
    const top = result.candidates[0]!;
    return { nearDuplicate: { id: top.id, name: top.name } };
  }
  return {};
}
