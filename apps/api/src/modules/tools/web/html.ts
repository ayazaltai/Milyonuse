/**
 * A web page as text the model can read: what a person would read on it,
 * without scripts, styles, navigation chrome or markup — headings, paragraphs,
 * lists, tables as lines, links kept as their words. Small and dependency-free;
 * it does not need to render a page, only to read one.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  euro: '€', pound: '£', yen: '¥', deg: '°', middot: '·', bull: '•', times: '×', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return NAMED[code.toLowerCase()] ?? match;
  });
}

export interface PageText {
  title: string | null;
  description: string | null;
  text: string;
  links: { text: string; url: string }[];
}

const DROP = /<(script|style|noscript|svg|template|iframe|canvas|nav|footer|form|button|select)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<\/?(p|div|section|article|main|header|aside|blockquote|pre|table|thead|tbody|tfoot|tr|ul|ol|dl|dt|dd|figure|figcaption|address|details|summary|hr)\b[^>]*>/gi;

export function htmlToText(html: string, baseUrl?: string): PageText {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description =
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(html)?.[1];
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  body = body.replace(/<!--[\s\S]*?-->/g, '').replace(DROP, ' ');
  const links: { text: string; url: string }[] = [];
  body = body.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const words = clean(decodeEntities(inner.replace(/<[^>]+>/g, ' ')));
    try {
      const url = new URL(decodeEntities(href), baseUrl).toString();
      if (words && /^https?:/.test(url) && links.length < 50) links.push({ text: words.slice(0, 120), url });
    } catch {
      // A link that is not a URL is only its words.
    }
    return ` ${words} `;
  });
  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => clean(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    title: title ? clean(decodeEntities(title)) || null : null,
    description: description ? clean(decodeEntities(description)) || null : null,
    text,
    links,
  };
}

function clean(text: string): string {
  return text.replace(/[\t\f\v \u00a0]+/g, ' ').trim();
}
