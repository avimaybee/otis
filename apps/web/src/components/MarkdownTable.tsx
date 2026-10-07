import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Components } from 'react-markdown';

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
        <button type="button" className="otis-mdtable__copy" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy table'}
        </button>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- wide tables scroll inside their region; keyboard users need the region focusable to reach off-screen columns. */}
      <div ref={scroller} className="otis-mdtable__scroller" role="region" aria-label="Data table" tabIndex={0}>
        <table>{children}</table>
      </div>
    </div>
  );
}

/** Stable component map for every Transcript Markdown instance (saved and streaming). */
export const markdownComponents: Components = {
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
};
