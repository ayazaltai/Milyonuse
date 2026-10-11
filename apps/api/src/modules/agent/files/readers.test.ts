import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { detectDelimiter, readCsv } from './csv-reader.js';
import { decodeText } from './decode-text.js';
import { SpreadsheetError, columnIndex, isXlsx, readXlsx } from './xlsx-reader.js';

/**
 * Tables are files written by other people's tools, so these pin down what
 * those tools actually produce: Excel's semicolons, quoted line breaks,
 * shared strings, numbers in exponent form — and files that are not what they
 * claim to be (ported from App-Milyonus `candidate/import/import.test.ts`).
 */

describe('CSV', () => {
  it('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
    const text = 'Name,Email,Notes\r\n"Hopper, Grace",grace@example.com,"said ""hello""\nthen left"\r\n';
    expect(readCsv(text)).toEqual([
      ['Name', 'Email', 'Notes'],
      ['Hopper, Grace', 'grace@example.com', 'said "hello"\nthen left'],
    ]);
  });

  it('detects the semicolons European Excel writes, and the tabs of a paste', () => {
    expect(detectDelimiter('Ad;Soyad;E-Posta\nAyşe;Yılmaz;ayse@example.com')).toBe(';');
    expect(detectDelimiter('Name\tEmail\nAlan\talan@example.com')).toBe('\t');
    expect(detectDelimiter('"a;b",c\n1,2')).toBe(',');
  });

  it('drops a byte-order mark and keeps blank lines, so line n stays line n', () => {
    const records = readCsv(`\uFEFFName,Email\n\nGrace,grace@example.com`);
    expect(records[0]).toEqual(['Name', 'Email']);
    expect(records[1]).toEqual(['']);
    expect(records[2]).toEqual(['Grace', 'grace@example.com']);
  });
});

describe('XLSX', () => {
  function workbook(sheet: string, shared: string[] = []): Uint8Array {
    const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared
      .map((s) => `<si>${s}</si>`)
      .join('')}</sst>`;
    return zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="People" sheetId="1" r:id="rId7"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/people.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(sst),
      'xl/worksheets/people.xml': strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    });
  }

  it('reads the first sheet through shared strings, inline strings and numbers', () => {
    const data = workbook(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>Ay&#351;e Y&#305;lmaz</t></is></c>' +
        '<c r="B3" t="s"><v>3</v></c><c r="C3"><v>9.05551234567E+11</v></c></row>',
      [
        '<t>Name</t>',
        '<t>E-Posta</t>',
        '<t>Phone</t>',
        '<r><t>ayse</t></r><r><t>@example.com</t></r><rPh><t>ignored</t></rPh>',
      ],
    );

    expect(isXlsx(data)).toBe(true);
    expect(readXlsx(data)).toEqual([
      { rowNumber: 1, cells: ['Name', 'E-Posta', 'Phone'] },
      { rowNumber: 3, cells: ['Ayşe Yılmaz', 'ayse@example.com', '905551234567'] },
    ]);
  });

  it('fills a gap between cells so each value stays in its column', () => {
    const data = workbook('<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="D2"><v>4</v></c></row>');
    expect(readXlsx(data)[0]!.cells).toEqual(['x', '', '', '4']);
  });

  it('decodes entities and the escapes OOXML uses for control characters, and nothing else', () => {
    const data = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>R&amp;D_x000D_&#0;&lt;ok&gt;</t></is></c></row>');
    expect(readXlsx(data)[0]!.cells[0]).toBe('R&D\r<ok>');
  });

  it('refuses a file that is not a spreadsheet', () => {
    expect(() => readXlsx(strToU8('PK\x03\x04 not really a zip'))).toThrow(SpreadsheetError);
    expect(() => readXlsx(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow(SpreadsheetError);
  });

  it('numbers columns the way a spreadsheet does', () => {
    expect([columnIndex('A1'), columnIndex('Z9'), columnIndex('AA10'), columnIndex('AZ2')]).toEqual([0, 25, 26, 51]);
  });
});

describe('decoding text', () => {
  it('reads UTF-8, UTF-16 with a byte-order mark, and Windows-1254 from older Turkish Excel', () => {
    expect(decodeText(strToU8('Ayşe;Yılmaz'))).toBe('Ayşe;Yılmaz');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe('AB');
    // "Ş" and "ı" in Windows-1254 are 0xDE and 0xFD — not valid UTF-8 on their own.
    expect(decodeText(new Uint8Array([0xde, 0x61, 0x68, 0xfd, 0x6e]))).toBe('Şahın');
  });
});
