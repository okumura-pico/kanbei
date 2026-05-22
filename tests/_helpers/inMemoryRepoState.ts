import type {
  CommentData,
  IssueData,
  IssuePatch,
  RepoState,
} from '../../src/github/repoState.js';

interface IssueRecord extends IssueData {
  comments: CommentData[];
}

export class InMemoryRepoState implements RepoState {
  private readonly issues = new Map<number, IssueRecord>();
  private nextCommentId = 1000;

  /** Test helper to seed an issue. */
  addIssue(issue: IssueData, comments: CommentData[] = []): void {
    this.issues.set(issue.number, { ...issue, comments: [...comments] });
  }

  /** Test helper to inspect current state. */
  snapshot(issueNumber: number): IssueRecord {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`InMemoryRepoState: no issue #${issueNumber}`);
    return JSON.parse(JSON.stringify(issue)) as IssueRecord;
  }

  async getIssue(issueNumber: number): Promise<IssueData> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    const { comments: _comments, ...data } = issue;
    return { ...data, labels: [...data.labels] };
  }

  async getComments(issueNumber: number): Promise<CommentData[]> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    return issue.comments.map((c) => ({ ...c }));
  }

  async listIssuesWithAnyLabel(labels: string[]): Promise<IssueData[]> {
    const labelSet = new Set(labels);
    const matched: IssueData[] = [];
    for (const issue of this.issues.values()) {
      if (issue.labels.some((l) => labelSet.has(l))) {
        const { comments: _comments, ...data } = issue;
        matched.push({ ...data, labels: [...data.labels] });
      }
    }
    return matched;
  }

  async updateIssue(issueNumber: number, patch: IssuePatch): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    if (patch.body !== undefined) issue.body = patch.body;
    if (patch.labels !== undefined) issue.labels = [...patch.labels];
  }

  async addComment(issueNumber: number, body: string): Promise<void> {
    const issue = this.issues.get(issueNumber);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    issue.comments.push({
      id: this.nextCommentId++,
      body,
      user: { login: 'kanbei-bot[bot]', type: 'Bot' },
    });
  }
}
