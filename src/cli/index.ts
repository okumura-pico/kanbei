#!/usr/bin/env node
// Kanbei CLI entry point.
//
// Basic usage:
//   kanbei https://github.com/owner/repo           # scan repo for kanbei-labeled issues
//   kanbei https://github.com/owner/repo/issues/N  # drive a single issue one cycle
//   kanbei init https://github.com/owner/repo      # create kanbei: labels on the repo
//
// See docs/03-setup.md for the .env / GitHub App prerequisites.

import { existsSync, readFileSync } from 'node:fs';
import { Command } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { runArchitect } from '../agents/architect.js';
import { runBuilder } from '../agents/builder.js';
import { runListener } from '../agents/listener.js';
import { runReviewer } from '../agents/reviewer.js';
import { runSpec } from '../agents/spec.js';
import { runTester } from '../agents/tester.js';
import { DEFAULT_KANBEI_CONFIG, loadKanbeiConfig } from '../config/index.js';
import { createGithubAppClient, loadGithubAppConfig } from '../github/client.js';
import { initLabels } from '../github/initLabels.js';
import { labelForPhase } from '../github/labels.js';
import { OctokitRepoState } from '../github/octokitRepoState.js';
import { parseGithubTarget } from '../github/url.js';
import { runIssue, type AgentRunner, type OrchestratorDeps } from '../orchestrator/index.js';
import { SafetyTracker } from '../safety/index.js';
import type { AgentName, KanbeiPhase } from '../types.js';

interface RunOptions {
  dryRun?: boolean;
  config: string;
}

interface InitOptions {
  config: string;
}

const ACTIVE_PHASES: KanbeiPhase[] = [
  'gathering',
  'spec',
  'arch',
  'building',
  'testing',
  'review',
];

function loadConfig(configPath: string) {
  if (existsSync(configPath)) {
    return loadKanbeiConfig(readFileSync(configPath, 'utf8'));
  }
  return DEFAULT_KANBEI_CONFIG;
}

async function runMain(githubUrl: string, options: RunOptions): Promise<number> {
  const target = parseGithubTarget(githubUrl);
  if (!target) {
    console.error(
      `kanbei: could not parse "${githubUrl}" as a GitHub repository or Issue URL.`,
    );
    console.error('       expected e.g. https://github.com/owner/repo[/issues/N]');
    return 64;
  }

  loadDotenv();
  const config = loadConfig(options.config);

  const safety = new SafetyTracker(config.safety, {
    disabled: process.env.KANBEI_DISABLED === 'true',
  });

  if (options.dryRun) {
    const where =
      target.issue !== undefined
        ? `${target.owner}/${target.repo}#${target.issue}`
        : `${target.owner}/${target.repo}`;
    console.error(`kanbei: dry-run — config loaded, target = ${where}`);
    console.error('kanbei: GitHub authentication and orchestrator dispatch skipped.');
    return 0;
  }

  const appConfig = loadGithubAppConfig(process.env);
  const octokit = createGithubAppClient(appConfig);
  const repo = new OctokitRepoState(octokit, {
    owner: target.owner,
    repo: target.repo,
  });

  const agents: Partial<Record<AgentName, AgentRunner>> = {
    listener: runListener,
    spec: runSpec,
    architect: runArchitect,
    builder: runBuilder,
    tester: runTester,
    reviewer: runReviewer,
  };

  const deps: OrchestratorDeps = {
    repo,
    config,
    safety,
    agents,
    logger: (event) => console.error(`kanbei:  - ${JSON.stringify(event)}`),
  };

  if (target.issue !== undefined) {
    console.error(`kanbei: running on ${target.owner}/${target.repo}#${target.issue}`);
    const summary = await runIssue(deps, target.issue);
    console.error(
      `kanbei: done — iterations=${summary.iterations} finalPhase=${summary.finalPhase ?? 'none'}`,
    );
    return 0;
  }

  const labelOpts = { prefix: config.labels.prefix, map: config.labels.phases };
  const activeLabels = ACTIVE_PHASES.map((p) => labelForPhase(p, labelOpts));
  console.error(`kanbei: scanning ${target.owner}/${target.repo} for ${activeLabels.join(' | ')}`);
  const issues = await repo.listIssuesWithAnyLabel(activeLabels);
  console.error(`kanbei: found ${issues.length} Kanbei-labeled issue(s)`);

  for (const issue of issues) {
    console.error(`kanbei: → #${issue.number} ${issue.title}`);
    const summary = await runIssue(deps, issue.number);
    console.error(
      `kanbei:   done — iterations=${summary.iterations} finalPhase=${summary.finalPhase ?? 'none'}`,
    );
  }
  return 0;
}

async function initMain(githubUrl: string, options: InitOptions): Promise<number> {
  const target = parseGithubTarget(githubUrl);
  if (!target) {
    console.error(
      `kanbei init: could not parse "${githubUrl}" as a GitHub repository URL.`,
    );
    return 64;
  }
  if (target.issue !== undefined) {
    console.error('kanbei init: expected a repository URL, not an issue URL.');
    return 64;
  }

  loadDotenv();
  const config = loadConfig(options.config);
  const appConfig = loadGithubAppConfig(process.env);
  const octokit = createGithubAppClient(appConfig);

  console.error(`kanbei init: creating labels on ${target.owner}/${target.repo} …`);
  const labelOpts = { prefix: config.labels.prefix, map: config.labels.phases };
  const result = await initLabels(octokit, target.owner, target.repo, labelOpts);

  for (const name of result.created) {
    console.error(`kanbei init:   created  ${name}`);
  }
  for (const name of result.skipped) {
    console.error(`kanbei init:   exists   ${name}`);
  }
  console.error(
    `kanbei init: done — ${result.created.length} created, ${result.skipped.length} already existed.`,
  );
  return 0;
}

const program = new Command();

program
  .name('kanbei')
  .description('Issue-driven multi-agent AI development system')
  .version('0.0.0');

// Default command: run the orchestrator on a repo or issue URL.
program
  .command('run <github-url>', { isDefault: true })
  .description(
    'Drive Kanbei-labeled issues. Pass a repo URL to scan all, or an issue URL to run one cycle.',
  )
  .option('--dry-run', 'Verify configuration without authenticating or writing to GitHub')
  .option('--config <path>', 'Path to kanbei.config.yaml', 'kanbei.config.yaml')
  .action(async (githubUrl: string, options: RunOptions) => {
    const code = await runMain(githubUrl, options);
    process.exit(code);
  });

// Init command: bootstrap kanbei: labels on a repository.
program
  .command('init <github-url>')
  .description('Create kanbei: phase labels on a GitHub repository.')
  .option('--config <path>', 'Path to kanbei.config.yaml', 'kanbei.config.yaml')
  .action(async (githubUrl: string, options: InitOptions) => {
    const code = await initMain(githubUrl, options);
    process.exit(code);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
