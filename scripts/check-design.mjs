#!/usr/bin/env node
/**
 * Otis design checker (008A).
 *
 * Fail-closed enforcement for design-tokens.md: scans the real web UI sources
 * plus relevant shared/generated UI sources for visual drift. Colors live only
 * in apps/web/src/globals.css (verbatim token section 9); CSS variables are
 * the only token store (no TypeScript palette).
 *
 * Usage: `pnpm check:design` from the repo root (or `scripts/check-design.sh`).
 * Exits nonzero on any failure, on missing source paths, or when zero
 * candidate files were scanned. Zero candidate files is never a pass.
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Monorepo UI roots. apps/web/src (not a bare `src`) is the required path. */
const SCAN_ROOTS = ['apps/web/src', 'packages/design/src'];
const DEFINITION_STORE = 'apps/web/src/globals.css';
const TOKEN_FILE = 'design-tokens.md';
/** Pinned at import; a token update is explicit and must re-pin here. */
const TOKEN_SHA256 = '69BADBF7E4F23A2BCFF18ADBA1280EADDA92570091135D250C33399C197923A2';
const SELF_TEST = process.argv.includes('--self-test');

const failures = [];

function collectFiles(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      collectFiles(full, out);
    } else if (/\.(tsx|ts|css)$/.test(entry)) {
      out.push(full);
    }
  }
}

/** Documented recipe exceptions. Each entry names the exact approved source. */
const GRID_PX = new Set([0, 4, 8, 12, 16, 24, 32, 48]);
/** Approved integer spacing scale (token 6.1 Tailwind steps). */
const GRID_SCALE = new Set([0, 1, 2, 3, 4, 6, 8, 12]);
const ARBITRARY_ALLOW = new Set([
  'pl-[14px]', // token 8.2: selected sidebar row padding exception
  'h-[52px]', // token 8.3: top bar height
  'min-h-[52px]', // token 8.9: composer surface minimum height
  'max-w-[760px]', // token 8.4/8.9: transcript and composer column
  'w-[280px]', // token 8.2: sidebar width
  'w-[min(320px,86vw)]', // token 7: mobile drawer width
  'h-[22px]', // token 8.8: status pill height
  'max-h-[min(320px,45dvh)]', // token 8.12: question panel scroll bound
  'max-w-[85%]', // token 8.6: user message width
  'nav:max-w-[80%]', // token 8.6: user message width at nav breakpoint
  'h-[calc(100%-1px)]', // generated tabs trigger fill (behavioral, no visual value)
  'max-w-[calc(100%-2rem)]', // dialog viewport cap (behavioral, no visual value)
  'my-1.5', // token 6.1/8.9: composer textarea margin exception
  'size-1.5', // token 4: 6px leading dot on the hot status pill
  'rounded-[inherit]', // scroll-area viewport inherits its radius; introduces no value
]);

let scanned = 0;

function fail(file, label, match) {
  failures.push(`${relative(ROOT, file)}: FAIL ${label}: ${match.trim().slice(0, 160)}`);
}

function checkFile(file) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const isStore = rel === DEFINITION_STORE;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const isCss = file.endsWith('.css');

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;
    // 1. Literal colors live only in the definition store.
    if (!isStore && /#[0-9a-fA-F]{3,8}\b|rgba?\s*\(|hsla?\s*\(/.test(line)) {
      fail(file, 'hex/rgb/hsl literal outside globals.css', `${at} ${line}`);
    }
    // 2. Type scale: five sizes, weights 400/500 only.
    if (/text-(lg|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b|text-\[/.test(line)) {
      fail(file, 'banned text size (only text-xs/nav/sm/base/xl)', `${at} ${line}`);
    }
    if (/font-(semibold|bold|extrabold|black|thin|light)\b/.test(line)) {
      fail(file, 'banned font weight utility (400/500 only)', `${at} ${line}`);
    }
    if (isCss && !isStore && /font-size\s*:/.test(line) && !/font-size\s*:\s*inherit/.test(line)) {
      fail(file, 'font-size in CSS (use text-xs/nav/sm/base/xl utilities)', `${at} ${line}`);
    }
    if (isCss && !isStore && /font-weight\s*:\s*(200|300|600|700|800|900)\b/.test(line)) {
      const isAllowed600 = /font-weight\s*:\s*600\b/.test(line) &&
        /(\.otis-empty__title|\.otis-wordmark|\.otis-nav__brand)/.test(line);
      if (!isAllowed600) {
        fail(file, 'banned font-weight value (400/500 only, 600 wordmark/empty title only)', `${at} ${line}`);
      }
    }
    // 3. Shadows, blur, gradients: only shadow-popover exists.
    if (/shadow-(xs|sm|md|lg|xl|2xl|inner)\b|drop-shadow|text-shadow/.test(line)) {
      fail(file, 'banned shadow (only shadow-popover)', `${at} ${line}`);
    }
    if (isCss && !isStore && /box-shadow\s*:/.test(line) && !/box-shadow\s*:\s*(none|var\(--shadow-popover\))/.test(line)) {
      fail(file, 'banned box-shadow value (only var(--shadow-popover))', `${at} ${line}`);
    }
    if (/blur-|backdrop-|backdrop-filter/.test(line)) {
      fail(file, 'banned blur (no gradients/glass/blur/glow)', `${at} ${line}`);
    }
    // The trailing color-stop alternative is anchored out of identifiers:
    // fixture ids like 'photo-ready-1' contain "to-ready-1" but are not
    // gradient utilities; real stops always follow a class boundary.
    if (/bg-gradient|linear-gradient|radial-gradient|background-clip\s*:\s*text|-webkit-text-fill-color|(?<![\w-])to-[a-z]+-[0-9]/.test(line)) {
      fail(file, 'banned gradient construction', `${at} ${line}`);
    }
    // 4. Off-system palette classes (the approved store has no red/blue/… scale).
    if (/(bg|text|border|ring|fill|stroke|outline|decoration|divide|placeholder|caret)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]|(bg|text|border)-(black|white)(?![\w/-])/.test(line)) {
      fail(file, 'off-system palette class', `${at} ${line}`);
    }
    // 5. Viewport: dynamic height only.
    if (/h-screen|min-h-screen|100vh/.test(line)) {
      fail(file, 'banned viewport unit (use h-dvh/100dvh)', `${at} ${line}`);
    }
    // 6. Sentence case everywhere; no tracked caps.
    if (/\buppercase\b|tracking-(wide|wider|widest)|text-transform\s*:|letter-spacing\s*:/.test(line)) {
      const isAllowedTracking = (isStore && /--text-xl--letter-spacing\s*:\s*-0\.01em\b/.test(line)) ||
        (/letter-spacing\s*:\s*-0\.01em\b/.test(line) && /(\.otis-empty__title|\.otis-entry__title|text-xl)/.test(line));
      if (!isAllowedTracking) {
        fail(file, 'banned uppercase/tracking', `${at} ${line}`);
      }
    }
    // 7. Highlight (yellow) never hides behind the neutral accent token.
    if (/('[^']*bg-accent[^']*highlight[^']*'|"[^"]*bg-accent[^"]*highlight[^"]*")/.test(line)) {
      fail(file, 'highlight used through the accent token', `${at} ${line}`);
    }
    // 8. Retired competing stores.
    if (/--otis-(canvas|sidebar|surface|surface-hover|surface-raised|border|text-|action-|focus-ring|danger|warning|success|space-|radius-|font-|leading-|hit|duration|turn-gap|section-gap|control-|icon-size|gutter|topbar|sidebar-width|detail-width|content-width)|@fontsource-variable\/inter|@fontsource-variable\/geist(?!-mono)|radix-nova|\bGeist Variable\b/.test(line)) {
      fail(file, 'retired palette/font reference (use approved CSS variables + Instrument Sans)', `${at} ${line}`);
    }
    // 8b. No parallel TypeScript palette object. CSS variables are the store.
    if (!isCss && /\b(const|let|var)\s+(TOKENS|PALETTE|COLORS|THEME)\s*[:=]/.test(line)) {
      fail(file, 'parallel TypeScript palette (CSS variables are the only token store)', `${at} ${line}`);
    }
    // 9. Banned motion names. otis-spin is the in-control send pending state.
    if (/animate-(pulse|ping|bounce)|otis-pulse|otis-shimmer|otis-question-enter|otis-picker-enter/.test(line)) {
      fail(file, 'banned decorative motion', `${at} ${line}`);
    }
    // 10. Radius inventory: 4/8/12/16/20 pills only (declaration values only).
    // Every matching declaration on the line is inspected, not just the first.
    if (isCss && !isStore) {
      for (const radiusDecl of line.matchAll(/border-radius\s*:\s*([^;{]+)/g)) {
        const values = radiusDecl[1].match(/(\d+)px/g) ?? [];
        for (const value of values) {
          const size = Number.parseInt(value, 10);
          if (![4, 8, 12, 16, 20, 9999].includes(size)) {
            fail(file, `off-inventory radius ${value} (4/8/12/16/20/full only)`, `${at} ${line}`);
          }
        }
      }
    }
    if (/rounded-\[/.test(line) && !/rounded-\[inherit\]/.test(line)) {
      fail(file, 'arbitrary rounded value (use rounded-sm/md/lg/xl/2xl/full)', `${at} ${line}`);
    }
    // 11. Border inventory: hairlines and the documented 2px accents only.
    if (isCss && !isStore) {
      for (const borderDecl of line.matchAll(/(?:^|[;}])\s*border(-top|-right|-bottom|-left)?\s*:\s*([^;{]+)/g)) {
        const values = borderDecl[2].match(/(\d+)px/g) ?? [];
        for (const value of values) {
          const size = Number.parseInt(value, 10);
          if (![0, 1, 2].includes(size)) {
            fail(file, `off-inventory border ${value}`, `${at} ${line}`);
          }
        }
      }
    }
    // 12. Spacing grid in authored CSS: 4px steps plus pl-[14px] rows.
    // The visually-hidden -1px margin is an a11y clip, not visual spacing.
    // Every matching declaration on the line is inspected, not just the first.
    if (isCss && !isStore && !/otis-visually-hidden/.test(line)) {
      for (const spacingDecl of line.matchAll(/(padding|margin|gap)(-[a-z]+)?\s*:\s*([^;{]+)/g)) {
        const values = spacingDecl[3].match(/(-?\d+)px/g) ?? [];
        for (const value of values) {
          const size = Math.abs(Number.parseInt(value, 10));
          const rowException = /padding-left\s*:\s*14px/.test(spacingDecl[0]);
          if (!GRID_PX.has(size) && !(rowException && size === 14)) {
            fail(file, `off-grid spacing ${value} (4/8/12/16/24/32/48, pl-14px rows only)`, `${at} ${line}`);
          }
        }
      }
    }
    // 13. Fractional spacing utilities (documented my-1.5/size-1.5 excepted).
    const fractional = line.match(/(?<![\w-])(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-x|space-y)-[0-9]+\.[0-9]+\b/g) ?? [];
    for (const token of fractional) {
      if (!ARBITRARY_ALLOW.has(token)) {
        fail(file, `fractional spacing utility ${token}`, `${at} ${line}`);
      }
    }
    // 13b. Integer spacing utilities against the approved scale (token 6.1:
    // Tailwind 0, 1, 2, 3, 4, 6, 8, 12). Dimensions (w/h/size), ordering
    // (z-index, order, flex) and runtime geometry are not visual spacing
    // literals and stay out of scope; only these spacing prefixes are checked.
    for (const match of line.matchAll(/(?:^|[\s"'`:>])(-)?(?:[a-z-]+:)?(p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|space-x|space-y)-(\d+)\b(?!\.)/g)) {
      const size = Number.parseInt(match[3], 10);
      if (!GRID_SCALE.has(size)) {
        fail(file, `off-scale spacing utility ${match[2]}-${match[3]} (0,1,2,3,4,6,8,12 only)`, `${at} ${line}`);
      }
    }
    // 14. Arbitrary Tailwind values must be documented recipe exceptions.
    // Selector fragments ([&>…], [variant=…]) are not utilities and are skipped.
    const arbitrary = line.match(/(?:^|[\s"'`>])(?:[a-z-]+:)?[a-z-]+-\[[^[\]{}*>&=]+\]/g) ?? [];
    for (const token of arbitrary) {
      const cleaned = token.trim().replace(/^["'`>\s]+/, '');
      const bare = cleaned.replace(/^[a-z-]+:/, '');
      if (!ARBITRARY_ALLOW.has(cleaned) && !ARBITRARY_ALLOW.has(bare)) {
        fail(file, `undocumented arbitrary value ${cleaned}`, `${at} ${line}`);
      }
    }
    // 15. No inline style objects in components.
    if (!isCss && /style=\{\{/.test(line)) {
      fail(file, 'inline style object (use recipes/utilities)', `${at} ${line}`);
    }
    // 16. Removed toolbar/card/question machinery must not return.
    if (/otis-composer__toolbar|otis-model-controls|otis-question__badge|otis-question__tag|otis-msg-action--pill|otis-jump__badge|ModelControls/.test(line)) {
      fail(file, 'removed pre-008A machinery', `${at} ${line}`);
    }
    if (/from\s+['"]\.\/ui\/card\.js['"]/.test(line) && /Transcript|Composer|ConversationScreen|HistoryNav/.test(text.slice(0, 2000))) {
      fail(file, 'Card wrapper around conversation content', `${at} ${line}`);
    }
    // 17. Focus stays visible and neutral; outline removal needs its recipe.
    // otis-composer__input and otis-question__answer are the documented
    // borderless answer fields (tokens 8.9, 8.12); both keep keyboard focus
    // honest through their surfaces.
    if (/outline-none|outline-hidden/.test(line)
      && !/otis-composer__input/.test(line)
      && !/otis-question__answer/.test(line)
      && !/:focus:not\(\s*:focus-visible\s*\)/.test(line)
      && !/SelectPrimitive|DropdownMenuPrimitive|focus:bg-accent/.test(line)) {
      fail(file, 'removed keyboard focus without the documented recipe', `${at} ${line}`);
    }
  });
  scanned += 1;
}

const missing = SCAN_ROOTS.filter(root => !existsSync(join(ROOT, root)));
if (missing.length > 0) {
  console.error(`FAIL: missing source paths: ${missing.join(', ')} (run from the repo root)`);
  process.exit(1);
}

if (SELF_TEST) {
  runSelfTest();
}

const files = [];
for (const root of SCAN_ROOTS) collectFiles(join(ROOT, root), files);
files.sort();
for (const file of files) checkFile(file);

if (scanned === 0) {
  console.error('FAIL: zero candidate files scanned; refusing a false green result.');
  process.exit(1);
}

if (failures.length > 0) {
  console.error(`check-design: ${failures.length} violation(s) in ${scanned} file(s):\n`);
  for (const failure of failures) console.error(`${failure}\n`);
  process.exit(1);
}

// 18. Approved 2026-10-04 additions (docs/design/approved-additions-2026-10-04.md).
// Narrow exact-value assertions for the four approved recipes. These assert
// the approved values exist; they never permit arbitrary values elsewhere.
function expectContains(label, fileRel, snippet) {
  const full = join(ROOT, fileRel);
  if (!existsSync(full) || !readFileSync(full, 'utf8').includes(snippet)) {
    console.error(`FAIL: approved recipe missing: ${label} (expected in ${fileRel})`);
    process.exit(1);
  }
}

function expectRuleWithout(label, fileRel, ruleSelector, banned) {
  const text = readFileSync(join(ROOT, fileRel), 'utf8');
  const rule = text.match(new RegExp(`${ruleSelector}\\s*\\{[^}]*\\}`));
  if (!rule || rule[0].includes(banned)) {
    console.error(`FAIL: approved recipe violated: ${label} (see ${fileRel})`);
    process.exit(1);
  }
}

expectContains(
  'settings/result/source dialogs cap at min(600px, calc(100vw - 32px))',
  'apps/web/src/components/ui/controls.css',
  'width: min(600px, calc(100vw - 32px))',
);
expectContains(
  'entry screens cap at 384px',
  'apps/web/src/index.css',
  'max-width: 384px',
);
expectContains(
  'slash picker caps at min(360px, 100%)',
  'apps/web/src/components/ui/controls.css',
  'width: min(360px, 100%)',
);
expectRuleWithout(
  'scrim has no backdrop blur (token background at 80% only)',
  'apps/web/src/index.css',
  '\\.otis-overlay::backdrop',
  'blur',
);
{
  const css = readFileSync(join(ROOT, 'apps/web/src/index.css'), 'utf8');
  const scrim = css.match(/\.otis-overlay::backdrop\s*\{[^}]*\}/);
  if (!scrim || !scrim[0].includes('var(--background)') || !scrim[0].includes('0.8')) {
    console.error('FAIL: approved recipe violated: scrim must be the background token at 80% on the backdrop itself (see apps/web/src/index.css)');
    process.exit(1);
  }
}
expectContains(
  'nested modals reuse the outer scrim instead of stacking',
  'apps/web/src/index.css',
  'otis-overlay--nested::backdrop',
);
expectContains(
  'jump-to-latest uses the neutral icon-button treatment',
  'apps/web/src/components/Transcript.tsx',
  'otis-iconbutton otis-jump',
);
expectRuleWithout(
  'source inspection is a neutral action, never highlight/underline link styling',
  'apps/web/src/index.css',
  '\\.otis-source-link',
  'var(--highlight)',
);

// 19. Canonical token store enforcement (R3). globals.css is exempt from the
// literal rules above, so its definitions are verified here against the
// immutable supplied baseline instead: exact section 9 text (tolerating only
// surrounding whitespace) plus the pinned design-tokens.md hash.
function tokenSectionCss(tokenMd) {
  const section = tokenMd.indexOf('## 9.');
  if (section < 0) return null;
  const open = tokenMd.indexOf('```css', section);
  if (open < 0) return null;
  const close = tokenMd.indexOf('```', open + 6);
  if (close < 0) return null;
  return tokenMd.slice(open + 6, close).trim();
}

function baselineProblem(tokenMd, globalsCss) {
  const expected = tokenSectionCss(tokenMd);
  if (expected === null) return 'design-tokens.md section 9 css block not found';
  if (globalsCss.trim() !== expected) return 'globals.css differs from design-tokens.md section 9';
  return null;
}

{
  const tokenMd = readFileSync(join(ROOT, TOKEN_FILE), 'utf8');
  const actualHash = createHash('sha256').update(tokenMd).digest('hex').toUpperCase();
  if (actualHash !== TOKEN_SHA256) {
    console.error(`FAIL: design-tokens.md hash drift (got ${actualHash.slice(0, 12)}…); token changes are explicit and must re-pin TOKEN_SHA256.`);
    process.exit(1);
  }
  const globalsCss = readFileSync(join(ROOT, DEFINITION_STORE), 'utf8');
  const problem = baselineProblem(tokenMd, globalsCss);
  if (problem !== null) {
    console.error(`FAIL: canonical token store: ${problem}.`);
    process.exit(1);
  }
}

console.log(`check-design: ok — ${scanned} file(s) scanned, no violations.`);

/**
 * Persistent negative regression for the real checker logic (R2/R3). Runs
 * in-process against checkFile with synthetic files under the OS temp dir —
 * no repository mutation — plus the baseline comparator on real and mutated
 * inputs. Any expectation mismatch exits nonzero.
 */
function runSelfTest() {
  let passed = 0;
  const dir = mkdtempSync(join(tmpdir(), 'otis-design-check-'));
  try {
    const cases = [
      {
        name: 'integer.tsx',
        text: '<div className="p-10 gap-5" />',
        expect: ['off-scale spacing utility p-10', 'off-scale spacing utility gap-5'],
      },
      {
        name: 'later.css',
        text: '.sample { padding: 16px; gap: 10px; }',
        expect: ['off-grid spacing 10px'],
      },
      {
        name: 'hex.tsx',
        text: `const x = <div style={{ color: '#fff' }} />;`,
        expect: ['hex/rgb/hsl literal outside globals.css', 'inline style object'],
      },
      {
        name: 'type.tsx',
        text: '<p className="text-lg font-semibold">x</p>',
        expect: ['banned text size', 'banned font weight utility'],
      },
      {
        name: 'decor.tsx',
        text: '<div className="blur-md h-screen shadow-md" />',
        expect: ['banned blur', 'banned viewport unit', 'banned shadow'],
      },
      {
        name: 'palette.ts',
        text: 'export const TOKENS = { brand: "#ff0000" };',
        expect: ['parallel TypeScript palette', 'hex/rgb/hsl literal outside globals.css'],
      },
      {
        name: 'ok.tsx',
        text: '<div className="min-h-[52px] pl-[14px] my-1.5 size-1.5 p-4 gap-2" />',
        expect: [],
      },
      {
        name: 'gradient.tsx',
        text: '<div className="to-red-500" />',
        expect: ['banned gradient construction'],
      },
      {
        name: 'fixture-id.ts',
        text: `storyPhoto('photo-ready-1', 'ready')`,
        expect: [],
      },
    ];
    for (const fixture of cases) {
      const full = join(dir, fixture.name);
      writeFileSync(full, fixture.text);
      failures.length = 0;
      checkFile(full);
      const labels = failures.map(failure => failure.split('FAIL ')[1]?.split(':')[0] ?? failure);
      const missing = fixture.expect.filter(want => !labels.some(label => label.startsWith(want)));
      if (missing.length > 0 || labels.length !== fixture.expect.length) {
        console.error(`SELF-TEST FAIL ${fixture.name}: expected [${fixture.expect.join(' | ')}], got [${labels.join(' | ')}]`);
        process.exit(1);
      }
      passed += 1;
    }
    // R3: the real baseline verifies; a single changed value must not.
    failures.length = 0;
    const tokenMd = readFileSync(join(ROOT, TOKEN_FILE), 'utf8');
    const globalsCss = readFileSync(join(ROOT, DEFINITION_STORE), 'utf8');
    if (baselineProblem(tokenMd, globalsCss) !== null) {
      console.error('SELF-TEST FAIL: real globals.css does not match the token baseline');
      process.exit(1);
    }
    passed += 1;
    const mutated = globalsCss.replace('#181818', '#000000');
    if (mutated === globalsCss || baselineProblem(tokenMd, mutated) === null) {
      console.error('SELF-TEST FAIL: mutated definition store was not rejected');
      process.exit(1);
    }
    passed += 1;
    const actualHash = createHash('sha256').update(tokenMd).digest('hex').toUpperCase();
    if (actualHash !== TOKEN_SHA256) {
      console.error('SELF-TEST FAIL: pinned token hash does not match the file');
      process.exit(1);
    }
    passed += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`check-design self-test: ok — ${passed} case(s) passed.`);
  process.exit(0);
}
