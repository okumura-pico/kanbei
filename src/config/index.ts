// kanbei.config.yaml loader with Zod validation.
// Schema mirrors the shipped kanbei.config.yaml shape; see also
// docs/01-architecture.md §2, §5, §6.

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { KanbeiPhase } from '../types.js';

const SafetySchema = z.object({
  maxIterationsPerIssue: z.number().int().positive().default(50),
  maxIterationsPerPhase: z.number().int().positive().default(5),
  maxTokensPerIssue: z.number().int().positive().default(500_000),
});

// YAML can't easily express the `awaiting-human` key because of the dash,
// so we let the file use `awaitingHuman` and translate at load time.
const PhasesYamlSchema = z
  .object({
    gathering: z.string().min(1).default('gathering'),
    spec: z.string().min(1).default('spec'),
    arch: z.string().min(1).default('arch'),
    building: z.string().min(1).default('building'),
    testing: z.string().min(1).default('testing'),
    review: z.string().min(1).default('review'),
    awaitingHuman: z.string().min(1).default('awaiting-human'),
    done: z.string().min(1).default('done'),
    error: z.string().min(1).default('error'),
  })
  .default({});

const LabelsSchema = z
  .object({
    prefix: z.string().min(1).default('kanbei:'),
    phases: PhasesYamlSchema,
  })
  .default({});

const AgentEntrySchema = z.object({ model: z.string().default('') }).default({});

const AgentsSchema = z
  .object({
    listener: AgentEntrySchema,
    spec: AgentEntrySchema,
    architect: AgentEntrySchema,
    builder: AgentEntrySchema,
    tester: AgentEntrySchema,
    reviewer: AgentEntrySchema,
  })
  .default({});

const KanbeiConfigSchema = z
  .object({
    safety: SafetySchema.default({}),
    labels: LabelsSchema,
    agents: AgentsSchema,
    branchPattern: z.string().min(1).default('kanbei/issue-<n>-<slug>'),
  })
  .default({});

export type KanbeiConfigInput = z.input<typeof KanbeiConfigSchema>;
type KanbeiConfigParsed = z.output<typeof KanbeiConfigSchema>;

export interface KanbeiConfig {
  safety: KanbeiConfigParsed['safety'];
  labels: {
    prefix: string;
    /** Keyed by canonical KanbeiPhase strings (incl. 'awaiting-human'). */
    phases: Record<KanbeiPhase, string>;
  };
  agents: KanbeiConfigParsed['agents'];
  branchPattern: string;
}

function toCanonical(parsed: KanbeiConfigParsed): KanbeiConfig {
  const p = parsed.labels.phases;
  return {
    safety: parsed.safety,
    labels: {
      prefix: parsed.labels.prefix,
      phases: {
        gathering: p.gathering,
        spec: p.spec,
        arch: p.arch,
        building: p.building,
        testing: p.testing,
        review: p.review,
        'awaiting-human': p.awaitingHuman,
        done: p.done,
        error: p.error,
      },
    },
    agents: parsed.agents,
    branchPattern: parsed.branchPattern,
  };
}

export function loadKanbeiConfig(yamlText: string): KanbeiConfig {
  const raw: unknown = yamlText.trim() === '' ? {} : parseYaml(yamlText);
  const parsed = KanbeiConfigSchema.parse(raw ?? {});
  return toCanonical(parsed);
}

export const DEFAULT_KANBEI_CONFIG: KanbeiConfig = loadKanbeiConfig('');
