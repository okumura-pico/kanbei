import { describe, expect, it } from 'vitest';
import { parseGithubTarget } from '../../src/github/url.js';

describe('parseGithubTarget', () => {
  it('parses a plain repo URL', () => {
    expect(parseGithubTarget('https://github.com/octocat/Hello-World')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('parses an Issue URL and extracts the issue number', () => {
    expect(parseGithubTarget('https://github.com/octocat/Hello-World/issues/42')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
      issue: 42,
    });
  });

  it('strips a .git suffix from the repo segment', () => {
    expect(parseGithubTarget('https://github.com/octocat/Hello-World.git')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(parseGithubTarget('https://github.com/octocat/Hello-World/')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
    });
    expect(parseGithubTarget('https://github.com/octocat/Hello-World/issues/7/')).toEqual({
      owner: 'octocat',
      repo: 'Hello-World',
      issue: 7,
    });
  });

  it('accepts http as well as https (we just won’t recommend it)', () => {
    expect(parseGithubTarget('http://github.com/a/b')).toEqual({ owner: 'a', repo: 'b' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseGithubTarget('  https://github.com/a/b  ')).toEqual({ owner: 'a', repo: 'b' });
  });

  it('rejects non-github hosts', () => {
    expect(parseGithubTarget('https://gitlab.com/a/b')).toBeNull();
    expect(parseGithubTarget('https://example.com/github.com/a/b')).toBeNull();
  });

  it('rejects URLs with extra path segments after the repo (e.g. /pulls/1)', () => {
    expect(parseGithubTarget('https://github.com/a/b/pulls/1')).toBeNull();
    expect(parseGithubTarget('https://github.com/a/b/tree/main')).toBeNull();
  });

  it('rejects non-numeric or non-positive issue numbers', () => {
    expect(parseGithubTarget('https://github.com/a/b/issues/abc')).toBeNull();
    expect(parseGithubTarget('https://github.com/a/b/issues/0')).toBeNull();
  });

  it('rejects empty input and obvious garbage', () => {
    expect(parseGithubTarget('')).toBeNull();
    expect(parseGithubTarget('not-a-url')).toBeNull();
    expect(parseGithubTarget('https://github.com/onlyowner')).toBeNull();
  });
});
