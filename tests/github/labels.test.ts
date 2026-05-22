import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PHASE_LABEL_MAP,
  labelForPhase,
  phaseFromLabels,
} from '../../src/github/labels.js';

describe('labelForPhase', () => {
  it('formats a phase with the default prefix and mapping', () => {
    expect(labelForPhase('spec')).toBe('kanbei:spec');
    expect(labelForPhase('awaiting-human')).toBe('kanbei:awaiting-human');
  });

  it('honours a custom prefix', () => {
    expect(labelForPhase('building', { prefix: 'kb/' })).toBe('kb/building');
  });

  it('honours a custom phase-name mapping', () => {
    expect(
      labelForPhase('building', {
        prefix: 'kanbei:',
        map: { ...DEFAULT_PHASE_LABEL_MAP, building: 'in-progress' },
      }),
    ).toBe('kanbei:in-progress');
  });
});

describe('phaseFromLabels', () => {
  it('returns null when no Kanbei label is present', () => {
    expect(phaseFromLabels(['bug', 'enhancement'])).toBeNull();
    expect(phaseFromLabels([])).toBeNull();
  });

  it('identifies the phase from a single matching label', () => {
    expect(phaseFromLabels(['bug', 'kanbei:spec'])).toBe('spec');
    expect(phaseFromLabels(['kanbei:awaiting-human'])).toBe('awaiting-human');
  });

  it('throws when multiple Kanbei labels are present (ambiguous state)', () => {
    expect(() => phaseFromLabels(['kanbei:spec', 'kanbei:arch'])).toThrow(/multiple/i);
  });

  it('ignores unrelated kanbei-prefixed labels that do not map to a phase', () => {
    expect(phaseFromLabels(['kanbei:unknown', 'kanbei:spec'])).toBe('spec');
  });

  it('respects a custom prefix and mapping (round-trip with labelForPhase)', () => {
    const opts = {
      prefix: 'kb/',
      map: { ...DEFAULT_PHASE_LABEL_MAP, building: 'in-progress' as const },
    };
    const label = labelForPhase('building', opts);
    expect(phaseFromLabels([label], opts)).toBe('building');
  });
});
