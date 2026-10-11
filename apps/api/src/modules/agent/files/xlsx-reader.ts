import { strFromU8, unzipSync } from 'fflate';

/**
 * Ported from App-Milyonus `candidate/import/xlsx-reader.ts`.
 *
 * Reads the first worksheet of an .xlsx file as a grid of strings.
 *
 * Deliberately small. An .xlsx is a zip of XML parts, and a candidate list
 * needs three of them: the workbook (to know which sheet comes first), the
 * shared strings, and that sheet. Nothing is evaluated — a formula contributes
 * its cached value or nothing, external links are never followed, macros are
 * never read. A file from outside the company is untrusted input, and the
 * smallest reader is the one with the least to exploit.
 *
 * Decompression is bounded by what the archive declares: parts over the limit
 * are refused before they are inflated, and a part that lies about its size is
 * cut off at the size it declared rather than allowed to grow.
 */

export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

const MAX_PART_BYTES = 48 * 1024 * 1024;
const WANTED = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/;

export function isXlsx(data: Uint8Array): boolean {
  // Every zip starts with a local file header: "PK\x03\x04".
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** One row of a sheet, numbered as the spreadsheet numbers it. */
export interface SheetRow {
  rowNumber: number;
  cells: string[];
}

/** Excel's own limit. A row numbered beyond it is not a row anyone typed. */
const MAX_SHEET_ROW = 1_048_576;

export function readXlsx(data: Uint8Array): SheetRow[] {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(data, {
      filter: (file) => {
        if (!WANTED.test(file.name)) return false;
        if (file.originalSize > MAX_PART_BYTES) {
          throw new SpreadsheetError('This spreadsheet is too large to read. Save it as CSV and import that.');
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    throw new SpreadsheetError('This file is not a readable .xlsx spreadsheet.');
  }

  const sheetPath = firstSheetPath(parts);
  const sheet = parts[sheetPath];
  if (!sheet) {
    throw new SpreadsheetError('This spreadsheet has no worksheet to read.');
  }

  const shared = parts['xl/sharedStrings.xml'] ? sharedStrings(strFromU8(parts['xl/sharedStrings.xml'])) : [];
  return worksheet(strFromU8(sheet), shared);
}

// ───────────────────────────────────────────────────────────── the parts

/** The sheet the workbook lists first — what someone opening the file sees. */
function firstSheetPath(parts: Record<string, Uint8Array>): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  const workbook = parts['xl/workbook.xml'];
  const rels = parts['xl/_rels/workbook.xml.rels'];
  if (!workbook || !rels) return fallback;

  const firstSheet = /<(?:\w+:)?sheet\b[^>]*?\br:id="([^"]+)"/.exec(strFromU8(workbook));
  if (!firstSheet) return fallback;

  for (const match of strFromU8(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = match[1]!;
    if (attribute(attrs, 'Id') !== firstSheet[1]) continue;
    const target = attribute(attrs, 'Target');
    if (!target) return fallback;
    // Targets are relative to xl/, or absolute from the package root.
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  return fallback;
}

function sharedStrings(xml: string): string[] {
  const strings: string[] = [];
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    strings.push(textRuns(item[1]!));
  }
  return strings;
}

function worksheet(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];

  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attribute(row[1]!, 'r')) || (rows.at(-1)?.rowNumber ?? 0) + 1;
    if (rowNumber > MAX_SHEET_ROW) break;

    const cells: string[] = [];
    let position = 0;
    for (const cell of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1]!;
      const ref = attribute(attrs, 'r');
      const column = ref ? columnIndex(ref) : position;
      position = column + 1;
      // A list of people does not run to column IW, and filling every gap up
      // to a far-flung cell is how a small file would become a large grid.
      if (column > 255) continue;
      cells[column] = cellValue(attribute(attrs, 't'), cell[2] ?? '', shared);
    }

    rows.push({ rowNumber, cells: Array.from(cells, (v) => v ?? '') });
  }

  return rows;
}

function cellValue(type: string | null, inner: string, shared: string[]): string {
  if (type === 'inlineStr') {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
    return inline ? textRuns(inline[1]!) : '';
  }

  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return '';
  const value = decode(raw);

  switch (type) {
    case 's':
      return shared[Number(value)] ?? '';
    case 'b':
      return value === '1' ? 'TRUE' : 'FALSE';
    case 'str':
    case 'e':
      return value;
    default:
      // A number. Written without an exponent, so a phone number stored as a
      // number comes back as its digits.
      return /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value) && /e/i.test(value)
        ? Number(value).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })
        : value;
  }
}

// ─────────────────────────────────────────────────────────────── helpers

/** The visible text of a string item: its runs, without phonetic guides. */
function textRuns(xml: string): string {
  const withoutPhonetics = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const run of withoutPhonetics.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
    text += decode(run[1]!);
  }
  return text;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return match ? decode(match[1]!) : null;
}

/** "A" → 0, "Z" → 25, "AA" → 26. */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XML's five entities and numeric references, then OOXML's own escape for
 * characters XML cannot carry (`_x000D_`). Nothing else is expanded: no DTD is
 * ever read, so there is nothing for an entity-expansion attack to use.
 */
function decode(text: string): string {
  return text
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (_, dec?: string, hex?: string, named?: string) => {
      if (named) return ENTITIES[named.toLowerCase()]!;
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      // A reference to no character is dropped rather than allowed to throw.
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
