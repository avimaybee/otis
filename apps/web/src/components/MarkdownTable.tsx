import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { CheckIcon, CopyIcon } from './icons.js';

/**
 * Tab-separated export for pasting into Sheets. Cells holding tabs,
 * newlines or quotes are quoted with internal quotes doubled; multiline
 * cells survive as single quoted fields.
 */
export function tableToTsv(table: HTMLTableElement): string {
  const cell = (text: string) => {
    const clean = text.replace(/\r/g, '');
    return /[\t\n"]/.test(clean) ? `"${clean.replace(/"/g, '""')}"` : clean;
  };
  return Array.from(table.rows)
    .map((row) => Array.from(row.cells).map((c) => cell(c.innerText ?? '')).join('\t'))
    .join('\n');
}

/**
 * Production Markdown table shell for saved and streaming replies: one
 * semantic table in a locally scrolling, keyboard-accessible region plus a
 * functional Copy-table action. No sorting, filtering or download controls.
 */
export function MarkdownTable({ children }: { children?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async (): Promise<void> => {
    const table = scroller.current?.querySelector('table');
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!table || !write) return;
    try {
      await write(tableToTsv(table));
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denial keeps the affordance; the table itself is selectable.
    }
  };

  return (
    <div className="otis-mdtable">
      <div className="otis-mdtable__toolbar">
        <button type="button" className="otis-mdtable__copy gap-1 text-xs" onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? 'Copied' : 'Copy table'}</span>
        </button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- wide tables scroll inside their region; keyboard users need the region focusable to reach off-screen columns. */}
      <div ref={scroller} className="otis-mdtable__scroller" role="region" aria-label="Data table" tabIndex={0}>
        <table>{children}</table>
      </div>
    </div>
  );
}

function extractCellText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractCellText).join('');
  if (
    typeof node === 'object' &&
    'props' in node &&
    (node as { props?: { children?: ReactNode } }).props?.children
  ) {
    return extractCellText((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

/**
 * Detects whether cell contents are short status/date/currency/numeric/phone
 * values that should never wrap awkwardly across multiple lines.
 */
export function isShortNoWrapText(rawText: string): boolean {
  const text = rawText.trim();
  if (!text || text.length > 32) return false;

  // 1. Numeric, Ordinal & ID patterns: e.g. "1", "#1", "42", "100%", "99.9%"
  if (/^#?\d+([.,]\d+)?%?$/.test(text)) return true;

  // 2. Currencies: e.g. "€500", "$1,200", "€ 600", "500 EUR", "1000 RON", "£50.00"
  if (
    /^[$€£¥RON\s]*\d+([.,]\d+)?\s*(EUR|USD|GBP|RON|CAD|AUD|CHF|[$€£¥%])?$/i.test(text)
  )
    return true;

  // 3. Dates, times & timestamps:
  // e.g. "2026-10-09", "2026/10/09", "09.10.2026", "10/09/2026", "2026-10-09T06:54:15Z"
  if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(T\d{2}:\d{2}(:\d{2})?Z?)?$/.test(text)) return true;
  if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(text)) return true;
  // e.g. "Oct 9", "Oct 09, 2026", "9 Oct 2026", "October 9, 2026"
  if (
    /^(\d{1,2}\s+)?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(\s+\d{1,2})?(,\s*\d{4}|\s+\d{4})?$/i.test(
      text,
    )
  )
    return true;
  // e.g. "10:30", "14:00:00", "10:30 AM", "2:15 pm"
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM|am|pm)?$/.test(text)) return true;
  // Relative times: e.g. "today", "yesterday", "tomorrow", "now", "just now", "2 days ago", "in 3 days"
  if (
    /^(today|yesterday|tomorrow|now|just now|\d+\s*(m|h|d|w|min|mins|hour|hours|day|days|week|weeks|month|months)\s*(ago|later)?|in\s*\d+\s*(m|h|d|w|hours?|days?|weeks?))$/i.test(
      text,
    )
  )
    return true;

  // 4. Phone numbers: e.g. "+40 721 000 000", "+1-555-0199", "0721 123 456"
  if (/^\+?\d[\d\s\-().]{6,22}\d$/.test(text)) return true;

  // 5. Short status words and common status phrases:
  // e.g. "New", "Won", "Warm", "In progress", "Pending review", "Needs reply"
  if (
    /^(new|open|won|lost|warm|cold|hot|pending|active|done|closed|draft|sent|overdue|paused|in[- ]progress|completed|cancelled|canceled|needs[- ]\w+|to[- ]do|todo|yes|no|pass|fail|true|false|ok|verified)(\s+[a-z0-9_-]+){0,2}$/i.test(
      text,
    )
  ) {
    return true;
  }

  // Common role / type / category labels:
  const shortKeywords = new Set([
    'member',
    'owner',
    'system',
    'agent',
    'client',
    'lead',
    'partner',
    'note',
    'visit',
    'contact',
    'quote',
    'task',
    'call',
    'email',
    'file',
    'lukewarm',
    'high',
    'medium',
    'low',
    'urgent',
    'normal',
    'offered',
    'expected',
  ]);
  if (shortKeywords.has(text.toLowerCase())) return true;

  return false;
}

export function isShortNoWrapCell(content: ReactNode): boolean {
  return isShortNoWrapText(extractCellText(content));
}

/** Stable component map for every Transcript Markdown instance (saved and streaming). */
export const markdownComponents: Components = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  th: ({ children, className, ...props }) => {
    const classes = [className, 'otis-mdtable__th'].filter(Boolean).join(' ');
    return (
      <th className={classes || undefined} {...props}>
        {children}
      </th>
    );
  },
  td: ({ children, className, ...props }) => {
    const isNowrap = isShortNoWrapCell(children);
    const classes = [className, isNowrap ? 'otis-mdtable__nowrap' : undefined]
      .filter(Boolean)
      .join(' ');
    return (
      <td className={classes || undefined} {...props}>
        {children}
      </td>
    );
  },
};
