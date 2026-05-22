// Comment authoring + self-filtering for Kanbei.
// See docs/01-architecture.md §4 (comment marker) and §5 L1
// (self-comment ignore as the primary anti-loop layer).

import type { AgentName } from '../types.js';

const AGENT_NAMES = new Set<AgentName>([
  'listener',
  'spec',
  'architect',
  'builder',
  'tester',
]);

// Marker must appear at the very start of the comment body so that a
// quoted marker inside someone else's comment cannot impersonate Kanbei.
const MARKER_RE = /^<!--\s*kanbei:([a-z]+)(?:\s+v(\d+))?\s*-->/;

export interface KanbeiCommentMarker {
  agent: AgentName;
  /** Defaults to 1 when the marker omits the version. */
  version: number;
}

export function wrapComment(agent: AgentName, body: string, version = 1): string {
  if (!AGENT_NAMES.has(agent)) {
    throw new Error(`Unknown agent name "${String(agent)}"`);
  }
  return `<!-- kanbei:${agent} v${version} -->\n\n${body}`;
}

export function parseKanbeiCommentMarker(body: string): KanbeiCommentMarker | null {
  const match = MARKER_RE.exec(body);
  if (!match) return null;
  const agent = match[1];
  if (!agent || !AGENT_NAMES.has(agent as AgentName)) return null;
  const versionStr = match[2];
  const version = versionStr ? Number(versionStr) : 1;
  return { agent: agent as AgentName, version };
}

export function isKanbeiComment(body: string): boolean {
  return parseKanbeiCommentMarker(body) !== null;
}

export function filterKanbeiComments<T extends { body?: string | null }>(comments: T[]): T[] {
  return comments.filter((c) => {
    if (!c.body) return true;
    return !isKanbeiComment(c.body);
  });
}
