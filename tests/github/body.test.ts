import { describe, expect, it } from 'vitest';
import { readSection, removeSection, upsertSection } from '../../src/github/body.js';

describe('upsertSection', () => {
  it('inserts a new section into an empty body', () => {
    const result = upsertSection('', 'SPEC', 'hello');
    expect(result).toBe('<!-- KANBEI_SPEC_START -->\nhello\n<!-- KANBEI_SPEC_END -->\n');
  });

  it('appends to a non-empty human body without touching the original text', () => {
    const human = 'I want a REST API for users.\n';
    const result = upsertSection(human, 'SPEC', 'spec body');
    expect(result.startsWith(human)).toBe(true);
    expect(result).toContain('<!-- KANBEI_SPEC_START -->\nspec body\n<!-- KANBEI_SPEC_END -->');
  });

  it('replaces existing section content in place (markers preserved)', () => {
    const body = 'pre\n\n<!-- KANBEI_SPEC_START -->\nold\n<!-- KANBEI_SPEC_END -->\n\npost';
    const result = upsertSection(body, 'SPEC', 'new');
    expect(result).toBe('pre\n\n<!-- KANBEI_SPEC_START -->\nnew\n<!-- KANBEI_SPEC_END -->\n\npost');
  });

  it('is idempotent: re-applying the same content yields the same body', () => {
    const start = 'human text\n';
    const once = upsertSection(start, 'SPEC', 'X');
    const twice = upsertSection(once, 'SPEC', 'X');
    expect(twice).toBe(once);
  });

  it('does not touch other sections when updating one', () => {
    let body = upsertSection('', 'SPEC', 'spec-v1');
    body = upsertSection(body, 'ARCH', 'arch-v1');
    const updated = upsertSection(body, 'SPEC', 'spec-v2');
    expect(updated).toContain('<!-- KANBEI_SPEC_START -->\nspec-v2\n<!-- KANBEI_SPEC_END -->');
    expect(updated).toContain('<!-- KANBEI_ARCH_START -->\narch-v1\n<!-- KANBEI_ARCH_END -->');
  });

  it('supports multi-line content', () => {
    const content = 'line 1\nline 2\n\nline 4';
    const result = upsertSection('', 'PLAN', content);
    expect(readSection(result, 'PLAN')).toBe(content);
  });

  it('rejects empty or invalid section names', () => {
    expect(() => upsertSection('', '', 'x')).toThrow();
    expect(() => upsertSection('', 'bad name', 'x')).toThrow();
    expect(() => upsertSection('', 'lower', 'x')).toThrow();
  });
});

describe('readSection', () => {
  it('returns the content between markers', () => {
    const body = upsertSection('', 'SPEC', 'hello');
    expect(readSection(body, 'SPEC')).toBe('hello');
  });

  it('returns null when the section is absent', () => {
    expect(readSection('arbitrary body', 'SPEC')).toBeNull();
  });

  it('returns null when markers are malformed (start without end)', () => {
    expect(readSection('<!-- KANBEI_SPEC_START -->\nhello', 'SPEC')).toBeNull();
  });
});

describe('removeSection', () => {
  it('removes the section and its markers, preserving the rest', () => {
    const body = upsertSection('human\n', 'SPEC', 'x');
    const result = removeSection(body, 'SPEC');
    expect(result).not.toContain('KANBEI_SPEC');
    expect(result).toContain('human');
  });

  it('is a no-op when the section is absent', () => {
    expect(removeSection('plain body', 'SPEC')).toBe('plain body');
  });
});
