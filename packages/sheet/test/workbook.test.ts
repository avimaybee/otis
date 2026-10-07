import { describe, expect, it } from 'vitest';
import { buildWorkbook, MAX_SHEET_ROWS } from '../src/index.js';

/**
 * Independent XLSX reader for the writer contract: parses ZIP central
 * directory records and SpreadsheetML by hand, using only the produced
 * bytes. A bitwise (table-free) CRC reimplementation keeps the integrity
 * check independent of the writer's table-driven CRC.
 */

function crcBitwise(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipFile {
  name: string;
  data: Uint8Array;
}

function readZip(bytes: Uint8Array): ZipFile[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  // End-of-central-directory: scan the tail for its signature.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  const files: ZipFile[] = [];
  let cursor = centralOffset;
  for (let n = 0; n < count; n++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const method = view.getUint16(cursor + 10, true);
    expect(method).toBe(0);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const name = text.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localOffset = view.getUint32(cursor + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    expect(crcBitwise(data)).toBe(crc);
    files.push({ name, data });
    cursor += 46 + nameLength + extraLength;
  }
  return files;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cellTexts(sheetXml: string): string[] {
  const out: string[] = [];
  for (const match of sheetXml.matchAll(/<c r="[A-Z]+\d+"(?: t="([^"]+)")?>(.*?)<\/c>|<c r="[A-Z]+\d+"\/>/gs)) {
    const kind = match[1];
    const body = match[2] ?? '';
    if (kind === 'inlineStr') {
      const text = body.match(/<t>(.*?)<\/t>/s)?.[1] ?? '';
      out.push(unescapeXml(text));
    } else if (kind === 'b') {
      out.push(body.includes('<v>1</v>') ? 'TRUE' : 'FALSE');
    } else if (body.includes('<v>')) {
      out.push(body.match(/<v>(.*?)<\/v>/s)?.[1] ?? '');
    } else {
      out.push('');
    }
  }
  return out;
}

describe('XLSX workbook writer', () => {
  it('emits a valid stored ZIP with workbook, rels and sheets', () => {
    const built = buildWorkbook(
      [{ name: 'Chats', headers: ['Title', 'Messages'], rows: [['Alpha', 3]] }],
      'otis.xlsx',
    );
    expect(built.contentType).toContain('spreadsheetml.sheet');
    expect(built.filename).toBe('otis.xlsx');
    expect(built.bytes[0]).toBe(0x50);
    expect(built.bytes[1]).toBe(0x4b);

    const files = readZip(built.bytes);
    const names = files.map((file) => file.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('_rels/.rels');
    expect(names).toContain('xl/workbook.xml');
    expect(names).toContain('xl/_rels/workbook.xml.rels');
    expect(names).toContain('xl/worksheets/sheet1.xml');

    const workbook = new TextDecoder().decode(files.find((file) => file.name === 'xl/workbook.xml')!.data);
    expect(workbook).toContain('name="Chats"');
    const sheet = new TextDecoder().decode(files.find((file) => file.name === 'xl/worksheets/sheet1.xml')!.data);
    expect(cellTexts(sheet)).toEqual(['Title', 'Messages', 'Alpha', '3']);
  });

  it('escapes markup, guards formulas, and round-trips types and unicode', () => {
    const built = buildWorkbook(
      [
        {
          name: 'Notes',
          headers: ['Text', 'Count', 'Done', 'Empty'],
          rows: [
            ['Fish & Chips <b>', 42, true, null],
            ['=1+1', 0, false, null],
            ['Preț ❤️ +40711', 7, true, null],
          ],
        },
      ],
      'otis.xlsx',
    );
    const files = readZip(built.bytes);
    const sheet = new TextDecoder().decode(files.find((file) => file.name === 'xl/worksheets/sheet1.xml')!.data);
    const raw = sheet;
    // Markup is escaped, never literal XML.
    expect(raw).toContain('Fish &amp; Chips &lt;b&gt;');
    expect(raw).not.toContain('<b>');
    // Formula cells carry the text marker (XML-escaped).
    expect(raw).toContain(`&apos;=1+1`);
    const cells = cellTexts(sheet);
    expect(cells).toContain('Fish & Chips <b>');
    expect(cells).toContain(`'=1+1`);
    expect(cells).toContain('42');
    expect(cells).toContain('TRUE');
    expect(cells).toContain('Preț ❤️ +40711');
  });

  it('guards every formula trigger shape', () => {
    const built = buildWorkbook(
      [{ name: 'T', headers: ['V'], rows: [['=x'], ['+x'], ['-x'], ['@x'], ['\tx'], ['plain']] }],
      'otis.xlsx',
    );
    const files = readZip(built.bytes);
    const sheet = new TextDecoder().decode(files.find((file) => file.name === 'xl/worksheets/sheet1.xml')!.data);
    const cells = cellTexts(sheet);
    expect(cells.slice(1, 6)).toEqual([`'=x`, `'+x`, `'-x`, `'@x`, `'\tx`]);
    expect(cells[6]).toBe('plain');
  });

  it('sanitizes sheet names, caps rows with a marker, and stays deterministic', () => {
    const rows: (string | number | null)[][] = Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, i) => [`row ${i}`]);
    const first = buildWorkbook(
      [
        { name: 'Bad/Name:*?[]Extra characters beyond thirty-one limit ok', headers: ['A'], rows },
        { name: 'Empty', headers: ['A'], rows: [] },
      ],
      'otis.xlsx',
    );
    const second = buildWorkbook(
      [
        { name: 'Bad/Name:*?[]Extra characters beyond thirty-one limit ok', headers: ['A'], rows },
        { name: 'Empty', headers: ['A'], rows: [] },
      ],
      'otis.xlsx',
    );
    expect(Buffer.from(first.bytes).equals(Buffer.from(second.bytes))).toBe(true);

    const files = readZip(first.bytes);
    const workbook = new TextDecoder().decode(files.find((file) => file.name === 'xl/workbook.xml')!.data);
    expect(workbook).not.toMatch(/Bad\/Name/);
    const sheet = new TextDecoder().decode(files.find((file) => file.name === 'xl/worksheets/sheet1.xml')!.data);
    const cells = cellTexts(sheet);
    expect(cells.length).toBe(1 + MAX_SHEET_ROWS + 1);
    expect(cells[cells.length - 1]).toContain(`showing first ${MAX_SHEET_ROWS} of ${MAX_SHEET_ROWS + 5} rows`);
  });
});
