import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { looksLikeTable } from './agent-parts';
import { MessageText } from './message-text';

const html = (text: string) => renderToStaticMarkup(<MessageText text={text} />);

describe('the agent’s words on the page', () => {
  it('are text, never markup: what a model writes cannot run', () => {
    const out = html('<img src=x onerror=alert(1)> **bold**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('keep a link inside the product or to http(s), and only the words of any other', () => {
    expect(html('[Settings](/app/settings/profile)')).toContain('href="/app/settings/profile"');
    const outside = html('[Docs](https://example.com/guide)');
    expect(outside).toContain('href="https://example.com/guide"');
    expect(outside).toContain('rel="noopener noreferrer nofollow"');
    const script = html('[Click](javascript:alert(1))');
    expect(script).not.toContain('href');
    expect(script).toContain('Click');
  });

  it('lay out lists, headings, tables and code blocks', () => {
    expect(html('- one\n- two')).toContain('<ul><li>');
    expect(html('## Plan')).toContain('class="agent-heading"');
    expect(html('| Day | Place |\n| --- | --- |\n| Sat | Alfama |')).toContain('<td><span>Alfama</span></td>');
    const code = html('Run:\n\n```sh\necho "hi"\n\nls\n```');
    expect(code).toContain('<pre class="agent-code-block"><code>echo &quot;hi&quot;\n\nls</code></pre>');
  });
});

describe('a paste', () => {
  it('reads as a table when several lines are separated by tabs', () => {
    expect(looksLikeTable('Name\tCity\nAda\tLondon\nGrace\tNew York')).toBe(true);
    expect(looksLikeTable('Just a sentence, with a comma.')).toBe(false);
    expect(looksLikeTable('a\tb\nc')).toBe(false);
  });
});
