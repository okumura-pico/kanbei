// Abstract repo I/O surface so the orchestrator can be unit-tested
// against an in-memory fake. The Octokit-backed implementation lives
// alongside (octokitRepoState.ts) and is verified by integration tests.

export interface IssueData {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
}

export interface CommentData {
  id: number;
  body: string;
  user: { login: string; type: 'User' | 'Bot' };
}

export interface IssuePatch {
  body?: string;
  labels?: string[];
}

export interface RepoState {
  getIssue(issueNumber: number): Promise<IssueData>;
  getComments(issueNumber: number): Promise<CommentData[]>;
  listIssuesWithAnyLabel(labels: string[]): Promise<IssueData[]>;
  updateIssue(issueNumber: number, patch: IssuePatch): Promise<void>;
  addComment(issueNumber: number, body: string): Promise<void>;
}
