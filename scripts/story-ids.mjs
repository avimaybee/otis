/**
 * Single parser for design.md section 13's fixture table, shared by
 * scripts/check-stories.mjs (node) and the in-suite inventory test.
 * The design table — never a copied list — is the source of required IDs.
 */

export function extractFixtureIds(markdown) {
  const sectionStart = markdown.indexOf('## 13.');
  const sectionEnd = markdown.indexOf('## 14.');
  if (sectionStart < 0 || sectionEnd < 0 || sectionEnd <= sectionStart) {
    throw new Error('design.md fixture inventory section (## 13.) not found');
  }
  const table = markdown.slice(sectionStart, sectionEnd);
  const ids = new Set();
  for (const line of table.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 3 || !/^[a-z][a-z0-9-]*\//.test(cells[1] ?? '')) continue;
    for (const token of cells[1].split(',').map(token => token.trim().replace(/^`|`$/g, ''))) {
      if (/^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(token)) ids.add(token);
    }
  }
  return [...ids].sort();
}
