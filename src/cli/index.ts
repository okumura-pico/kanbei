#!/usr/bin/env node
// Kanbei CLI entry point.
// Implemented in P1. This stub exists so the bin path resolves.

import { Command } from 'commander';

const program = new Command();

program
  .name('kanbei')
  .description('Issue-driven multi-agent AI development system')
  .version('0.0.0');

program
  .command('run')
  .description('Run Kanbei on a specific Issue (not yet implemented)')
  .requiredOption('--issue <number>', 'Issue number to process')
  .option('--repo <owner/repo>', 'Target repository (defaults to $KANBEI_REPO)')
  .action(() => {
    console.error('kanbei run: not yet implemented (see docs/01-architecture.md §9).');
    process.exit(2);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
