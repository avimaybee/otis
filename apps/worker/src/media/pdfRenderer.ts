/**
 * @otis/worker/media/pdfRenderer
 * Markdown to printable HTML and PDF generation.
 * Supports Cloudflare Browser Run Quick Action, synthetic test transport,
 * and self-contained pure TypeScript PDF rendering fallback.
 */

import type { Env } from '../index.js';

/**
 * Escapes raw HTML to prevent injection while preserving text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Basic inline Markdown parser (bold, italic, code, links).
 */
function parseInline(text: string): string {
  let out = escapeHtml(text);
  // Inline code: `code`
  out = out.replace(/`([^`]+)`/g, '<code class="doc-code">$1</code>');
  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // Italic: *text* or _text_
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  // Markdown links: [text](url) - sanitize url
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" class="doc-link" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

/**
 * Converts Markdown source to a controlled, printable HTML document.
 * Follows print pagination standards:
 * - Clean white paper theme (#FFFFFF), dark text (#111827).
 * - Avoids break-inside on cards and callouts, allows break-inside on tables/large sections.
 * - Enforces break-after: avoid on headings.
 * - Supports Romanian diacritics and international scripts.
 */
export function markdownToPrintableHtml(title: string, markdown: string, generatedDateIso?: string): string {
  const safeTitle = escapeHtml(title);
  const dateStr = generatedDateIso ? new Date(generatedDateIso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) : new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const lines = markdown.split(/\r?\n/);
  const htmlParts: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let inTable = false;
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];

  const closeList = () => {
    if (inList) {
      htmlParts.push(`</${inList}>`);
      inList = null;
    }
  };
  const closeBlockquote = () => {
    if (inBlockquote) {
      htmlParts.push('</blockquote>');
      inBlockquote = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      htmlParts.push('</tbody></table></div>');
      inTable = false;
    }
  };

  // Scan headings for Table of Contents if document has many sections
  const headings: Array<{ level: number; text: string; id: string }> = [];
  for (const line of lines) {
    const hMatch = /^(#{1,3})\s+(.+)$/.exec(line);
    if (hMatch && hMatch[1] && hMatch[2]) {
      const level = hMatch[1].length;
      const text = hMatch[2].trim();
      const id = 'sec-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      headings.push({ level, text, id });
    }
  }

  // Header banner
  htmlParts.push('<header class="doc-header">');
  htmlParts.push(`<h1 class="doc-title">${safeTitle}</h1>`);
  htmlParts.push(`<div class="doc-meta"><span>Generated: ${dateStr}</span> · <span>Otis Business Memory</span></div>`);
  htmlParts.push('</header>');

  // Table of Contents for documents with >= 4 sections
  if (headings.length >= 4) {
    htmlParts.push('<nav class="doc-toc" aria-label="Table of Contents">');
    htmlParts.push('<h2 class="doc-toc-title">Contents</h2>');
    htmlParts.push('<ul class="doc-toc-list">');
    for (const h of headings) {
      if (h.level <= 2) {
        htmlParts.push(`<li class="doc-toc-item doc-toc-h${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`);
      }
    }
    htmlParts.push('</ul>');
    htmlParts.push('</nav>');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Code blocks
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        htmlParts.push(`<pre class="doc-pre"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        closeList();
        closeBlockquote();
        closeTable();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Blank line
    if (!trimmed) {
      closeList();
      closeBlockquote();
      closeTable();
      continue;
    }

    // Headings
    const hMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hMatch && hMatch[1] && hMatch[2]) {
      closeList();
      closeBlockquote();
      closeTable();
      const level = hMatch[1].length;
      const text = hMatch[2].trim();
      const id = 'sec-' + text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      htmlParts.push(`<h${level} id="${id}" class="doc-h${level}">${parseInline(text)}</h${level}>`);
      continue;
    }

    // Blockquote: > ...
    if (trimmed.startsWith('>')) {
      closeList();
      closeTable();
      const bContent = trimmed.replace(/^>\s*/, '');
      if (!inBlockquote) {
        htmlParts.push('<blockquote class="doc-blockquote">');
        inBlockquote = true;
      }
      htmlParts.push(`<p>${parseInline(bContent)}</p>`);
      continue;
    } else {
      closeBlockquote();
    }

    // Table: | ... |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList();
      const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
      // Check if delimiter row: |---|---|
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        // Delimiter row: switches thead to tbody
        continue;
      }
      if (!inTable) {
        inTable = true;
        htmlParts.push('<div class="doc-table-wrapper"><table class="doc-table"><thead><tr>');
        for (const c of cells) {
          htmlParts.push(`<th>${parseInline(c)}</th>`);
        }
        htmlParts.push('</tr></thead><tbody>');
      } else {
        htmlParts.push('<tr>');
        for (const c of cells) {
          htmlParts.push(`<td>${parseInline(c)}</td>`);
        }
        htmlParts.push('</tr>');
      }
      continue;
    } else {
      closeTable();
    }

    // Unordered List: - ... or * ...
    if (/^[-*]\s+/.test(trimmed)) {
      closeBlockquote();
      closeTable();
      const itemText = trimmed.replace(/^[-*]\s+/, '');
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        htmlParts.push('<ul class="doc-ul">');
      }
      htmlParts.push(`<li>${parseInline(itemText)}</li>`);
      continue;
    }

    // Ordered List: 1. ...
    if (/^\d+\.\s+/.test(trimmed)) {
      closeBlockquote();
      closeTable();
      const itemText = trimmed.replace(/^\d+\.\s+/, '');
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        htmlParts.push('<ol class="doc-ol">');
      }
      htmlParts.push(`<li>${parseInline(itemText)}</li>`);
      continue;
    }

    closeList();

    // Horizontal rule: ---
    if (/^[-*_]{3,}$/.test(trimmed)) {
      htmlParts.push('<hr class="doc-hr" />');
      continue;
    }

    // Regular paragraph
    htmlParts.push(`<p class="doc-p">${parseInline(trimmed)}</p>`);
  }

  closeList();
  closeBlockquote();
  closeTable();
  if (inCodeBlock) {
    htmlParts.push(`<pre class="doc-pre"><code>${escapeHtml(codeBlockContent.join('\n'))}</code></pre>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 20mm 15mm 20mm 15mm;
      @bottom-right {
        content: counter(page);
        font-size: 9pt;
        color: #6b7280;
      }
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 10.5pt;
      line-height: 1.6;
      color: #111827;
      background-color: #ffffff;
      margin: 0;
      padding: 0;
    }
    .doc-container {
      max-width: 100%;
      margin: 0 auto;
    }
    .doc-header {
      border-bottom: 2pt solid #e5e7eb;
      padding-bottom: 12pt;
      margin-bottom: 20pt;
    }
    .doc-title {
      font-size: 22pt;
      font-weight: 700;
      line-height: 1.25;
      color: #0f172a;
      margin: 0 0 6pt 0;
    }
    .doc-meta {
      font-size: 9pt;
      color: #64748b;
    }
    .doc-toc {
      background-color: #f8fafc;
      border: 1pt solid #e2e8f0;
      border-radius: 4pt;
      padding: 12pt 16pt;
      margin-bottom: 24pt;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .doc-toc-title {
      font-size: 11pt;
      font-weight: 600;
      margin: 0 0 8pt 0;
      color: #334155;
    }
    .doc-toc-list {
      list-style: none;
      padding-left: 0;
      margin: 0;
    }
    .doc-toc-item {
      font-size: 9.5pt;
      line-height: 1.5;
    }
    .doc-toc-h2 {
      padding-left: 12pt;
    }
    .doc-toc a {
      color: #2563eb;
      text-decoration: none;
    }
    .doc-h1 {
      font-size: 16pt;
      font-weight: 700;
      color: #0f172a;
      margin: 24pt 0 10pt 0;
      padding-bottom: 4pt;
      border-bottom: 1pt solid #e2e8f0;
      break-after: avoid;
      page-break-after: avoid;
    }
    .doc-h2 {
      font-size: 13pt;
      font-weight: 600;
      color: #1e293b;
      margin: 18pt 0 8pt 0;
      break-after: avoid;
      page-break-after: avoid;
    }
    .doc-h3 {
      font-size: 11pt;
      font-weight: 600;
      color: #334155;
      margin: 14pt 0 6pt 0;
      break-after: avoid;
      page-break-after: avoid;
    }
    .doc-h4 {
      font-size: 10pt;
      font-weight: 600;
      color: #475569;
      margin: 10pt 0 4pt 0;
      break-after: avoid;
      page-break-after: avoid;
    }
    .doc-p {
      margin: 0 0 10pt 0;
      text-align: justify;
      hyphens: auto;
    }
    .doc-ul, .doc-ol {
      margin: 0 0 10pt 0;
      padding-left: 20pt;
    }
    .doc-ul li, .doc-ol li {
      margin-bottom: 4pt;
    }
    .doc-blockquote {
      border-left: 3pt solid #3b82f6;
      background-color: #f0f9ff;
      margin: 12pt 0;
      padding: 8pt 12pt;
      font-style: italic;
      color: #1e3a8a;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .doc-blockquote p {
      margin: 0 0 4pt 0;
    }
    .doc-blockquote p:last-child {
      margin-bottom: 0;
    }
    .doc-table-wrapper {
      margin: 14pt 0;
      overflow-x: auto;
    }
    .doc-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9pt;
      break-inside: auto;
      page-break-inside: auto;
    }
    .doc-table thead {
      display: table-header-group;
    }
    .doc-table tr {
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .doc-table th {
      background-color: #f1f5f9;
      color: #0f172a;
      font-weight: 600;
      text-align: left;
      padding: 6pt 8pt;
      border: 1pt solid #cbd5e1;
    }
    .doc-table td {
      padding: 5pt 8pt;
      border: 1pt solid #e2e8f0;
      vertical-align: top;
    }
    .doc-table tbody tr:nth-child(even) {
      background-color: #f8fafc;
    }
    .doc-pre {
      background-color: #f8fafc;
      border: 1pt solid #e2e8f0;
      border-radius: 3pt;
      padding: 8pt 10pt;
      font-size: 8.5pt;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 10pt 0;
    }
    .doc-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 9pt;
      background-color: #f1f5f9;
      padding: 1pt 3pt;
      border-radius: 2pt;
      word-break: break-all;
    }
    .doc-link {
      color: #2563eb;
      text-decoration: underline;
      word-break: break-all;
    }
    .doc-hr {
      border: none;
      border-top: 1pt solid #e2e8f0;
      margin: 16pt 0;
    }
  </style>
</head>
<body>
  <div class="doc-container">
    ${htmlParts.join('\n')}
  </div>
</body>
</html>`;
}

/**
 * Self-contained pure TypeScript PDF generator.
 * Produces genuine, standards-compliant PDF 1.4 binary bytes with text layout,
 * multiple pages, margins, headers and footers.
 */
export const synthesizePdf = synthesizePdfFromText;

export function synthesizePdfFromText(title: string, markdown: string): Uint8Array {
  // Page geometry: A4 (595.28 x 841.89 points)
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 45;
  const marginTop = 50;
  const marginBottom = 50;
  const contentHeight = pageHeight - marginTop - marginBottom;
  const lineHeight = 14;
  const maxLinesPerPage = Math.floor(contentHeight / lineHeight);

  // Clean lines for printable layout
  const rawLines = markdown.split(/\r?\n/);
  const formattedLines: string[] = [];
  formattedLines.push(`DOCUMENT: ${title.toUpperCase()}`);
  formattedLines.push(`Date: ${new Date().toISOString().slice(0, 10)} | Otis Business Memory`);
  formattedLines.push('='.repeat(70));
  formattedLines.push('');

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      formattedLines.push('');
      continue;
    }
    if (trimmed.startsWith('# ')) {
      formattedLines.push('');
      formattedLines.push(trimmed.slice(2).toUpperCase());
      formattedLines.push('-'.repeat(50));
      continue;
    }
    if (trimmed.startsWith('## ')) {
      formattedLines.push('');
      formattedLines.push(trimmed.slice(3));
      formattedLines.push('~'.repeat(40));
      continue;
    }
    if (trimmed.startsWith('### ')) {
      formattedLines.push('');
      formattedLines.push(trimmed.slice(4));
      continue;
    }

    // Wrap long lines to ~75 characters
    let remaining = trimmed;
    while (remaining.length > 75) {
      let cut = remaining.lastIndexOf(' ', 75);
      if (cut <= 0) cut = 75;
      formattedLines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trim();
    }
    if (remaining.length > 0) {
      formattedLines.push(remaining);
    }
  }

  // Chunk into pages
  const pages: string[][] = [];
  let currentPage: string[] = [];
  for (const line of formattedLines) {
    currentPage.push(line);
    if (currentPage.length >= maxLinesPerPage) {
      pages.push(currentPage);
      currentPage = [];
    }
  }
  if (currentPage.length > 0 || pages.length === 0) {
    pages.push(currentPage);
  }

  // Sanitize text for PDF literal strings (escape (, ), \)
  const sanitizePdfText = (str: string) => {
    // Replace characters outside ASCII with closest equivalents or ?
    return str
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/[\u0100-\uffff]/g, (c) => {
        const diacritics: Record<string, string> = {
          'ă': 'a', 'Ă': 'A', 'â': 'a', 'Â': 'A', 'î': 'i', 'Î': 'I',
          'ș': 's', 'Ș': 'S', 'ț': 't', 'Ț': 'T', 'ş': 's', 'Ş': 'S',
          'ţ': 't', 'Ţ': 'T', 'é': 'e', 'è': 'e', 'ó': 'o', 'á': 'a',
        };
        return diacritics[c] ?? '?';
      });
  };

  // Build PDF 1.4 objects
  // Objects:
  // 1: Catalog
  // 2: Pages
  // 3: Font
  // For each page:
  //   4 + 2*i: Page object
  //   5 + 2*i: Contents stream object
  const totalPages = pages.length;
  const objects: string[] = [];

  // We'll collect page object numbers: 4, 6, 8, ...
  const pageObjNums: number[] = [];
  for (let i = 0; i < totalPages; i++) {
    pageObjNums.push(4 + i * 2);
  }

  // Obj 1: Catalog
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj`);

  // Obj 2: Pages
  const kidsStr = pageObjNums.map((n) => `${n} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kidsStr}] /Count ${totalPages} >>\nendobj`);

  // Obj 3: Font (Helvetica)
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj`);

  // For each page:
  for (let pIdx = 0; pIdx < totalPages; pIdx++) {
    const pageObjNum = 4 + pIdx * 2;
    const contentsObjNum = pageObjNum + 1;
    const pageLines = pages[pIdx]!;

    // Page object
    objects.push(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentsObjNum} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\nendobj`
    );

    // Stream content
    const streamOps: string[] = [];
    streamOps.push('BT');
    streamOps.push('/F1 10 Tf');
    streamOps.push(`${lineHeight} TL`);
    streamOps.push(`${marginX} ${pageHeight - marginTop} Td`);

    for (const l of pageLines) {
      const sanitized = sanitizePdfText(l);
      streamOps.push(`(${sanitized}) '`);
    }

    // Page footer: "Page X of Y"
    const footerText = sanitizePdfText(`Page ${pIdx + 1} of ${totalPages}`);
    streamOps.push('ET');
    streamOps.push('BT');
    streamOps.push('/F1 9 Tf');
    streamOps.push(`${pageWidth - marginX - 60} ${marginBottom - 20} Td`);
    streamOps.push(`(${footerText}) Tj`);
    streamOps.push('ET');

    const streamBody = streamOps.join('\n');
    const streamLen = new TextEncoder().encode(streamBody).byteLength;
    objects.push(
      `${contentsObjNum} 0 obj\n<< /Length ${streamLen} >>\nstream\n${streamBody}\nendstream\nendobj`
    );
  }

  // Assemble full PDF
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [0];

  for (let i = 0; i < objects.length; i++) {
    offsets.push(new TextEncoder().encode(pdf).byteLength);
    pdf += objects[i] + '\n';
  }

  const startXref = new TextEncoder().encode(pdf).byteLength;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    const off = offsets[i]!;
    pdf += off.toString().padStart(10, '0') + ' 00000 n \n';
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

/**
 * Renders HTML/Markdown to PDF bytes.
 * Priority:
 * 1. env.PDF_RENDER_TRANSPORT (synthetic transport for tests)
 * 2. Cloudflare Browser Rendering binding (env.BROWSER)
 * 3. Cloudflare Browser Rendering REST API (via BROWSER_RUN_ACCOUNT_ID and BROWSER_RUN_API_KEY)
 * 4. Fallback pure-TS PDF synthesis
 */
export async function renderDocumentToPdf(
  env: Env,
  title: string,
  markdown: string,
  generatedDateIso?: string
): Promise<Uint8Array> {
  const html = markdownToPrintableHtml(title, markdown, generatedDateIso);

  // 1. Synthetic test transport
  if (env.PDF_RENDER_TRANSPORT) {
    return await env.PDF_RENDER_TRANSPORT(html);
  }

  // 2. Cloudflare Browser Rendering REST endpoint
  if (env.BROWSER_RUN_ACCOUNT_ID && env.BROWSER_RUN_API_KEY) {
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.BROWSER_RUN_ACCOUNT_ID}/browser-rendering/pdf`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.BROWSER_RUN_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            html,
            pdfOptions: {
              format: 'A4',
              printBackground: true,
              margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
            },
          }),
        }
      );
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength >= 8) return bytes;
      }
    } catch {
      // Fall through to synthesizer
    }
  }

  // 3. Cloudflare Browser binding fetch
  if (env.BROWSER) {
    try {
      const response = await env.BROWSER.fetch('https://browser.cloudflare.com/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html,
          pdfOptions: {
            format: 'A4',
            printBackground: true,
          },
        }),
      });
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength >= 8) return bytes;
      }
    } catch {
      // Fall through to synthesizer
    }
  }

  // 4. Pure-TS synthesizer fallback
  return synthesizePdfFromText(title, markdown);
}
