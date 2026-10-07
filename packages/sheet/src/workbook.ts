/**
 * @otis/sheet/workbook
 *
 * Minimal deterministic XLSX writer with zero dependencies. Workbooks use
 * stored (uncompressed) ZIP entries and inline strings, so generation needs
 * no compression library and output bytes are stable for identical input.
 *
 * SpreadsheetML notes:
 * - Inline strings (`t="inlineStr"`) avoid a shared-string table entirely.
 * - No styles part: the file carries data only, which every reader opens.
 * - Formula-injection guard: any string value that could evaluate as a
 *   formula is prefixed with a single quote, the spreadsheet text marker.
 *   The marker keeps the cell inert in Excel, LibreOffice and Sheets while
 *   preserving the original text visibly.
 */

export type SheetCell = string | number | boolean | null;

export interface SheetData {
  name: string;
  headers: string[];
  rows: SheetCell[][];
}

/** Maximum data rows per sheet; overflow is reported, never silently cut. */
export const MAX_SHEET_ROWS = 2000;

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Stored-entry ZIP archive (no compression): local headers, central
 * directory and end record with correct CRCs, sizes and offsets.
 */
export function buildStoredZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    // Fixed DOS timestamp keeps output bytes deterministic for identical input.
    local.setUint16(10, 0x645c, true);
    local.setUint16(12, 0x54d1, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, entry.data.length, true);
    local.setUint32(22, entry.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, entry.data);

    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, 0x645c, true);
    header.setUint16(14, 0x54d1, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, entry.data.length, true);
    header.setUint32(24, entry.data.length, true);
    header.setUint16(28, name.length, true);
    header.setUint16(30, 0, true);
    header.setUint16(32, 0, true);
    header.setUint16(34, 0, true);
    header.setUint16(36, 0, true);
    header.setUint32(38, 0, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralStart = offset;
  const centralBytes = concat(central);
  chunks.push(centralBytes);
  offset += centralBytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralBytes.length, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  chunks.push(new Uint8Array(end.buffer));
  return concat(chunks);
}

/** XML 1.0 text: escapes markup and strips illegal control characters. */
export function escapeXmlText(value: string): string {
  const printable = value.replace(/[^\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, (ch) =>
    ch === '\t' || ch === '\n' || ch === '\r' ? ch : '',
  );
  return printable
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Formula-injection guard (OWASP spreadsheet guidance): a leading quote
 * forces text interpretation. Covers =, +, -, @ and leading tab/CR, which
 * spreadsheet engines may otherwise evaluate on open.
 */
export function guardFormulaText(value: string): string {
  const first = value.charAt(0);
  const trigger = first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r';
  return trigger ? `'${value}` : value;
}

function columnLetters(index: number): string {
  let letters = '';
  let n = index;
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

function cellXml(reference: string, value: SheetCell): string {
  if (value === null || value === undefined) return `<c r="${reference}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${reference}"><v>${value}</v></c>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = guardFormulaText(String(value));
  return `<c r="${reference}" t="inlineStr"><is><t>${escapeXmlText(text)}</t></is></c>`;
}

/** Excel sheet names: at most 31 characters, none of []:*?/\\ */
export function sanitizeSheetName(name: string, fallback: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || fallback;
  return cleaned;
}

function sheetXml(headers: string[], rows: SheetCell[][]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ];
  const emitRow = (rowNumber: number, cells: SheetCell[]): void => {
    const rendered = cells
      .map((cell, index) => cellXml(`${columnLetters(index)}${rowNumber}`, cell))
      .join('');
    lines.push(`<row r="${rowNumber}">${rendered}</row>`);
  };
  emitRow(1, headers);
  rows.forEach((row, index) => emitRow(index + 2, row));
  lines.push('</sheetData></worksheet>');
  return lines.join('');
}

const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
  '</Types>',
].join('');

const RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
  '</Relationships>',
].join('');

function workbookXml(names: string[]): string {
  const sheets = names
    .map((name, index) => `<sheet name="${escapeXmlText(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`,
  ].join('');
}

function workbookRelsXml(count: number): string {
  const rels = Array.from(
    { length: count },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  ].join('');
}

export interface BuiltWorkbook {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Builds a deterministic XLSX workbook from row data. Sheets beyond
 * MAX_SHEET_ROWS keep a trailing truncation marker row instead of silently
 * dropping records.
 */
export function buildWorkbook(sheets: SheetData[], filename: string): BuiltWorkbook {
  const names = sheets.map((sheet, index) => sanitizeSheetName(sheet.name, `Sheet${index + 1}`));
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encodeUtf8(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encodeUtf8(RELS_XML) },
    { name: 'xl/workbook.xml', data: encodeUtf8(workbookXml(names)) },
    { name: 'xl/_rels/workbook.xml.rels', data: encodeUtf8(workbookRelsXml(names.length)) },
  ];
  sheets.forEach((sheet, index) => {
    const capped = sheet.rows.slice(0, MAX_SHEET_ROWS);
    const overflow = sheet.rows.length - capped.length;
    const body: SheetCell[][] = overflow > 0
      ? [...capped, [`… showing first ${capped.length} of ${sheet.rows.length} rows`]]
      : capped;
    entries.push({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: encodeUtf8(sheetXml(sheet.headers, body)),
    });
  });
  return {
    filename,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: buildStoredZip(entries),
  };
}
