import { describe, expect, it } from 'vitest';
import {
  filterKanbeiComments,
  isKanbeiComment,
  parseKanbeiCommentMarker,
  wrapComment,
} from '../../src/github/comments.js';

describe('wrapComment', () => {
  it('prefixes the body with the agent + version marker', () => {
    expect(wrapComment('listener', 'Hello')).toBe('<!-- kanbei:listener v1 -->\n\nHello');
  });

  it('supports a custom version number', () => {
    expect(wrapComment('spec', 'Hi', 3)).toBe('<!-- kanbei:spec v3 -->\n\nHi');
  });

  it('rejects an unknown agent name', () => {
    // @ts-expect-error - exercising the runtime guard with a bad value
    expect(() => wrapComment('hacker', 'x')).toThrow();
  });
});

describe('isKanbeiComment', () => {
  it('detects the marker at the very start of a comment body', () => {
    expect(isKanbeiComment(wrapComment('builder', 'whatever'))).toBe(true);
  });

  it('returns false for human-authored comments', () => {
    expect(isKanbeiComment('Looks good, ship it!')).toBe(false);
    expect(isKanbeiComment('I think kanbei is a great name.')).toBe(false);
  });

  it('returns false when the marker is later in the body (impersonation guard)', () => {
    expect(isKanbeiComment('Quoting:\n<!-- kanbei:listener v1 -->\nfoo')).toBe(false);
  });

  it('accepts a version-less marker for forward compatibility', () => {
    expect(isKanbeiComment('<!-- kanbei:listener -->\n\nhi')).toBe(true);
  });
});

describe('parseKanbeiCommentMarker', () => {
  it('extracts agent and version from a wrapped comment', () => {
    expect(parseKanbeiCommentMarker(wrapComment('architect', 'x', 2))).toEqual({
      agent: 'architect',
      version: 2,
    });
  });

  it('returns null for non-Kanbei comments', () => {
    expect(parseKanbeiCommentMarker('plain text')).toBeNull();
  });
});

describe('filterKanbeiComments', () => {
  it('drops comments whose body starts with the Kanbei marker', () => {
    const comments = [
      { id: 1, body: 'human one' },
      { id: 2, body: wrapComment('listener', 'bot question') },
      { id: 3, body: 'human two' },
      { id: 4, body: wrapComment('spec', 'bot proposal', 2) },
    ];
    const filtered = filterKanbeiComments(comments);
    expect(filtered.map((c) => c.id)).toEqual([1, 3]);
  });

  it('keeps comments with empty or null body unchanged', () => {
    const comments = [
      { id: 1, body: '' },
      { id: 2, body: null },
      { id: 3, body: wrapComment('builder', 'b') },
    ];
    expect(filterKanbeiComments(comments).map((c) => c.id)).toEqual([1, 2]);
  });
});
