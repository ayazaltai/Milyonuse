import { describe, expect, it } from 'vitest';
import { en } from './dictionaries/en';
import { tr } from './dictionaries/tr';
import { resolveLocale } from './index';

/** Every leaf path of a dictionary, functions included. */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}

describe('dictionaries', () => {
  it('give Turkish every key English has, and no other', () => {
    expect(paths(tr).sort()).toEqual(paths(en).sort());
  });

  it('leave no Turkish string empty that English fills, apart from word-order glue', () => {
    const glue = new Set(['auth.acceptTermsBefore']);
    const empty = paths(tr).filter((path) => {
      const read = (dict: unknown) =>
        path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], dict);
      return read(tr) === '' && read(en) !== '' && !glue.has(path);
    });
    expect(empty).toEqual([]);
  });
});

describe('resolveLocale', () => {
  it('keeps a language someone chose', () => {
    expect(resolveLocale('tr')).toBe('tr');
  });

  it('is English otherwise — whatever the browser prefers', () => {
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('fr')).toBe('en');
  });
});
