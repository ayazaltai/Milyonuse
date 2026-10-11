import { AGENT_LIMITS } from '@milyonuse/contracts';
import { strFromU8, unzipSync } from 'fflate';

/**
 * Text out of a document handed to the agent (ported from App-Milyonus
 * `modules/agent/documents.ts`): a report, a contract, a CV, notes. Only the
 * text is kept — never the file — and only from documents that carry text: a
 * scanned PDF is refused with the reason, since the agent reads no images
 * yet (no OCR).
 */

/** Pages a document may have, and characters of text kept from it. */
export const DOCUMENT_LIMITS = { pages: AGENT_LIMITS.documentPages, characters: AGENT_LIMITS.documentChars } as const;

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

export interface ExtractedDocument {
  text: string;
  pages: number | null;
  /** The text went past the limit and was cut there. */
  truncated: boolean;
}

export function isPdf(data: Uint8Array): boolean {
  // "%PDF-", allowing a few bytes of junk some producers put first.
  const head = Buffer.from(data.subarray(0, 1024)).toString('latin1');
  return head.includes('%PDF-');
}

function isZip(data: Uint8Array): boolean {
  return (
    data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04
  );
}

/** A zip holding word/document.xml — a Word document, not a spreadsheet. */
export function isDocx(data: Uint8Array): boolean {
  if (!isZip(data)) return false;
  // The central directory names every entry in plain bytes.
  return Buffer.from(data).includes('word/document.xml');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

/** The document's body as text: paragraphs on their own lines, tabs and breaks kept. */
export function docxText(data: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, { filter: (f) => f.name === 'word/document.xml' });
  } catch {
    throw new DocumentError(
      'This Word document could not be opened. Save it again as .docx and attach that.',
    );
  }
  const xml = files['word/document.xml'];
  if (!xml) throw new DocumentError('This file has no Word document inside it.');
  const body = strFromU8(xml);
  // Only what is said: each text run, a tab or a break where the document has
  // one, and a new line at the end of every paragraph. The rest is markup.
  const out: string[] = [];
  for (const m of body.matchAll(
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<\/w:p>/g,
  )) {
    if (m[1] !== undefined) out.push(decode(m[1]));
    else if (m[0] === '<w:tab/>') out.push('\t');
    else out.push('\n');
  }
  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(data));
  } catch {
    throw new DocumentError(
      'This PDF could not be opened. It may be damaged or protected with a password.',
    );
  }
  if (pdf.numPages > DOCUMENT_LIMITS.pages) {
    throw new DocumentError(
      `Documents up to ${DOCUMENT_LIMITS.pages} pages can be attached; this one has ${pdf.numPages}.`,
    );
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  return {
    text: (text as string[])
      .map((page) => page.trim())
      .join('\n\n')
      .trim(),
    pages: totalPages,
  };
}

/** A PDF's or a Word document's text, within the limits — or why not. */
export async function extractDocument(data: Uint8Array): Promise<ExtractedDocument> {
  let text: string;
  let pages: number | null = null;
  if (isPdf(data)) {
    ({ text, pages } = await pdfText(data));
    // Under a few words for its pages: the pages are pictures of text.
    if (text.replace(/\s+/g, '').length < 20 * Math.max(1, Math.min(pages, 3))) {
      throw new DocumentError(
        'This PDF has no text in it — it looks scanned. Scanned documents cannot be read yet; attach a PDF with text, or the Word file.',
      );
    }
  } else if (isDocx(data)) {
    text = docxText(data);
    if (text === '') throw new DocumentError('This Word document has no text in it.');
  } else {
    throw new DocumentError('Only PDF and Word (.docx) documents can be attached as documents.');
  }
  const truncated = text.length > DOCUMENT_LIMITS.characters;
  return { text: truncated ? text.slice(0, DOCUMENT_LIMITS.characters) : text, pages, truncated };
}
