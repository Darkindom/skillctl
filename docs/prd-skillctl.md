# skillctl PRD

Status: ready-for-agent

## Problem Statement

AI coding tools increasingly use local "skills" as reusable instructions, workflows, and tool integrations. A single user may have skills installed across Codex, Claude Code, Cursor, and other agent runtimes. Today those skills are spread across multiple hidden directories, with different conventions for user skills, system skills, vendor skills, and platform-specific bundles.

The user needs a simple local CLI that can show what skills exist, identify duplicates, enable a central skill for a target platform, disable a previously enabled skill, remove duplicate copies safely, and restore removed duplicates when needed. The tool must be conservative: it should not overwrite real skill directories, should not silently merge different versions, and should keep enough backup information to put removed duplicates back where they came from.

## Solution

Build `skillctl`, a TypeScript and Node.js CLI for local skill management.

The first version manages local filesystem skills only. It uses `~/.agents/skills` as the central skill library and treats platform-specific skills directories as target roots. Enabling a skill creates a symbolic link from a platform root to the central library. Disabling a skill removes only symbolic links. Duplicate removal is explicit: the user chooses which duplicate skill to keep, and `skillctl` backs up the other entries, records their original paths, then removes them.

The CLI should support:

- Listing central skills and showing platform enablement status.
- Inspecting a skill's metadata and path.
- Enabling a central skill on a platform via symbolic link.
- Disabling a skill on a platform by removing only symbolic links.
- Detecting duplicate skills by directory name.
- Removing duplicate skills with backup and explicit keep selection.
- Listing available backups.
- Restoring a backup when doing so is safe.
- Previewing write operations with dry-run mode.

The first version intentionally avoids GitHub import, update management, GUI, database storage, and automatic merge behavior.

## User Stories

1. As a developer using multiple AI coding tools, I want to see all central skills in one command, so that I can understand what reusable workflows I already have.
2. As a developer using Codex, I want to see whether each central skill is enabled for Codex, so that I can quickly find missing platform links.
3. As a developer using Claude Code, I want to see whether each central skill is enabled for Claude, so that I can keep Claude aligned with my central library.
4. As a developer using Cursor, I want to see whether each central skill is enabled for Cursor, so that Cursor can use the same skill library where appropriate.
5. As a developer maintaining skills manually, I want to inspect a skill's name, description, source path, and platform locations, so that I can verify the skill before enabling or removing anything.
6. As a developer, I want the central library to live under my agents directory, so that skills shared across tools have one canonical home.
7. As a developer, I want platform-specific enablement to use symbolic links, so that a skill can be maintained once and exposed to multiple tools.
8. As a developer, I want `skillctl` to refuse to overwrite an existing real skill directory when enabling a skill, so that I do not accidentally lose local edits.
9. As a developer, I want `skillctl` to tell me when a target already has a same-named skill, so that I can resolve the duplicate deliberately.
10. As a developer, I want disabling a skill to remove only a symbolic link, so that disabling never deletes real skill content.
11. As a developer, I want `skillctl` to detect same-named skills across roots, so that I can find duplicate copies created by manual installs or platform-specific installers.
12. As a developer, I want duplicates to be identified by directory name, so that detection matches how local skill directories are actually addressed.
13. As a developer, I want frontmatter `name` and `description` to be displayed but not used as the primary duplicate identity, so that missing or inconsistent metadata does not cause unsafe deletion.
14. As a developer, I want to choose which duplicate skill to keep, so that `skillctl` never decides the canonical version for me.
15. As a developer, I want duplicate removal to back up removed entries before deletion, so that I can recover if I chose the wrong one.
16. As a developer, I want backup records to include the original path of each removed duplicate, so that restore can put it back in the right place.
17. As a developer, I want symbolic links to be backed up as links rather than copied target content, so that restore preserves the original relationship.
18. As a developer, I want real directories to be backed up as their contents, so that restore can recreate the original skill directory.
19. As a developer, I want restore to put backed-up skills back at their original paths, so that recovery is simple and predictable.
20. As a developer, I want restore to abort if an original path's parent root no longer exists, so that the tool does not recreate unexpected platform directories.
21. As a developer, I want restore to abort if restoring would recreate an unresolved duplicate conflict, so that I must choose one skill before changing the filesystem.
22. As a developer, I want restore to abort if a destination path is already occupied, so that `skillctl` does not overwrite newer manual changes.
23. As a developer, I want restore failures to print clear paths and reasons, so that I can fix the filesystem state manually and retry.
24. As a developer, I want to preview enable, disable, duplicate removal, and restore operations, so that I can see exactly what would change before writing to disk.
25. As a developer, I want the default platform root to be `~/.<platform>/skills`, so that default behavior matches the common local convention.
26. As a developer, I want platforms to support multiple skill roots, so that platform-specific vendor, team, user, or system roots can be represented explicitly.
27. As a developer, I want roots to be marked as managed or read-only, so that `skillctl` can scan everything but only write to safe locations.
28. As a developer, I want platform system skills to be read-only, so that the tool does not alter bundled or platform-owned skill packages.
29. As a developer, I want Cursor's nested skill conventions to be represented as multiple roots, so that nested layouts do not become hard-coded special cases.
30. As a developer, I want the first version to avoid GitHub import, so that local filesystem behavior can be made reliable before adding network and source metadata.
31. As a developer, I want the first version to be a CLI rather than a GUI, so that the core skill management model can be built and tested quickly.
32. As a future GUI implementer, I want the core behavior to live behind testable modules, so that a desktop interface can reuse the same logic later.
33. As a script author, I want stable human-readable command output, so that daily usage is clear without needing JSON output in the first version.
34. As a user who prefers conservative tools, I want `skillctl` to reject ambiguous operations, so that I am forced to resolve duplicates or conflicts explicitly.
35. As a maintainer, I want filesystem behavior to be covered by integration tests, so that path handling, symbolic links, backup, and restore behavior do not regress.

## Implementation Decisions

- The product name and CLI command are both `skillctl`.
- The first version is a local CLI, not a Tauri desktop app.
- The implementation will use TypeScript and Node.js with ECMAScript modules.
- Dependencies should be minimal. Command parsing may use a small CLI library; the rest should rely on Node standard library capabilities.
- The tool will use `~/.agents/skills` as the central skill library.
- The tool's own configuration and backup state will live under `~/.agents/skillctl`.
- The first version will not use a database.
- Platform roots are represented as configuration, not hard-coded path exceptions.
- A platform may have multiple roots.
- Each root has an identifier, filesystem path, role, and layout.
- Root roles are `library`, `managed`, and `readonly`.
- `library` roots are canonical sources for skills.
- `managed` roots may be written by `skillctl`.
- `readonly` roots may be scanned but never modified.
- Root layout in the first version is flat: a root contains one directory per skill, and each skill directory contains `SKILL.md`.
- Nested platform conventions should be modeled by configuring deeper roots rather than by recursive write behavior.
- The default platform root convention is `~/.<platform>/skills`.
- The default central library root is not platform-specific; it remains `~/.agents/skills`.
- Initial platform coverage includes agents, Codex, Claude, and Cursor.
- Codex should scan `~/.codex/skills` as a managed root and `~/.codex/skills/.system` as read-only.
- Claude should scan `~/.claude/skills` as a managed root.
- Cursor should scan `~/.cursor/skills` as a managed root and known platform-specific roots as read-only when configured.
- The `list` command defaults to central library skills and displays platform enablement state.
- The `list` command may support platform-scoped output for inspecting one platform root set.
- The `inspect` command displays skill metadata and filesystem locations.
- Skill metadata is parsed from `SKILL.md` frontmatter when present.
- Skill identity for duplicate detection is the skill directory name.
- Frontmatter `name` is display metadata, not the primary identity.
- Enabling a skill creates a symbolic link from a managed platform root to the central library skill directory.
- Enabling does not support copying skill contents.
- Enabling fails if the target path already exists.
- Enabling does not resolve duplicates automatically.
- Disabling removes only symbolic links.
- Disabling fails if the target path is a real directory.
- Duplicate detection scans configured roots and groups same-named skill directories.
- Duplicate removal is exposed as `rm-duplicate`.
- `rm-duplicate` requires the user to choose which duplicate entry to keep when multiple entries exist.
- `rm-duplicate` may support a non-interactive keep option for scripts, but interactive selection is part of the first version.
- `rm-duplicate` backs up all removed entries before deleting them.
- Real directories are backed up as directory contents.
- Symbolic links are backed up as link metadata: original path and original target.
- Backup manifests record enough information to restore removed entries to their original paths.
- Restore puts backed-up entries back at their recorded original paths.
- Restore is intentionally conservative.
- Restore aborts the entire requested restore if any original parent root no longer exists.
- Restore aborts if any target path already exists.
- Restore aborts if restoring would create an unresolved duplicate skill.
- Restore prints blocked paths and reasons when it cannot proceed.
- Write commands support dry-run mode.
- Dry-run mode reports planned filesystem changes without creating, deleting, or restoring anything.
- Query commands do not need JSON output in the first version.
- GitHub import, source tracking, update checks, and marketplace browsing are out of scope for the first version.
- The code should be organized around deep modules for root configuration, skill discovery, filesystem operations, duplicate resolution, backup/restore, and CLI command orchestration.
- Filesystem mutation should be isolated behind a small interface so tests can exercise real temporary directories without depending on the user's home directory.

## Testing Decisions

- Tests should focus on external behavior rather than implementation details.
- The first version should include filesystem-level integration tests using temporary directories.
- Tests should not read or write the user's real home directory.
- Tests should simulate central library roots and platform roots under a temporary home.
- Skill discovery tests should verify that valid `SKILL.md` directories are listed and metadata is parsed when available.
- Root configuration tests should verify expansion of home-relative paths and role-based write behavior.
- Enable tests should verify that enabling creates a symbolic link to the central library skill.
- Enable tests should verify that enabling fails when the target path already exists.
- Disable tests should verify that disabling removes symbolic links.
- Disable tests should verify that disabling refuses to delete real directories.
- Duplicate detection tests should verify grouping by directory name across multiple roots.
- Duplicate detection tests should verify that frontmatter `name` differences do not override directory-name identity.
- Duplicate removal tests should verify that the selected keep entry remains.
- Duplicate removal tests should verify that removed real directories are backed up and deleted.
- Duplicate removal tests should verify that removed symbolic links are recorded as links and deleted.
- Backup listing tests should verify that created backup manifests are discoverable.
- Restore tests should verify that real directories are restored to their original paths.
- Restore tests should verify that symbolic links are recreated with their original targets.
- Restore tests should verify that restore aborts when a destination already exists.
- Restore tests should verify that restore aborts when an original parent root no longer exists.
- Restore tests should verify that restore aborts when restoring would recreate unresolved duplicates.
- Dry-run tests should verify that write commands report intended actions without changing the filesystem.
- CLI smoke tests should verify the main commands parse expected flags and delegate to the correct behavior.
- Node's built-in test runner is sufficient for the first version.
- No browser or GUI tests are needed for the first version.

## Out of Scope

- Tauri or any other desktop GUI.
- GitHub import.
- GitHub authentication.
- Marketplace browsing.
- Skill update checks.
- Remote source metadata.
- Automatic merge of duplicate skill contents.
- Automatic overwrite of existing skill directories.
- Copy-based enablement.
- JSON output.
- Database storage.
- Project-local skill roots unless explicitly configured in a later version.
- Publishing to npm.
- Installer packaging.
- Support for non-`SKILL.md` skill formats.
- Editing skill contents.
- Creating new skills.
- Validating skill quality beyond basic metadata parsing.

## Further Notes

- The CLI should be conservative by default. If an operation is ambiguous, it should print the reason and stop.
- The tool should avoid treating any platform as a one-off special case. Differences between Codex, Claude, Cursor, and future tools should be expressed through root configuration.
- Cursor-style nested roots are a representative case for the root-based model: the configured root may itself be nested, while skill discovery inside that root remains flat.
- The first version should keep user-facing terminology simple. Use "duplicate" and "restore" rather than implementation terms like "dedupe" or "transaction".
- The PRD intentionally captures the first local CLI milestone. Later milestones can add GitHub import and a GUI once the filesystem model is stable.
