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

- Search, platform selection, and `All` / `Enabled` / `Missing` / `Duplicates` filters.
- Row-level `Detail`, `Enable`, and `Disable` actions.
- Selection checkboxes for batch enable and disable operations.
- Maintenance actions for finding duplicates, listing backups, and restoring the latest backup.
- Confirmation dialogs before file-changing actions run.

Platform status labels in the dashboard:

- `linked`: the platform skill is a symlink to the central library.
- `missing`: the platform does not have that skill.
- `duplicate`: the platform has a same-named real directory instead of a managed symlink.

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
