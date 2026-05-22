# skillctl

`skillctl` is a local CLI and web dashboard for managing `SKILL.md`-based AI agent skills across multiple tools.

It uses a central skill library and exposes skills to platform-specific roots with symbolic links. It is intentionally conservative: it refuses to overwrite existing skill directories, only disables symlinks, and backs up duplicates before removing them.

## Status

MVP implementation ready for review for the first local filesystem-only milestone.

## Defaults

- Central library: `~/.agents/skills`
- State and backups: `~/.agents/skillctl`
- Config override: `~/.agents/skillctl/config.json`
- Codex root: `~/.codex/skills`
- Claude root: `~/.claude/skills`
- Cursor root: `~/.cursor/skills`

## Commands

```bash
skillctl list
skillctl list --platform codex
skillctl inspect <skill>
skillctl enable <skill> --platform codex
skillctl disable <skill> --platform codex
skillctl duplicates
skillctl rm-duplicate <skill>
skillctl rm-duplicate <skill> --keep <path>
skillctl backups
skillctl restore latest
skillctl restore <backup-id>
skillctl web
```

Write commands support `--dry-run`:

```bash
skillctl enable tdd --platform codex --dry-run
skillctl rm-duplicate tdd --keep ~/.agents/skills/tdd --dry-run
skillctl restore latest --dry-run
```

The web view starts a local management dashboard:

```bash
skillctl web --port 1717
```

The dashboard is designed for desktop browser usage. It provides:

- Sidebar views for `Skills`, `Duplicates`, `Backups`, and `Settings`.
- Search, platform selection, and target-platform `All` / `linked` / `missing` / `duplicate` filters.
- Row-level `Detail`, `Enable`, `Disable`, and `Resolve duplicate` actions.
- Selection checkboxes for batch enable and disable operations.
- A dedicated `Duplicates` view for choosing which path to keep, resolving one duplicate, or resolving all duplicates that have a central library copy.
- A `Backups` view for restoring specific duplicate-removal backups when the filesystem is safe.
- A `Settings` view for inspecting the configured central library and platform roots.
- Confirmation dialogs before file-changing actions run.

Platform status labels in the dashboard:

- `linked`: the platform skill is a symlink to the central library.
- `missing`: the platform does not have that skill.
- `duplicate`: the platform has a same-named real directory instead of a managed symlink.

Linked platform skills are not treated as duplicates. Duplicate detection is for real same-named skill directories that could contain divergent local edits.

The CLI and web dashboard share the same conservative backup model, but their product workflows differ:

- `skillctl rm-duplicate` backs up and removes duplicate entries while keeping the selected path. It is a low-level CLI operation for explicit filesystem cleanup.
- Web `Resolve duplicate` keeps the selected path, backs up removed real directories, and when the kept path is the central library, replaces removed managed platform entries with symlinks. The skill ends in the `linked` state instead of becoming `missing`.
- Web `Resolve all duplicates` uses the central library copy as the canonical source when it exists, leaves existing links untouched, skips duplicate groups without a central library copy, and reports resolved, skipped, and failed items separately.

## Development

```bash
npm install
npm run build
npm test
```

The test suite uses temporary directories and does not read or write the real home directory.

## Out Of Scope For MVP

- GitHub import
- Marketplace browsing
- Skill update checks
- Tauri or packaged desktop GUI
- Mobile-specific layout work
- Copy-based enablement
- JSON output
- Database storage
