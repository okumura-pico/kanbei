import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { OctokitRepoState } from '../../src/github/octokitRepoState.js';

interface FakeCalls {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  paginate: ReturnType<typeof vi.fn>;
}

function makeFakeOctokit(): { octokit: Octokit; calls: FakeCalls } {
  const calls: FakeCalls = {
    get: vi.fn(),
    update: vi.fn(),
    createComment: vi.fn(),
    paginate: vi.fn(),
  };
  const fake = {
    rest: {
      issues: {
        get: calls.get,
        update: calls.update,
        createComment: calls.createComment,
        // listComments and listForRepo are referenced when calling paginate(method, ...)
        // but they're never invoked directly in our code, so a stub identity is fine.
        listComments: vi.fn(),
        listForRepo: vi.fn(),
      },
    },
    paginate: calls.paginate,
  };
  return { octokit: fake as unknown as Octokit, calls };
}

const COORDS = { owner: 'octocat', repo: 'Hello-World' };

describe('OctokitRepoState.getIssue', () => {
  it('maps Octokit response into IssueData', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.get.mockResolvedValue({
      data: {
        number: 7,
        title: 'Hi',
        body: 'body',
        labels: [{ name: 'kanbei:spec' }, 'bug'],
        user: { login: 'alice' },
      },
    });
    const repo = new OctokitRepoState(octokit, COORDS);
    const issue = await repo.getIssue(7);
    expect(issue).toEqual({
      number: 7,
      title: 'Hi',
      body: 'body',
      labels: ['kanbei:spec', 'bug'],
      author: 'alice',
    });
    expect(calls.get).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'Hello-World',
      issue_number: 7,
    });
  });

  it('normalises null body and missing user', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.get.mockResolvedValue({
      data: { number: 1, title: 't', body: null, labels: [], user: null },
    });
    const repo = new OctokitRepoState(octokit, COORDS);
    const issue = await repo.getIssue(1);
    expect(issue.body).toBe('');
    expect(issue.author).toBe('unknown');
  });
});

describe('OctokitRepoState.getComments', () => {
  it('paginates through all comments and maps them', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.paginate.mockResolvedValue([
      { id: 1, body: 'a', user: { login: 'alice', type: 'User' } },
      { id: 2, body: null, user: null },
      { id: 3, body: 'c', user: { login: 'bot[bot]', type: 'Bot' } },
    ]);
    const repo = new OctokitRepoState(octokit, COORDS);
    const comments = await repo.getComments(7);
    expect(comments).toEqual([
      { id: 1, body: 'a', user: { login: 'alice', type: 'User' } },
      { id: 2, body: '', user: { login: 'unknown', type: 'User' } },
      { id: 3, body: 'c', user: { login: 'bot[bot]', type: 'Bot' } },
    ]);
    expect(calls.paginate).toHaveBeenCalledOnce();
    const [, params] = calls.paginate.mock.calls[0]!;
    expect(params).toMatchObject({
      owner: 'octocat',
      repo: 'Hello-World',
      issue_number: 7,
      per_page: 100,
    });
  });
});

describe('OctokitRepoState.listIssuesWithAnyLabel', () => {
  it('queries once per label, dedupes by issue number, and skips PRs', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.paginate
      .mockResolvedValueOnce([
        { number: 1, title: 'a', body: 'x', labels: ['kanbei:spec'], user: { login: 'u' } },
        { number: 99, title: 'pr', body: '', labels: ['kanbei:spec'], user: { login: 'u' }, pull_request: {} },
      ])
      .mockResolvedValueOnce([
        { number: 1, title: 'a', body: 'x', labels: ['kanbei:spec'], user: { login: 'u' } },
        { number: 2, title: 'b', body: 'y', labels: ['kanbei:arch'], user: { login: 'u' } },
      ]);
    const repo = new OctokitRepoState(octokit, COORDS);
    const issues = await repo.listIssuesWithAnyLabel(['kanbei:spec', 'kanbei:arch']);
    expect(issues.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(calls.paginate).toHaveBeenCalledTimes(2);
  });
});

describe('OctokitRepoState.updateIssue', () => {
  it('only forwards fields that are present in the patch', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.update.mockResolvedValue({});
    const repo = new OctokitRepoState(octokit, COORDS);

    await repo.updateIssue(5, { labels: ['kanbei:arch'] });
    expect(calls.update).toHaveBeenLastCalledWith({
      owner: 'octocat',
      repo: 'Hello-World',
      issue_number: 5,
      labels: ['kanbei:arch'],
    });

    await repo.updateIssue(5, { body: 'new body' });
    expect(calls.update).toHaveBeenLastCalledWith({
      owner: 'octocat',
      repo: 'Hello-World',
      issue_number: 5,
      body: 'new body',
    });
  });
});

describe('OctokitRepoState.addComment', () => {
  it('posts the comment body', async () => {
    const { octokit, calls } = makeFakeOctokit();
    calls.createComment.mockResolvedValue({});
    const repo = new OctokitRepoState(octokit, COORDS);
    await repo.addComment(5, 'hello');
    expect(calls.createComment).toHaveBeenCalledWith({
      owner: 'octocat',
      repo: 'Hello-World',
      issue_number: 5,
      body: 'hello',
    });
  });
});
