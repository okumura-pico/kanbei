# Kanbei — Project Instructions

Operational rules for Claude (and any AI collaborator) working in this repository.
For project concept and roadmap, see `README.md` and `docs/00-overview.md`.

## Tech stack (decided 2026-05-22)

- **Language**: TypeScript (Node.js)
- **AI runtime**: `@anthropic-ai/claude-agent-sdk` — one session per agent role with a role-specific system prompt and a restricted tool set
- **Execution model**: local CLI first, then GitHub Actions for autonomous mode
- **Target repository**: Kanbei itself (self-hosting / dogfooding)
- **Bot identity**: GitHub App (JWT → installation token via `@octokit/auth-app`). Private key lives in `.env` locally (gitignored) and in a secret manager in production.

## CLI shape (decided 2026-05-22)

- Binary name: `kanbei`
- Primary usage: `kanbei <github-url>` where `<github-url>` is either a repo URL (`https://github.com/owner/repo`) or an Issue URL (`https://github.com/owner/repo/issues/N`).
- A repo URL means "scan the repo's Kanbei-labeled Issues"; an Issue URL means "drive this specific Issue one cycle".
- Do not invent subcommands without need — the URL is the noun; flags layer on top only when truly necessary.

## Language policy (hybrid)

- **English**: `README.md`, `CLAUDE.md`, source code (identifiers, comments, docstrings), commit messages, PR titles/descriptions, GitHub Issue/PR comments authored by Kanbei.
- **Japanese**: `docs/` design and planning memos (`docs/NN-topic.md`).

If you are unsure which bucket a file falls into, default to English.

## Documentation layout

- Design and planning memos live in `docs/NN-topic.md` (numbered, Japanese).
- Each memo starts with a `最終更新: YYYY-MM-DD` line; update it whenever the file is meaningfully edited.
- Do not duplicate decisions across memos — link instead.

## Commit conventions

- **One context per commit.** Do not bundle unrelated changes (docs + deps + impl) into one commit.
- Subject line in English, Conventional-Commits-ish prefix (`docs:`, `feat:`, `chore:`, `refactor:`, `test:`, `fix:`).
- Body explains the *why* when non-obvious. Keep it short.
- Never `--amend` a published commit; create a new one.

## Memory discipline (for Claude)

- Per-session memory files under `~/.claude/projects/.../memory/` must stay terse: 1–3 lines plus a pointer to the authoritative `docs/NN-*.md`.
- `MEMORY.md` is an index, never content.
- If a fact needs more than a few lines, put it in `docs/`, not in memory.

## Safety rails (planned, enforce as soon as code lands)

- Kanbei must ignore comments authored by itself to avoid self-triggered loops. Detect via the GitHub App's bot user id, and additionally embed an HTML marker (e.g. `<!-- kanbei:<agent> -->`) in every comment it writes.
- Per-Issue iteration cap and per-run token budget must be enforced at the orchestrator level.
- All write operations (comment, label, push, PR) must be idempotent — re-running on the same Issue state must not produce duplicates.

## Open work

See the task list and `docs/00-overview.md` for the current roadmap (P0 → P6).
