/**
 * The YAML a SKILL.md's frontmatter needs, and no more (ported from Agent 5.5
 * `skills/model.py`, which used PyYAML's safe loader): mappings by
 * indentation, lists of scalars, quoted and plain scalars, numbers and
 * booleans. No anchors, tags, flow collections or multi-line strings — a
 * skill that needs them is refused, never half-read.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class FrontmatterError extends Error {
  override name = 'FrontmatterError';
}

function scalar(raw: string): YamlValue {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    const inner = v.slice(1, -1);
    return v.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  if (/^[[{&*!|>]/.test(v)) throw new FrontmatterError(`unsupported YAML: ${v.slice(0, 20)}`);
  return v.replace(/\s+#.*$/, '');
}

interface Line {
  indent: number;
  text: string;
  n: number;
}

export function parseYaml(source: string): { [key: string]: YamlValue } {
  const lines: Line[] = source
    .split(/\r?\n/)
    .map((raw, n) => ({ indent: raw.length - raw.trimStart().length, text: raw.trim(), n: n + 1 }))
    .filter((l) => l.text !== '' && !l.text.startsWith('#'));
  if (lines.some((l) => /\t/.test(l.text))) throw new FrontmatterError('tabs are not allowed in YAML');
  let i = 0;

  function block(indent: number): YamlValue {
    if (i < lines.length && lines[i]!.text.startsWith('- ') && lines[i]!.indent >= indent) return list(lines[i]!.indent);
    return map(indent);
  }

  function list(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (i < lines.length && lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')) {
      out.push(scalar(lines[i]!.text.slice(2)));
      i += 1;
    }
    return out;
  }

  function map(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    while (i < lines.length && lines[i]!.indent >= indent) {
      const line = lines[i]!;
      if (line.indent > indent) throw new FrontmatterError(`unexpected indentation on line ${line.n}`);
      const m = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line.text);
      if (!m) throw new FrontmatterError(`expected "key: value" on line ${line.n}`);
      const key = m[1]!;
      if (key in out) throw new FrontmatterError(`duplicate key "${key}" on line ${line.n}`);
      i += 1;
      if (m[2] !== undefined && m[2].trim() !== '') {
        out[key] = scalar(m[2]);
      } else if (i < lines.length && (lines[i]!.indent > indent || (lines[i]!.indent === indent && lines[i]!.text.startsWith('- ')))) {
        out[key] = block(lines[i]!.indent);
      } else {
        out[key] = null;
      }
    }
    return out;
  }

  const result = map(0);
  if (i < lines.length) throw new FrontmatterError(`could not read line ${lines[i]!.n}`);
  return result;
}

function needsQuotes(v: string): boolean {
  return v === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]|:\s|\s#|\s$|^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v) || /\n/.test(v);
}

export function renderYaml(value: { [key: string]: YamlValue }, indent = 0): string {
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      out.push(`${pad}${key}:`);
      for (const item of v) out.push(`${pad}- ${render(item)}`);
    } else if (v && typeof v === 'object') {
      const inner = renderYaml(v, indent + 2);
      if (inner) out.push(`${pad}${key}:\n${inner}`);
    } else if (v !== null) {
      out.push(`${pad}${key}: ${render(v)}`);
    }
  }
  return out.join('\n');
}

function render(v: YamlValue): string {
  if (typeof v === 'string') return needsQuotes(v) ? JSON.stringify(v) : v;
  return String(v);
}
