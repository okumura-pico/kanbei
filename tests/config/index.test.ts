import { describe, expect, it } from 'vitest';
import { loadKanbeiConfig, DEFAULT_KANBEI_CONFIG } from '../../src/config/index.js';

describe('loadKanbeiConfig', () => {
  it('returns the defaults for an empty input', () => {
    expect(loadKanbeiConfig('')).toEqual(DEFAULT_KANBEI_CONFIG);
  });

  it('parses the shipped kanbei.config.yaml shape', () => {
    const yaml = `
safety:
  maxIterationsPerIssue: 50
  maxIterationsPerPhase: 5
  maxTokensPerIssue: 500000

labels:
  prefix: "kanbei:"
  phases:
    gathering: gathering
    spec: spec
    arch: arch
    building: building
    testing: testing
    review: review
    awaitingHuman: awaiting-human
    done: done
    error: error

agents:
  listener: { model: "" }
  spec: { model: "" }
  architect: { model: "" }
  builder: { model: "" }
  tester: { model: "" }

branchPattern: "kanbei/issue-<n>-<slug>"
`;
    const config = loadKanbeiConfig(yaml);
    expect(config.safety.maxIterationsPerIssue).toBe(50);
    expect(config.labels.prefix).toBe('kanbei:');
    expect(config.labels.phases['awaiting-human']).toBe('awaiting-human');
    expect(config.agents.listener.model).toBe('');
    expect(config.branchPattern).toBe('kanbei/issue-<n>-<slug>');
  });

  it('fills in defaults for partial input', () => {
    const config = loadKanbeiConfig(`safety:\n  maxIterationsPerIssue: 7\n`);
    expect(config.safety.maxIterationsPerIssue).toBe(7);
    expect(config.safety.maxIterationsPerPhase).toBe(DEFAULT_KANBEI_CONFIG.safety.maxIterationsPerPhase);
    expect(config.labels.prefix).toBe(DEFAULT_KANBEI_CONFIG.labels.prefix);
  });

  it('rejects non-positive iteration limits', () => {
    expect(() => loadKanbeiConfig(`safety:\n  maxIterationsPerIssue: 0\n`)).toThrow();
    expect(() => loadKanbeiConfig(`safety:\n  maxIterationsPerIssue: -1\n`)).toThrow();
  });

  it('rejects an empty label prefix', () => {
    expect(() => loadKanbeiConfig(`labels:\n  prefix: ""\n`)).toThrow();
  });

  it('rejects malformed YAML', () => {
    expect(() => loadKanbeiConfig(': :')).toThrow();
  });

  it('exposes phases via the canonical KanbeiPhase keys (incl. awaiting-human)', () => {
    const yaml = `labels:\n  phases:\n    awaitingHuman: human-input-needed\n`;
    const config = loadKanbeiConfig(yaml);
    expect(config.labels.phases['awaiting-human']).toBe('human-input-needed');
  });
});
