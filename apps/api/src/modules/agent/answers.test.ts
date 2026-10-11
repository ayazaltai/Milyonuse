import { describe, expect, it } from 'vitest';
import { forModel, forPage, isSourceAnswer, keepSource, newSourceId, SOURCE_ID } from './answers.js';
import { MODEL_CHARS, fit, omissionLine, omittedOf } from './fit.js';
import { at, cell, firstList, labelOf } from './tools/present.tool.js';

/**
 * Answers, fitted and laid out: what the model rereads is valid and says what
 * it left out; what a card shows comes from the tool's own answer.
 */

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `01J${String(i).padStart(23, '0')}`,
    fullName: `Person ${i + 1}`,
    email: `person-${i + 1}@example.test`,
    status: i % 3 === 0 ? 'invited' : 'new',
    notes: 'x'.repeat(300),
  }));

describe('fitting an answer', () => {
  it('leaves a small answer exactly as it is', () => {
    const value = { total: 2, items: people(2) };
    const fitted = fit(value, MODEL_CHARS);
    expect(fitted.shortened).toBe(false);
    expect(JSON.parse(fitted.json)).toEqual(value);
  });

  it('shrinks a large one by structure: valid JSON, first items kept, the whole count said', () => {
    const fitted = fit({ total: 1240, items: people(1240) }, MODEL_CHARS);
    expect(fitted.json.length).toBeLessThanOrEqual(MODEL_CHARS);
    expect(fitted.shortened).toBe(true);
    const parsed = JSON.parse(fitted.json) as { total: number; items: unknown[] };
    expect(parsed.total).toBe(1240);
    expect((parsed.items[0] as { fullName: string }).fullName).toBe('Person 1');
    const closing = omittedOf(parsed.items.at(-1));
    expect(closing).toEqual({ more: 1240 - (parsed.items.length - 1), all: 1240 });
  });

  it('keeps the whole count when a list already shortened is shortened again', () => {
    const once = fit({ items: people(5000) }, 190_000);
    const twice = fit(once.value, MODEL_CHARS);
    const items = (JSON.parse(twice.json) as { items: unknown[] }).items;
    expect(omittedOf(items.at(-1))?.all).toBe(5000);
  });

  it('says plainly when nothing structural is enough', () => {
    let deep: unknown = 'x'.repeat(50);
    for (let i = 0; i < 400; i += 1) deep = { [`k${i}`]: deep, [`n${i}`]: 'y'.repeat(70) };
    const fitted = fit(deep, 2000);
    expect(fitted.json.length).toBeLessThanOrEqual(2000);
    expect(() => JSON.parse(fitted.json)).not.toThrow();
    expect(fitted.shortened).toBe(true);
  });

  it('reads an omission line back', () => {
    expect(omittedOf(omissionLine(1190, 1240))).toEqual({ more: 1190, all: 1240 });
    expect(omittedOf('… nothing here')).toBeNull();
    expect(omittedOf(3)).toBeNull();
  });
});

describe('what the model rereads', () => {
  it('a read kept as a source: its handle and where it came from, fitted, with a note when shortened', () => {
    const id = newSourceId();
    expect(id).toMatch(SOURCE_ID);
    const kept = keepSource(id, 'Read the table', { total: 1240, items: people(1240) });
    expect(isSourceAnswer(JSON.parse(kept))).toBe(true);

    const reread = forModel(kept, 'read_table');
    expect(reread.length).toBeLessThanOrEqual(MODEL_CHARS);
    const parsed = JSON.parse(reread) as { source: string; from: string; note: string; result: { total: number } };
    expect(parsed).toMatchObject({ source: id, from: 'Read the table', result: { total: 1240 } });
    expect(parsed.note).toMatch(/call present with this source/);
  });

  it('a small source whole, untouched', () => {
    const kept = keepSource('src-abc123', 'Read the table', { total: 1, items: [{ title: 'Designer' }] });
    expect(forModel(kept, 'read_table')).toBe(kept);
  });

  it('an answer that is not JSON as text, cut at the limit', () => {
    const old = `{"items":[${'"a",'.repeat(4000)}… (cut short)`;
    expect(forModel(old, 'read_table')).toBe(`${old.slice(0, MODEL_CHARS)}… (cut short)`);
  });

  it('a card: that it is shown and how much — never its rows again', () => {
    const card = JSON.stringify({
      presented: true,
      title: 'Candidates',
      layout: 'table',
      origin: 'platform',
      source: { id: 'src-abc123', from: 'Read the table', at: '2026-10-03T10:00:00.000Z' },
      columns: ['Full name'],
      rows: people(300).map((p) => [p.fullName]),
      shown: 300,
      total: 1240,
    });
    const reread = JSON.parse(forModel(card, 'present')) as Record<string, unknown>;
    expect(reread).toMatchObject({ presented: true, source: 'src-abc123', shown: 300, total: 1240 });
    expect(reread['rows']).toBeUndefined();
    // The page gets the card whole.
    expect(forPage(card, 'present')).toBe(card);
  });
});

describe('laying a source out', () => {
  it('finds values by path, and the first list in an answer', () => {
    const answer = { credits: { pool: { available: 40 } }, page: { total: 3, items: [{ a: 1 }, { a: 2 }] } };
    expect(at(answer, 'credits.pool.available')).toBe(40);
    expect(at(answer, 'page.items.1.a')).toBe(2);
    expect(at(answer, 'nothing.here')).toBeUndefined();
    expect(firstList(answer)).toEqual({ list: [{ a: 1 }, { a: 2 }], total: 3 });
  });

  it('counts the whole of a list kept shortened', () => {
    const list = [{ a: 1 }, { a: 2 }, omissionLine(98, 100)];
    expect(firstList({ items: list })).toEqual({ list: [{ a: 1 }, { a: 2 }], total: 100 });
  });

  it('writes cells and headings a person reads', () => {
    expect(cell(3)).toBe(3);
    expect(cell(true)).toBe('Yes');
    expect(cell(null)).toBeNull();
    expect(cell(['en', 'tr'])).toBe('en, tr');
    expect(cell({ id: 'x', title: 'Backend Engineer' })).toBe('Backend Engineer');
    expect(cell([{ a: 1 }, { a: 2 }])).toBe('2 items');
    expect(labelOf('fullName')).toBe('Full name');
    expect(labelOf('position.created_at')).toBe('Created at');
  });
});
