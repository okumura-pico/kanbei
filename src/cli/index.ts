#!/usr/bin/env node
// Kanbei CLI entry point.
//
// Basic usage:
//   kanbei https://github.com/owner/repo           # scan repo for kanbei-labeled issues
//   kanbei https://github.com/owner/repo/issues/N  # drive a single issue one cycle
//
// The orchestrator and agents land through P1–P4; this entry just
// parses the URL and reports what it would do.

import { Command } from 'commander';
import { parseGithubTarget } from '../github/url.js';

const program = new Command();

program
  .name('kanbei')
  .description('Issue-driven multi-agent AI development system')
  .version('0.0.0')
  .argument(
    '<github-url>',
    'GitHub repository URL (e.g. https://github.com/owner/repo) or Issue URL (.../issues/N)',
  )
  .option('--dry-run', 'Do not write to GitHub; only print intended actions')
  .action((githubUrl: string, options: { dryRun?: boolean }) => {
    const target = parseGithubTarget(githubUrl);
    if (!target) {
      console.error(
        `kanbei: could not parse "${githubUrl}" as a GitHub repository or Issue URL.`,
      );
      console.error('       expected e.g. https://github.com/owner/repo[/issues/N]');
      process.exit(64);
    }

    const mode = target.issue !== undefined ? 'single-issue' : 'repo-scan';
    const dryRun = options.dryRun ? ' (dry-run)' : '';
    if (target.issue !== undefined) {
      console.error(
        `kanbei: would drive ${target.owner}/${target.repo} issue #${target.issue}${dryRun} — orchestrator not yet implemented (see docs/01-architecture.md §9).`,
      );
    } else {
      console.error(
        `kanbei: would scan ${target.owner}/${target.repo} for kanbei-labeled issues${dryRun} — orchestrator not yet implemented (see docs/01-architecture.md §9).`,
      );
    }
    // Exit code 2 = command recognised but not yet runnable. Will become 0
    // once the orchestrator lands.
    void mode;
    process.exit(2);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
