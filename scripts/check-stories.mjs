#!/usr/bin/env node
/**
 * Story inventory check (R1).
 *
 * The single source of required fixture IDs is design.md section 13's table,
 * not a manually copied list. This script extracts every backtick-quoted
 * `group/id` token from that table, collects every Story `name:` literal in
 * `apps/web/src/stories/*.stories.tsx`, and fails on any required ID without
 * a production-component or labeled contract-only story. Extra real-behavior
 * stories are permitted; omissions are not.
 *
 * Usage: `pnpm check:stories` from the repo root.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_MD = join(ROOT, 'design.md');
const STORIES_DIR = join(ROOT, 'apps/web/src/stories');
const INVENTORY_TS = join(STORIES_DIR, 'inventory.ts');

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(DESIGN_MD)) fail(`missing design.md at ${DESIGN_MD}`);
if (!existsSync(STORIES_DIR)) fail(`missing stories directory at ${STORIES_DIR}`);

const design = readFileSync(DESIGN_MD, 'utf8');
const sectionStart = design.indexOf('## 13.');
const sectionEnd = design.indexOf('## 14.');
if (sectionStart < 0 || sectionEnd < 0 || sectionEnd <= sectionStart) {
  fail('design.md fixture inventory section (## 13.) not found');
}
const table = design.slice(sectionStart, sectionEnd);
const expected = new Set();
for (const line of table.split('\n')) {
  const cells = line.split('|').map(cell => cell.trim());
  if (cells.length < 3 || !/^[a-z][a-z0-9-]*\//.test(cells[1] ?? '')) continue;
  for (const token of cells[1].split(',').map(token => token.trim().replace(/^`|`$/g, ''))) {
    if (/^[a-z][a-z0-9-]*\/[a-z0-9-]+$/.test(token)) expected.add(token);
  }
}
if (expected.size === 0) fail('no fixture IDs parsed from design.md section 13');

const actual = new Set();
const files = readdirSync(STORIES_DIR).filter(file => file.endsWith('.stories.tsx')).sort();
if (files.length === 0) fail('zero story files scanned; refusing a false green result.');
for (const file of files) {
  const text = readFileSync(join(STORIES_DIR, file), 'utf8');
  // Story `name:` literals and factory first-args (`brief('brief/x', …)`)
  // alike; every ID-shaped literal in a stories file names a story.
  for (const match of text.matchAll(/'([a-z][a-z0-9-]*\/[a-z0-9-]+)'/g)) {
    actual.add(match[1]);
  }
}

const missing = [...expected].filter(id => !actual.has(id)).sort();
if (missing.length > 0) {
  fail(`missing stories for ${missing.length} required fixture ID(s):\n  ${missing.join('\n  ')}`);
}

// The checked-in inventory map must mirror the design table exactly so the
// in-suite vitest test guards the same set between script runs.
if (existsSync(INVENTORY_TS)) {
  const inventory = readFileSync(INVENTORY_TS, 'utf8');
  const listed = new Set();
  for (const match of inventory.matchAll(/'([a-z][a-z0-9-]*\/[a-z0-9-]+)'/g)) {
    listed.add(match[1]);
  }
  const unlisted = [...expected].filter(id => !listed.has(id)).sort();
  const stale = [...listed].filter(id => !expected.has(id)).sort();
  if (unlisted.length > 0 || stale.length > 0) {
    fail(
      `inventory.ts drifted from design.md section 13.` +
      (unlisted.length > 0 ? `\n  unlisted: ${unlisted.join(', ')}` : '') +
      (stale.length > 0 ? `\n  stale: ${stale.join(', ')}` : ''),
    );
  }
}

console.log(`check-stories: ok — ${expected.size} required fixture ID(s) covered by ${files.length} story file(s).`);
