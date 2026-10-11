import type { ReactNode } from 'react';

/**
 * The agent's words, as paragraphs, headings, lists, tables, code and
 * emphasis — the Markdown a model writes (ported from App-Milyonus
 * `(dashboard)/agent/message-text.tsx`, with headings, tables, code blocks
 * and outside links added).
 *
 * Built as elements, never as HTML: what a model says is text, and a page
 * that injected it would run whatever it was told to write. A link is kept
 * only when it points inside the product or to an http(s) address, and an
 * outside one opens in a new tab without a referrer.
 */
export function MessageText({ text }: { text: string }) {
  return <div className="agent-text">{blocksOf(text.replace(/\r\n/g, '\n'))}</div>;
}

function blocksOf(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // A fenced block is taken whole first: blank lines inside it are its own.
  const parts = text.split(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/m);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      out.push(
        <pre key={`code-${index}`} className="agent-code-block">
          <code>{part.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    for (const [i, block] of part.split(/\n{2,}/).entries()) {
      if (block.trim() === '') continue;
      out.push(paragraph(block, `${index}-${i}`));
    }
  });
  return out;
}

function paragraph(block: string, key: string): ReactNode {
  const lines = block.split('\n').filter((l) => l.trim() !== '');
  if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
    return (
      <ul key={key}>
        {lines.map((l, j) => (
          <li key={j}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
        ))}
      </ul>
    );
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return (
      <ol key={key}>
        {lines.map((l, j) => (
          <li key={j}>{inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>
        ))}
      </ol>
    );
  }
  if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|')) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[1]!)) {
    const cells = (line: string) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const [head, , ...body] = lines;
    return (
      <div key={key} className="agent-data-table-wrap">
        <table className="agent-data-table">
          <thead>
            <tr>
              {cells(head!).map((c, j) => (
                <th key={j}>{inline(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r}>
                {cells(row).map((c, j) => (
                  <td key={j}>{inline(c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0]!)) {
    return (
      <p key={key} className="agent-heading">
        {inline(lines[0]!.replace(/^#{1,6}\s+/, ''))}
      </p>
    );
  }
  if (lines.every((l) => /^>\s?/.test(l))) {
    return <blockquote key={key}>{inline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}</blockquote>;
  }
  return (
    <p key={key}>
      {lines.map((l, j) => (
        <span key={j}>
          {j > 0 && <br />}
          {inline(l.replace(/^#{1,6}\s+/, ''))}
        </span>
      ))}
    </p>
  );
}

const TOKEN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*)/g;

function inline(text: string): ReactNode[] {
  return text.split(TOKEN).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*\s][^*]*\*$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part)) {
      return (
        <code key={i} className="agent-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      if (href!.startsWith('/') && !href!.startsWith('//')) {
        return (
          <a key={i} href={href} className="link-inline">
            {label}
          </a>
        );
      }
      if (/^https?:\/\//i.test(href!)) {
        return (
          <a key={i} href={href} className="link-inline" target="_blank" rel="noopener noreferrer nofollow">
            {label}
          </a>
        );
      }
      return <span key={i}>{label}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}
