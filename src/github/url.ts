// Parse GitHub repository / Issue URLs the CLI accepts.
// See docs/00-overview.md "CLI Usage" and docs/01-architecture.md §9.

export interface ParsedGithubTarget {
  owner: string;
  repo: string;
  /** Issue number when the URL points at /issues/<n>; otherwise undefined. */
  issue?: number;
}

const URL_RE =
  /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/issues\/(\d+))?\/?$/;

export function parseGithubTarget(input: string): ParsedGithubTarget | null {
  const match = URL_RE.exec(input.trim());
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  const issueStr = match[3];
  if (!owner || !repo) return null;
  const result: ParsedGithubTarget = { owner, repo };
  if (issueStr !== undefined) {
    const issue = Number(issueStr);
    if (!Number.isInteger(issue) || issue <= 0) return null;
    result.issue = issue;
  }
  return result;
}
