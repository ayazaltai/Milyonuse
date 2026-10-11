import { strToU8, zipSync } from 'fflate';

/**
 * Files the agent writes for the person, built here without a dependency for
 * each format: the Office formats are zipped XML, and the smallest valid
 * package is small. What goes in is the agent's text and cells; nothing in it
 * is executed when the file is opened (no formulas, no macros).
 */

/** Text without control characters (tab, line feed and carriage return kept when asked). */
export function withoutControls(text: string, keepLines = false): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 && !(keepLines && (code === 0x09 || code === 0x0a || code === 0x0d))) continue;
    out += char;
  }
  return out;
}

export const FILE_FORMATS = ['md', 'txt', 'csv', 'json', 'html', 'xlsx', 'docx'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export const CONTENT_TYPES: Record<FileFormat, string> = {
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export function xml(text: string): string {
  return withoutControls(text, true)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A cell a spreadsheet would read as a formula, written so it is not one (CSV injection). */
function inert(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

export function csv(rows: string[][]): Buffer {
  const line = (row: string[]) =>
    row.map((c) => {
      const v = inert(c);
      return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',');
  // A byte-order mark, so a spreadsheet opens Turkish characters as themselves.
  return Buffer.from(`\ufeff${rows.map(line).join('\r\n')}\r\n`, 'utf8');
}

function column(n: number): string {
  let s = '';
  for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export function xlsx(rows: string[][], sheetName = 'Sheet1'): Buffer {
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${column(c)}${r + 1}`;
          const n = value.trim();
          // A plain number is a number; everything else is text — never a formula.
          if (/^-?\d{1,15}(\.\d+)?$/.test(n)) return `<c r="${ref}"><v>${n}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        `<sheets><sheet name="${xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

/** A Word document from plain text with Markdown-style headings (#) and bullets (-). */
export function docx(text: string, title?: string): Buffer {
  const paragraphs: string[] = [];
  const para = (body: string, style?: string) =>
    paragraphs.push(`<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xml(body)}</w:t></w:r></w:p>`);
  if (title) para(title, 'Title');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) para(heading[2]!, `Heading${heading[1]!.length}`);
    else if (/^\s*[-*]\s+/.test(line)) para(`• ${line.replace(/^\s*[-*]\s+/, '')}`);
    else para(line);
  }
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    ['Title:32', 'Heading1:28', 'Heading2:24', 'Heading3:22']
      .map((s) => {
        const [id, size] = s.split(':');
        return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
      })
      .join('') +
    '</w:styles>';
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    'word/styles.xml': strToU8(styles),
    'word/document.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body>${paragraphs.join('')}</w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}
