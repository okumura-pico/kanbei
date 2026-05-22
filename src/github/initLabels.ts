// Label bootstrap: creates kanbei: phase labels on a target repository.
// Idempotent — existing labels with the same name are left unchanged.
// See docs/01-architecture.md §2 for the full phase list.

import type { Octokit } from '@octokit/rest';
import { KANBEI_PHASES, type KanbeiPhase } from '../types.js';
import type { LabelOptions } from './labels.js';
import { labelForPhase, DEFAULT_LABEL_PREFIX, DEFAULT_PHASE_LABEL_MAP } from './labels.js';

/** Hex color (without #) assigned to each phase label. */
const PHASE_COLORS: Record<KanbeiPhase, string> = {
  gathering:        '0075ca', // blue — requirements in progress
  spec:             '5319e7', // violet — specification
  arch:             'e4e669', // yellow — architecture
  building:         'f9d0c4', // light orange — implementation
  testing:          'fbca04', // yellow — testing
  review:           '0e8a16', // green — under review
  'awaiting-human': 'e11d48', // red — blocked on human
  done:             '2ea44f', // dark green — complete
  error:            'b60205', // dark red — error
};

const PHASE_DESCRIPTIONS: Record<KanbeiPhase, string> = {
  gathering:        'Kanbei: gathering requirements',
  spec:             'Kanbei: writing specification',
  arch:             'Kanbei: designing architecture',
  building:         'Kanbei: implementing',
  testing:          'Kanbei: running tests',
  review:           'Kanbei: ready for human review',
  'awaiting-human': 'Kanbei: waiting for human input',
  done:             'Kanbei: complete',
  error:            'Kanbei: encountered an error',
};

export interface InitLabelsResult {
  created: string[];
  skipped: string[];
}

export async function initLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  opts: LabelOptions = {},
): Promise<InitLabelsResult> {
  const prefix = opts.prefix ?? DEFAULT_LABEL_PREFIX;
  const map = opts.map ?? DEFAULT_PHASE_LABEL_MAP;

  // Fetch all existing labels (paginated).
  const existing = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  const existingNames = new Set(existing.map((l) => l.name));

  const created: string[] = [];
  const skipped: string[] = [];

  for (const phase of KANBEI_PHASES) {
    const labelOpts: LabelOptions = { prefix, map };
    const name = labelForPhase(phase, labelOpts);

    if (existingNames.has(name)) {
      skipped.push(name);
      continue;
    }

    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name,
      color: PHASE_COLORS[phase],
      description: PHASE_DESCRIPTIONS[phase],
    });
    created.push(name);
  }

  return { created, skipped };
}
