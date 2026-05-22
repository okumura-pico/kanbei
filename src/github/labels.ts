// Phase-label read/write helpers.
// See docs/01-architecture.md §2 (state machine) and kanbei.config.yaml
// for the canonical phase→label mapping.

import { KANBEI_PHASES, type KanbeiPhase } from '../types.js';

export const DEFAULT_PHASE_LABEL_MAP: Record<KanbeiPhase, string> = {
  gathering: 'gathering',
  spec: 'spec',
  arch: 'arch',
  building: 'building',
  testing: 'testing',
  review: 'review',
  'awaiting-human': 'awaiting-human',
  done: 'done',
  error: 'error',
};

export const DEFAULT_LABEL_PREFIX = 'kanbei:';

export interface LabelOptions {
  prefix?: string;
  map?: Record<KanbeiPhase, string>;
}

export function labelForPhase(phase: KanbeiPhase, opts: LabelOptions = {}): string {
  const prefix = opts.prefix ?? DEFAULT_LABEL_PREFIX;
  const map = opts.map ?? DEFAULT_PHASE_LABEL_MAP;
  return `${prefix}${map[phase]}`;
}

export function phaseFromLabels(labels: string[], opts: LabelOptions = {}): KanbeiPhase | null {
  const prefix = opts.prefix ?? DEFAULT_LABEL_PREFIX;
  const map = opts.map ?? DEFAULT_PHASE_LABEL_MAP;

  const reverse = new Map<string, KanbeiPhase>();
  for (const phase of KANBEI_PHASES) {
    reverse.set(`${prefix}${map[phase]}`, phase);
  }

  const matched: KanbeiPhase[] = [];
  for (const label of labels) {
    const phase = reverse.get(label);
    if (phase !== undefined) matched.push(phase);
  }
  if (matched.length === 0) return null;
  if (matched.length > 1) {
    throw new Error(
      `Multiple Kanbei phase labels present: ${matched.join(', ')}. ` +
        `An Issue may carry at most one phase label.`,
    );
  }
  return matched[0] ?? null;
}
