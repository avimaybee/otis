/**
 * @otis/ledger/commands/similarity
 * Duplicate and near-duplicate entity name matching.
 */

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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

export function findPotentialDuplicate(
  newName: string,
  existingNames: { id: string; name: string }[],
): { exactMatch?: { id: string; name: string }; nearDuplicate?: { id: string; name: string } } {
  const normNew = normalizeName(newName);

  for (const existing of existingNames) {
    const normExisting = normalizeName(existing.name);
    if (normNew === normExisting) {
      return { exactMatch: existing };
    }
    // Check edit distance or substring inclusion for near-duplicates
    const dist = levenshteinDistance(normNew, normExisting);
    if (dist > 0 && dist <= 2) {
      return { nearDuplicate: existing };
    }
    if (normNew.length >= 4 && normExisting.length >= 4) {
      if (normNew.includes(normExisting) || normExisting.includes(normNew)) {
        return { nearDuplicate: existing };
      }
    }
  }

  return {};
}
