import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';
import { KANBEI_PHASES } from '../../src/types.js';
import { initLabels } from '../../src/github/initLabels.js';
import { labelForPhase } from '../../src/github/labels.js';

function makeFakeOctokit(existingLabels: string[] = []) {
  const createLabel = vi.fn().mockResolvedValue({});
  const paginate = vi.fn().mockResolvedValue(
    existingLabels.map((name) => ({ name })),
  );
  const listLabelsForRepo = vi.fn();
  const fake = {
    rest: { issues: { listLabelsForRepo, createLabel } },
    paginate,
  };
  return { octokit: fake as unknown as Octokit, createLabel, paginate };
}

describe('initLabels', () => {
  it('creates all 9 phase labels when the repo has none', async () => {
    const { octokit, createLabel } = makeFakeOctokit();
    const result = await initLabels(octokit, 'owner', 'repo');
    expect(result.created).toHaveLength(KANBEI_PHASES.length);
    expect(result.skipped).toHaveLength(0);
    expect(createLabel).toHaveBeenCalledTimes(KANBEI_PHASES.length);
  });

  it('skips labels that already exist and creates the rest', async () => {
    const existing = [labelForPhase('gathering'), labelForPhase('spec')];
    const { octokit, createLabel } = makeFakeOctokit(existing);
    const result = await initLabels(octokit, 'owner', 'repo');
    expect(result.skipped).toEqual(expect.arrayContaining(existing));
    expect(result.created).toHaveLength(KANBEI_PHASES.length - existing.length);
    expect(createLabel).toHaveBeenCalledTimes(KANBEI_PHASES.length - existing.length);
  });

  it('skips everything when all labels already exist', async () => {
    const all = KANBEI_PHASES.map((p) => labelForPhase(p));
    const { octokit, createLabel } = makeFakeOctokit(all);
    const result = await initLabels(octokit, 'owner', 'repo');
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(KANBEI_PHASES.length);
    expect(createLabel).not.toHaveBeenCalled();
  });

  it('passes the correct owner, repo, name, color, and description to createLabel', async () => {
    const { octokit, createLabel } = makeFakeOctokit();
    await initLabels(octokit, 'acme', 'widget');
    const call = createLabel.mock.calls.find(([args]) => args.name === 'kanbei:gathering');
    expect(call).toBeDefined();
    const [args] = call!;
    expect(args.owner).toBe('acme');
    expect(args.repo).toBe('widget');
    expect(args.color).toMatch(/^[0-9a-f]{6}$/);
    expect(args.description).toBeTruthy();
  });

  it('respects a custom label prefix from opts', async () => {
    const { octokit, createLabel } = makeFakeOctokit();
    await initLabels(octokit, 'owner', 'repo', { prefix: 'ai:' });
    const names = createLabel.mock.calls.map(([a]) => a.name as string);
    expect(names.every((n) => n.startsWith('ai:'))).toBe(true);
  });

  it('paginates existing labels', async () => {
    const { octokit, paginate } = makeFakeOctokit();
    await initLabels(octokit, 'owner', 'repo');
    expect(paginate).toHaveBeenCalledOnce();
  });
});
