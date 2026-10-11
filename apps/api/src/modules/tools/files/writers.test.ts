import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { safeName } from './file.store.js';
import { csv, docx, xlsx, xml } from './writers.js';

describe('the file writers', () => {
  it('write CSV that a spreadsheet opens as data, never as a formula', () => {
    const out = csv([['name', 'note'], ['Ada', '=HYPERLINK("http://evil")'], ['Grace', 'a, "quoted"\nline']]).toString('utf8');
    expect(out.startsWith('\ufeffname,note\r\n')).toBe(true);
    expect(out).toContain(`Ada,"'=HYPERLINK(""http://evil"")"`);
    expect(out).toContain('Grace,"a, ""quoted""\nline"');
  });

  it('write an XLSX whose numbers are numbers and whose text is text', () => {
    const files = unzipSync(xlsx([['City', 'Count'], ['İzmir', '42'], ['=1+1', '3.5']], 'Cities'));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<c r="B2"><v>42</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">İzmir</t>');
    expect(sheet).toContain('<t xml:space="preserve">=1+1</t>');
    expect(sheet).not.toContain('<f>');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="Cities"');
  });

  it('write a DOCX with headings and bullets, escaping what would be markup', () => {
    const files = unzipSync(docx('# Plan\n- one <b>\nPlain & simple', 'Title'));
    const doc = strFromU8(files['word/document.xml']!);
    expect(doc).toContain('<w:pStyle w:val="Title"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Plan');
    expect(doc).toContain('• one &lt;b&gt;');
    expect(doc).toContain('Plain &amp; simple');
  });

  it('escape XML and drop characters XML cannot hold', () => {
    expect(xml('a\u0001<"b">')).toBe('a&lt;&quot;b&quot;&gt;');
  });

  it('name a file with one segment, no path and no control characters', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..hidden')).toBe('hidden');
    expect(safeName('re\u0000port.csv')).toBe('report.csv');
    expect(safeName('///')).toBe('file');
  });
});
