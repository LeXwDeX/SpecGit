import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TAG_CATALOG,
  TAG_MAX_LENGTH,
  classifyPool,
  fallbackColorFor,
  isTagSlug,
  resolveTagSelection,
  seedSpecsFor,
} from '../../../src/tags/catalog.js';
import { ISSUE_TITLE_TYPES } from '../../../src/cli/commands/issue.js';

describe('tag slug grammar', () => {
  const valid = [
    'bug',
    'enhancement',
    'kind::feat',
    'kind::fix',
    'module::auth',
    'feature::billing',
    'ui::cli',
    'a',
    'a1-b2::c3-d4',
  ];

  it.each(valid)('accepts %s', (slug) => {
    expect(isTagSlug(slug)).toBe(true);
  });

  const invalid = [
    '',
    'Kind::feat',
    'KIND',
    'kind::',
    '::feat',
    'ki:nd',
    'with space',
    'comma,split',
    'trailing-',
    '-lead',
    'double::colon::value',
    'kind::Feat',
    `kind::${'x'.repeat(TAG_MAX_LENGTH)}`,
    '标签',
  ];

  it.each(invalid)('rejects %j', (slug) => {
    expect(isTagSlug(slug)).toBe(false);
  });
});

describe('DEFAULT_TAG_CATALOG', () => {
  it('names one kind:: member per delivery type, same order', () => {
    expect(DEFAULT_TAG_CATALOG.map((spec) => spec.name)).toEqual(
      ISSUE_TITLE_TYPES.map((type) => `kind::${type}`)
    );
  });

  it('carries seed specs that satisfy the grammar and hex-color form', () => {
    for (const spec of DEFAULT_TAG_CATALOG) {
      expect(isTagSlug(spec.name)).toBe(true);
      expect(spec.color).toMatch(/^[0-9a-fA-F]{6}$/);
    }
  });
});

describe('classifyPool', () => {
  it('partitions existing labels without rewriting any of them', () => {
    const pool = classifyPool(['bug', 'Priority:High', 'kind::fix', '', 'kind::fix', 'ui 中文']);
    expect(pool.valid).toEqual(['bug', 'kind::fix']);
    expect(pool.dirty).toEqual(['Priority:High', 'ui 中文']);
  });
});

describe('resolveTagSelection', () => {
  const pool = ['bug', 'kind::fix', 'module::auth'];

  it('prefers pool members verbatim', () => {
    const result = resolveTagSelection(['bug', 'module::auth'], pool);
    expect(result).toEqual({ kind: 'ok', tags: ['bug', 'module::auth'] });
  });

  it('allows built-in catalog names absent from the pool (seedable)', () => {
    expect(resolveTagSelection(['kind::docs'], pool)).toEqual({ kind: 'ok', tags: ['kind::docs'] });
  });

  it('refuses off-grammar requests with zero side effects', () => {
    expect(resolveTagSelection(['Kind::X'], pool)).toEqual({ kind: 'invalid', slugs: ['Kind::X'] });
  });

  it('refuses unknown vocabulary not in pool or catalog', () => {
    expect(resolveTagSelection(['module::ghost'], pool)).toEqual({
      kind: 'unknown',
      slugs: ['module::ghost'],
    });
  });

  it('collapses duplicates and tolerates empty entries', () => {
    expect(resolveTagSelection(['kind::fix', '', 'kind::fix'], pool)).toEqual({
      kind: 'ok',
      tags: ['kind::fix'],
    });
  });
});

describe('seedSpecsFor', () => {
  it('seeds only what the pool lacks, colored from the catalog', () => {
    const specs = seedSpecsFor(['kind::fix', 'kind::docs', 'bug'], ['kind::fix', 'bug']);
    expect(specs).toEqual([{ name: 'kind::docs', color: expect.stringMatching(/^[0-9a-f]{6}$/i) }]);
  });

  it('never seeds a non-catalog name even when requested', () => {
    expect(seedSpecsFor(['mystery'], [])).toEqual([]);
  });

  it('seeds declared policy vocabulary with its own color, or a stable fallback', () => {
    const declared = [{ name: 'module::auth', color: '00FF00' }, { name: 'feature::billing', color: undefined as unknown as string }];
    expect(seedSpecsFor(['module::auth'], ['module::other'], [declared[0]])).toEqual([
      { name: 'module::auth', color: '00FF00' },
    ]);
    const fallback = seedSpecsFor(['feature::billing'], [], [
      { name: 'feature::billing', color: 'FFFFFF' },
    ]);
    expect(fallback).toEqual([{ name: 'feature::billing', color: 'FFFFFF' }]);
    expect(seedSpecsFor(['ui::cli'], [])).toEqual([]);
  });
});

describe('fallbackColorFor', () => {
  it('is deterministic and stays within the palette', () => {
    expect(fallbackColorFor('module::auth')).toBe(fallbackColorFor('module::auth'));
    expect(fallbackColorFor('module::billing')).toMatch(/^[0-9A-F]{6}$/);
  });
});
