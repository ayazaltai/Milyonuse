/**
 * Ported from App-Milyonus `candidate/import/csv-reader.ts`.
 *
 * Reads CSV the way spreadsheets write it (RFC 4180): quoted fields, doubled
 * quotes, line breaks inside quotes, CRLF or LF, a byte-order mark or none.
 *
 * The delimiter is detected rather than assumed. Excel in much of Europe — and
 * in Turkey — writes semicolons, because the comma is the decimal separator
 * there; a paste from a spreadsheet arrives tab-separated.
 *
 * Every record is returned, blank ones included, so that record n is line n of
 * the spreadsheet the file came from: that is how the person importing finds a
 * rejected line and fixes it.
 */
const DELIMITERS = [',', ';', '\t', '|'] as const;

export function detectDelimiter(text: string): string {
  const firstLine = firstRecord(text);
  let best: string = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = countOutsideQuotes(firstLine, delimiter);
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return best;
}

export function readCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = '';
      fieldStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      fieldStarted = false;
    } else {
      field += ch;
      fieldStarted = true;
    }
  }

  // The last record, unless the file ended with a line break.
  if (fieldStarted || field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}

function firstRecord(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      const line = text.slice(0, i);
      // A leading blank line tells us nothing about the delimiter.
      if (line.trim() !== '') return line;
      return firstRecord(text.slice(i + 1));
    }
  }
  return text;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === delimiter) count += 1;
  }
  return count;
}
