// Octokit-backed RepoState. Wraps @octokit/rest so the orchestrator
// can hit real GitHub. See docs/01-architecture.md §7.
//
// Pagination is delegated to octokit.paginate so listings beyond 100
// items are handled transparently.

import type { Octokit } from '@octokit/rest';
import type {
  CommentData,
  IssueData,
  IssuePatch,
  RepoState,
} from './repoState.js';

export interface RepoCoords {
  owner: string;
  repo: string;
}

interface OctokitLabel {
  name?: string;
}

type ApiLabel = string | OctokitLabel;

function normaliseLabels(labels: ApiLabel[] | undefined): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const l of labels) {
    if (typeof l === 'string') {
      out.push(l);
    } else if (l.name) {
      out.push(l.name);
    }
  }
  return out;
}

function normaliseUserType(type: string | undefined): 'User' | 'Bot' {
  return type === 'Bot' ? 'Bot' : 'User';
}

export class OctokitRepoState implements RepoState {
  constructor(
    private readonly octokit: Octokit,
    private readonly coords: RepoCoords,
  ) {}

  async getIssue(issueNumber: number): Promise<IssueData> {
    const { data } = await this.octokit.rest.issues.get({
      owner: this.coords.owner,
      repo: this.coords.repo,
      issue_number: issueNumber,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      labels: normaliseLabels(data.labels as ApiLabel[]),
      author: data.user?.login ?? 'unknown',
    };
  }

  async getComments(issueNumber: number): Promise<CommentData[]> {
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      owner: this.coords.owner,
      repo: this.coords.repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    return comments.map((c) => ({
      id: c.id,
      body: c.body ?? '',
      user: {
        login: c.user?.login ?? 'unknown',
        type: normaliseUserType(c.user?.type),
      },
    }));
  }

  async listIssuesWithAnyLabel(labels: string[]): Promise<IssueData[]> {
    const seen = new Map<number, IssueData>();
    for (const label of labels) {
      const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: this.coords.owner,
        repo: this.coords.repo,
        labels: label,
        state: 'open',
        per_page: 100,
      });
      for (const i of issues) {
        if (i.pull_request) continue; // listForRepo returns PRs too
        if (seen.has(i.number)) continue;
        seen.set(i.number, {
          number: i.number,
          title: i.title,
          body: i.body ?? '',
          labels: normaliseLabels(i.labels as ApiLabel[]),
          author: i.user?.login ?? 'unknown',
        });
      }
    }
    return [...seen.values()];
  }

  async updateIssue(issueNumber: number, patch: IssuePatch): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.coords.owner,
      repo: this.coords.repo,
      issue_number: issueNumber,
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.labels !== undefined ? { labels: patch.labels } : {}),
    });
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({
      owner: this.coords.owner,
      repo: this.coords.repo,
      issue_number: issueNumber,
      body,
    });
  }
}
