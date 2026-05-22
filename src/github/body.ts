// Issue-body section editor.
// Sections are delimited by `<!-- KANBEI_<NAME>_START -->` /
// `<!-- KANBEI_<NAME>_END -->` markers; everything outside the
// markers (including the human-authored body) is preserved verbatim.
// See docs/01-architecture.md §3 and §6 (idempotency).

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function startMarker(name: string): string {
  return `<!-- KANBEI_${name}_START -->`;
}

function endMarker(name: string): string {
  return `<!-- KANBEI_${name}_END -->`;
}

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid section name "${name}": must match /^[A-Z][A-Z0-9_]*$/ (e.g. SPEC, ARCH, PLAN).`,
    );
  }
}

function findSection(body: string, name: string): { startIdx: number; endIdx: number } | null {
  const start = startMarker(name);
  const end = endMarker(name);
  const startIdx = body.indexOf(start);
  if (startIdx === -1) return null;
  const endIdx = body.indexOf(end, startIdx + start.length);
  if (endIdx === -1) return null;
  return { startIdx, endIdx };
}

export function upsertSection(body: string, name: string, content: string): string {
  assertValidName(name);
  const start = startMarker(name);
  const end = endMarker(name);

  const found = findSection(body, name);
  if (found) {
    const before = body.slice(0, found.startIdx + start.length);
    const after = body.slice(found.endIdx);
    return `${before}\n${content}\n${after}`;
  }

  if (body.length === 0) {
    return `${start}\n${content}\n${end}\n`;
  }
  const separator = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
  return `${body}${separator}${start}\n${content}\n${end}\n`;
}

export function readSection(body: string, name: string): string | null {
  assertValidName(name);
  const found = findSection(body, name);
  if (!found) return null;
  const start = startMarker(name);
  return body.slice(found.startIdx + start.length, found.endIdx).replace(/^\n|\n$/g, '');
}

export function removeSection(body: string, name: string): string {
  assertValidName(name);
  const found = findSection(body, name);
  if (!found) return body;
  const end = endMarker(name);
  const before = body.slice(0, found.startIdx);
  const after = body.slice(found.endIdx + end.length);
  // Collapse the blank-line padding we inserted around the section so that
  // remove-then-upsert round-trips remain tidy.
  return (before.replace(/\n+$/, '') + (before && after ? '\n' : '') + after.replace(/^\n+/, ''));
}
