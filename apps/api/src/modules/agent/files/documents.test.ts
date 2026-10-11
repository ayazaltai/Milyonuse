import { strToU8, zipSync } from 'fflate';
import PDFDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { DocumentError, docxText, extractDocument, isDocx, isPdf } from './documents.js';

/** A Word document as Word writes one, cut to what its text needs. */
function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(
      (p) =>
        `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`,
    )
    .join('');
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="w"><w:body>${body}<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
}

/** A PDF with text on its pages — or, with no lines, only a drawing. */
function pdf(pages: string[][]): Promise<Uint8Array> {
  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Uint8Array>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );
  for (const lines of pages) {
    doc.addPage();
    if (lines.length === 0) doc.rect(50, 50, 200, 100).fill('#000000');
    for (const line of lines) doc.font('Helvetica').fontSize(12).text(line);
  }
  doc.end();
  return done;
}

describe('documents handed to the agent', () => {
  it('reads a Word document’s paragraphs, tabs and Turkish letters', async () => {
    const file = docx([
      'Ayşe Yılmaz',
      'ayse@example.com · +90 532 000 00 00',
      'Kıdemli veri mühendisi & ekip lideri',
    ]);
    expect(isDocx(file)).toBe(true);
    expect(isPdf(file)).toBe(false);
    expect(docxText(file)).toBe(
      'Ayşe Yılmaz\nayse@example.com · +90 532 000 00 00\nKıdemli veri mühendisi & ekip lideri\nA\tB',
    );
    const read = await extractDocument(file);
    expect(read).toMatchObject({ pages: null, truncated: false });
  });

  it('reads a PDF’s text, page by page', async () => {
    const file = await pdf([
      ['Grace Hopper', 'grace@example.com', 'Rear admiral, compiler pioneer.'],
      ['Experience: COBOL, UNIVAC, Harvard Mark I.'],
    ]);
    expect(isPdf(file)).toBe(true);
    const read = await extractDocument(file);
    expect(read.pages).toBe(2);
    expect(read.text).toContain('grace@example.com');
    expect(read.text).toContain('UNIVAC');
  });

  it('refuses a scanned PDF, a file that is neither, and a document past its pages', async () => {
    await expect(extractDocument(await pdf([[]]))).rejects.toThrow(/scanned/);
    await expect(extractDocument(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(
      DocumentError,
    );
    const long = await pdf(
      Array.from({ length: 51 }, (_, i) => [`Page ${i + 1} of a long handbook.`]),
    );
    await expect(extractDocument(long)).rejects.toThrow(/up to 50 pages/);
  });

  it('keeps 200,000 characters of a longer document, and says so', async () => {
    const read = await extractDocument(docx(Array.from({ length: 2100 }, () => 'x'.repeat(99))));
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(200_000);
  });
});
