import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import console from 'node:console';

const root = process.cwd();
const excluded = new Set(['node_modules', '.git', '.agents', '.wrangler', 'dist', 'dist-worker', 'storybook-static', 'coverage', '.turbo']);
function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || excluded.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : /\.mdx?$/i.test(entry.name) ? [target] : [];
  });
}
const relative = filename => path.relative(root, filename).replaceAll('\\', '/');
const files = walk(root).sort();
const inventory = files.map(filename => {
  const content = fs.readFileSync(filename, 'utf8');
  const lines = content.split(/\r?\n/);
  const references = [...new Set(content.match(/(?:apps|packages|migrations|scripts)\/[\w./-]+\.(?:tsx?|sql|mjs|json|jsonc|sh)/g) ?? [])];
  let fenced = false;
  const claims = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /\b(must|required|acceptance|implemented|done|todo|unverified|missing|supersed|not built|review pending|stop condition)\b/i.test(line)) claims.push({ line: index + 1, text: line });
  }
  return {
    path: relative(filename), lines: lines.length, chars: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    headings: lines.filter(line => /^#{1,4} /.test(line)), claims,
    source_references: references,
    missing_literal_source_references: references.filter(reference => !fs.existsSync(path.join(root, reference))),
  };
});
const mode = process.argv[2] ?? 'inventory';
if (mode === 'inventory') {
  fs.writeFileSync(path.join(root, 'plans/qa/2026-10-07-docs-inventory.json'), JSON.stringify({ baseline: process.argv[3] ?? null, files: inventory }, null, 2) + '\n');
  console.log(JSON.stringify({ files: inventory.length, lines: inventory.reduce((sum, doc) => sum + doc.lines, 0), chars: inventory.reduce((sum, doc) => sum + doc.chars, 0) }));
  for (const doc of inventory) console.log(`${doc.path}\t${doc.lines} lines\t${doc.headings.slice(0, 3).join(' / ')}`);
} else if (mode === 'digest') {
  const prefix = process.argv[3] ?? '';
  for (const doc of inventory.filter(doc => doc.path.startsWith(prefix))) {
    console.log(`\n${doc.path} (${doc.lines} lines)`);
    console.log(doc.headings.slice(0, 8).join(' | '));
    console.log(doc.claims.slice(0, 5).map(claim => `${claim.line}: ${claim.text.slice(0, 220)}`).join('\n'));
    if (doc.missing_literal_source_references.length) console.log(`Unresolved literal source refs: ${doc.missing_literal_source_references.join(', ')}`);
  }
} else if (mode === 'prepare-cleanup') {
  const before = JSON.parse(fs.readFileSync(path.join(root, 'plans/qa/2026-10-07-docs-inventory.json'), 'utf8'));
  const retained = new Set(['README.md', 'AGENTS.md', 'product.md', 'architecture.md', 'design.md', 'design-tokens.md', 'docs/contracts.md', 'docs/decisions.md', 'docs/verification.md', 'docs/status.md', 'plans/README.md', 'plans/qa/2026-10-07-agent-response-cases.md', 'docs/005-live-provider-evidence.md']);
  const refreshed = new Set(['README.md', 'AGENTS.md', 'product.md', 'architecture.md', 'docs/contracts.md', 'docs/decisions.md', 'docs/verification.md', 'plans/README.md']);
  const evidence = {
    identity: ['packages/identity/src', 'apps/worker/test/auth.integration.test.ts', 'apps/worker/test/lifecycle.integration.test.ts'],
    ledger: ['packages/ledger/src', 'apps/worker/test/ledger.integration.test.ts', 'apps/worker/test/ledger-footprint.integration.test.ts'],
    conversation: ['apps/worker/src/inbox/repository.ts', 'apps/worker/src/actor/dispatch.ts', 'apps/worker/test/conversations.integration.test.ts', 'apps/worker/test/actor.integration.test.ts'],
    providers: ['packages/agent/src/providers', 'apps/worker/src/providers/service.ts', 'packages/agent/test/provider-registry.test.ts'],
    responses: ['packages/agent/src/prompt.ts', 'apps/worker/src/agent/context.ts', 'apps/worker/src/agent/repository.ts', 'apps/worker/test/agent-tools.integration.test.ts'],
    api: ['apps/worker/src/index.ts', 'apps/worker/src/routes', 'apps/worker/test/chat-api.integration.test.ts'],
    ui: ['apps/web/src', 'scripts/check-design.mjs', 'scripts/check-stories.mjs', 'apps/web/test/conversation.test.tsx'],
    telegram: ['apps/worker/src/inbox/telegram.ts', 'apps/worker/src/inbox/telegramDelivery.ts', 'apps/worker/test/telegram-text.integration.test.ts'],
    voice: ['apps/worker/src/media', 'apps/web/src/api/voiceSessions.ts', 'apps/worker/test/voice-media.integration.test.ts'],
    briefs: ['apps/worker/src/brief', 'apps/worker/test/brief.integration.test.ts', 'packages/brief/test/schedule.test.ts'],
    exports: ['packages/sheet/src/index.ts', 'packages/commands/src/registry.ts', 'packages/identity/src/workspace.ts'],
    performance: ['apps/worker/src/dispatchHint.ts', 'apps/worker/src/chat/stream.ts', 'apps/worker/src/agent/streamPublish.ts', 'apps/worker/test/d1-economics.integration.test.ts'],
    release: ['wrangler.jsonc', 'package.json', 'migrations', 'plans/qa/2026-10-07-docs-tests.json'],
  };
  function area(filename) {
    if (/image-context/.test(filename)) return 'voice';
    if (/latency|efficiency|014-|015/.test(filename)) return 'performance';
    if (/telegram|009/.test(filename)) return 'telegram';
    if (/provider|005|thinking-controls/.test(filename)) return 'providers';
    if (/voice|010/.test(filename)) return 'voice';
    if (/brief|011/.test(filename)) return 'briefs';
    if (/drafts-sheet|012/.test(filename)) return 'exports';
    if (/003/.test(filename)) return 'identity';
    if (/002/.test(filename)) return 'ledger';
    if (/004/.test(filename)) return 'conversation';
    if (/007/.test(filename)) return 'api';
    if (/agent-response|tables|memory|006/.test(filename)) return 'responses';
    if (/design|008|browser|compact|questions|frontend|saas-ui/.test(filename)) return 'ui';
    return 'release';
  }
  const disposition = before.files.map(doc => {
    const domain = area(doc.path);
    const destination = retained.has(doc.path) ? doc.path : `docs/archive/${doc.path}`;
    const snapshot = refreshed.has(doc.path) ? `docs/archive/baseline-2026-10-07/${doc.path === 'AGENTS.md' ? 'AGENTS.baseline.md' : doc.path}` : null;
    if (snapshot) {
      const target = path.resolve(root, snapshot);
      if (!target.startsWith(root + path.sep)) throw new Error('Snapshot escaped workspace');
      if (fs.existsSync(target)) throw new Error(`Snapshot already exists: ${snapshot}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, doc.path), target);
    }
    return { original: doc.path, destination, snapshot, disposition: snapshot ? 'consolidated/refreshed' : retained.has(doc.path) ? doc.path === 'docs/005-live-provider-evidence.md' ? 'historical/stable registry reference' : 'retained/current' : 'archived/consolidated', domain, reviewed_against: evidence[domain], original_sha256: doc.sha256, original_lines: doc.lines };
  });
  fs.mkdirSync(path.join(root, 'docs/archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'plans/qa/2026-10-07-docs-disposition.json'), JSON.stringify({ baseline: before.baseline, date: '2026-10-07', scope: 'Repository-authored Markdown; requirement-domain/source audit, not independent proof of every historical acceptance claim', files: disposition }, null, 2) + '\n');
  console.log(JSON.stringify({ inventoried: disposition.length, moves: disposition.filter(d => d.destination !== d.original).length, snapshots: disposition.filter(d => d.snapshot).length, retained: disposition.filter(d => d.destination === d.original).length }));
} else if (mode === 'rewrite-archive-links') {
  const record = JSON.parse(fs.readFileSync(path.join(root, 'plans/qa/2026-10-07-docs-disposition.json'), 'utf8'));
  const destinations = new Map(record.files.map(d => [d.original, d.snapshot ?? d.destination]));
  const rewrite = (content, original, destination) => content.replace(/(!?\[[^\]\n]*\]\()([^)\n]+)(\))/g, (whole, prefix, raw, suffix) => {
    let target = raw.trim();
    const angle = target.startsWith('<');
    const close = angle ? target.indexOf('>') : -1;
    const tail = angle ? target.slice(close + 1) : target.match(/\s+["'].*$/)?.[0] ?? '';
    target = angle ? target.slice(1, close) : target.slice(0, target.length - tail.length);
    if (/^(https?:|mailto:|codex:|plugin:|app:|data:|#)/i.test(target)) return whole;
    const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    const file = decodeURI(target.split('#')[0]);
    if (!file || file.includes('${') || file.includes('*')) return whole;
    const oldResolved = relative(path.resolve(root, path.dirname(original), file));
    const mapped = destinations.get(oldResolved) ?? oldResolved;
    const newTarget = path.relative(path.resolve(root, path.dirname(destination)), path.resolve(root, mapped)).replaceAll('\\', '/') + fragment;
    return prefix + (angle || newTarget.includes(' ') ? `<${newTarget}>` : newTarget) + tail + suffix;
  });
  let rewritten = 0;
  for (const doc of record.files) {
    for (const destination of [doc.destination !== doc.original ? doc.destination : null, doc.snapshot].filter(Boolean)) {
      const filename = path.join(root, destination);
      const original = fs.readFileSync(filename, 'utf8');
      const actualHash = crypto.createHash('sha256').update(original).digest('hex');
      if (doc.original !== 'docs/status.md' && actualHash !== doc.original_sha256) throw new Error(`Archive baseline changed: ${destination}`);
      const currentLink = path.relative(path.dirname(filename), path.join(root, 'docs/status.md')).replaceAll('\\', '/');
      const banner = `> Historical record, archived 2026-10-07 from \`${doc.original}\`. Its claims apply to the original baseline. Use [current implementation status](${currentLink}) for active work; old proposals and DONE labels are not current authority.\n\n`;
      fs.writeFileSync(filename, banner + rewrite(original, doc.original, destination));
      rewritten++;
    }
  }
  const catalog = ['# Historical documentation', '', 'Read-only archive created 2026-10-07. Current guidance starts at [README](../../README.md); implementation evidence and open gaps live in [status](../status.md). Do not execute old gates, deploy runbooks, authority assumptions or defect probes as current instructions.', '', 'Original documents were inventoried by path, SHA-256, headings, claims and source references before cleanup. This catalog covers all 94 inventoried documents (including the running audit created this turn). Reviews were reconciled by requirement area against live source and fresh local checks; it does not claim every old device/provider/release assertion was independently rerun. Vendored skills, dependencies, generated output, external chats and inaccessible history are outside this inventory.', '', 'No historical requirement/evidence document was deleted. Original core documents have baseline snapshots; moved records retain their original path in the banner. Non-Markdown fixtures, screenshots and diagnostic scripts remain at their existing locations. The registry-linked provider evidence remains at its original stable path.', '', '| Original document | Disposition / historical location | Reconciled area |', '|---|---|---|'];
  for (const doc of record.files) {
    const location = doc.snapshot ?? doc.destination;
    const link = path.relative(path.join(root, 'docs/archive'), path.join(root, location)).replaceAll('\\', '/');
    catalog.push(`| \`${doc.original}\` | [${doc.disposition}](${link}) | ${doc.domain} |`);
  }
  catalog.push('', 'Detailed source-owner mappings and baseline hashes: [disposition register](../../plans/qa/2026-10-07-docs-disposition.json). Original inventory: [inventory](../../plans/qa/2026-10-07-docs-inventory.json).', '');
  fs.writeFileSync(path.join(root, 'docs/archive/README.md'), catalog.join('\n'));
  console.log(JSON.stringify({ rewritten, catalogued: record.files.length }));
} else if (mode === 'links') {
  const broken = []; let checked = 0;
  for (const filename of files) {
    const content = fs.readFileSync(filename, 'utf8');
    for (const match of content.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      let target = match[1].trim();
      if (target.startsWith('<')) target = target.slice(1, target.indexOf('>'));
      else target = target.split(/\s+["']/)[0];
      if (/^(?:https?:|mailto:|codex:|plugin:|app:|data:|#)/i.test(target)) continue;
      const fragment = target.includes('#') ? decodeURI(target.slice(target.indexOf('#') + 1)) : '';
      target = decodeURI(target.split('#')[0]).replace(/:\d+$/, '');
      if (!target || target.includes('${') || target.includes('*')) continue;
      const resolved = path.resolve(path.dirname(filename), target);
      checked++;
      if (!fs.existsSync(resolved)) broken.push({ file: relative(filename), target: match[1] });
      else if (fragment && /\.mdx?$/i.test(resolved)) {
        const headings = fs.readFileSync(resolved, 'utf8').split(/\r?\n/).filter(line => /^#{1,6}\s/.test(line));
        const duplicates = new Map();
        const anchors = headings.map(line => {
          const base = line.replace(/^#{1,6}\s+/, '').trim().toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
          const count = duplicates.get(base) ?? 0;
          duplicates.set(base, count + 1);
          return count ? `${base}-${count}` : base;
        });
        if (!anchors.includes(fragment)) broken.push({ file: relative(filename), target: match[1], reason: 'Missing Markdown heading anchor' });
      }
    }
  }
  console.log(JSON.stringify({ checked, broken }, null, 2));
  if (broken.length) process.exitCode = 1;
} else {
  throw new Error('Expected inventory, digest, prepare-cleanup, rewrite-archive-links or links mode');
}
