import { cp, lstat, mkdir, readFile, readdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { loadConfig, SkillctlConfig } from "./config.js";
import { findDuplicates } from "./skills.js";

export type OperationOptions = {
  home: string;
  dryRun?: boolean;
};

export type OperationResult = {
  message: string;
};

export type BackupEntry = {
  originalPath: string;
  kind: "directory" | "symlink";
  backupPath?: string;
  linkTarget?: string;
};

export type BackupManifest = {
  id: string;
  type: string;
  skill: string;
  keepPath?: string;
  entries: BackupEntry[];
};

export type ListedBackup = {
  id: string;
  type: string;
  skill: string;
  entryCount: number;
};

export async function enableSkill(
  options: OperationOptions,
  skill: string,
  platform: string,
): Promise<OperationResult> {
  const config = await loadConfig(options.home);
  const root = getManagedRoot(config, platform);
  const source = join(config.libraryRoot, skill);
  const target = join(root.path, skill);

  await assertExists(source, `Skill not found in library: ${skill}`);
  await assertMissing(target, `Target already exists: ${target}`);

  if (!options.dryRun) {
    await symlink(source, target, "dir");
  }

  return {
    message: `${options.dryRun ? "Would create symlink" : "Created symlink"}: ${target} -> ${source}`,
  };
}

export async function disableSkill(
  options: OperationOptions,
  skill: string,
  platform: string,
): Promise<OperationResult> {
  const config = await loadConfig(options.home);
  const root = getManagedRoot(config, platform);
  const target = join(root.path, skill);
  const targetStat = await lstat(target);

  if (!targetStat.isSymbolicLink()) {
    throw new Error(`Target is not a symlink: ${target}`);
  }

  if (!options.dryRun) {
    await unlink(target);
  }

  return {
    message: `${options.dryRun ? "Would remove symlink" : "Removed symlink"}: ${target}`,
  };
}

export async function removeDuplicateSkill(
  options: OperationOptions,
  skill: string,
  keepPath: string,
): Promise<OperationResult> {
  const config = await loadConfig(options.home);
  const duplicate = (await findDuplicates({ home: options.home })).find((candidate) => candidate.name === skill);
  if (!duplicate) {
    throw new Error(`No duplicate skill found: ${skill}`);
  }

  if (!duplicate.locations.some((location) => location.path === keepPath)) {
    throw new Error(`Keep path is not one of the duplicates: ${keepPath}`);
  }

  const backupId = createBackupId(`rm-duplicate-${skill}`);
  const backupRoot = join(config.stateRoot, "backups", backupId);
  const entries: BackupEntry[] = [];

  for (const location of duplicate.locations) {
    if (location.path === keepPath) {
      continue;
    }

    const entryStat = await lstat(location.path);
    if (entryStat.isSymbolicLink()) {
      entries.push({
        originalPath: location.path,
        kind: "symlink",
        linkTarget: await readlink(location.path),
      });
      continue;
    }

    const backupPath = join("files", `${location.platform}__${location.rootId}__${skill}`);
    entries.push({
      originalPath: location.path,
      kind: "directory",
      backupPath,
    });
  }

  if (!options.dryRun) {
    await mkdir(join(backupRoot, "files"), { recursive: true });
    for (const entry of entries) {
      if (entry.kind === "directory" && entry.backupPath) {
        await cp(entry.originalPath, join(backupRoot, entry.backupPath), { recursive: true, verbatimSymlinks: true });
        await rm(entry.originalPath, { recursive: true });
      } else if (entry.kind === "symlink") {
        await unlink(entry.originalPath);
      }
    }

    await writeFile(
      join(backupRoot, "manifest.json"),
      JSON.stringify(
        {
          id: backupId,
          type: "rm-duplicate",
          skill,
          keepPath,
          entries,
        },
        null,
        2,
      ),
    );
  }

  return {
    message: `${options.dryRun ? "Would remove duplicates" : "Removed duplicates"} for ${skill}\nBackup: ${backupId}`,
  };
}

export async function listBackups(options: OperationOptions): Promise<ListedBackup[]> {
  const config = await loadConfig(options.home);
  const backupsRoot = join(config.stateRoot, "backups");
  let backupIds: string[];
  try {
    backupIds = await readdir(backupsRoot);
  } catch {
    return [];
  }

  const backups: ListedBackup[] = [];
  for (const id of backupIds.sort()) {
    try {
      const manifest = await readManifest(join(backupsRoot, id));
      backups.push({
        id: manifest.id,
        type: manifest.type,
        skill: manifest.skill,
        entryCount: manifest.entries.length,
      });
    } catch {
      // Ignore incomplete backup directories.
    }
  }

  return backups;
}

export async function restoreBackup(options: OperationOptions, backupId: string): Promise<OperationResult> {
  const config = await loadConfig(options.home);
  const backups = await listBackups(options);
  const resolvedBackupId = backupId === "latest" ? backups.at(-1)?.id : backupId;
  if (!resolvedBackupId) {
    throw new Error("No backup found.");
  }

  const backupRoot = join(config.stateRoot, "backups", resolvedBackupId);
  const manifest = await readManifest(backupRoot);
  const problems = await validateRestore(options, manifest);
  if (problems.length > 0) {
    throw new Error(`Restore blocked.\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }

  if (!options.dryRun) {
    for (const entry of manifest.entries) {
      if (entry.kind === "directory") {
        if (!entry.backupPath) {
          throw new Error(`Backup entry is missing backupPath: ${entry.originalPath}`);
        }
        await cp(join(backupRoot, entry.backupPath), entry.originalPath, {
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        if (!entry.linkTarget) {
          throw new Error(`Backup entry is missing linkTarget: ${entry.originalPath}`);
        }
        await symlink(entry.linkTarget, entry.originalPath, "dir");
      }
    }
  }

  return {
    message: `${options.dryRun ? "Would restore backup" : "Restored backup"}: ${resolvedBackupId}`,
  };
}

function getManagedRoot(config: SkillctlConfig, platform: string) {
  const platformConfig = config.platforms[platform];
  if (!platformConfig) {
    throw new Error(`Unknown platform: ${platform}`);
  }

  const root = platformConfig.roots.find((candidate) => candidate.role === "managed");
  if (!root) {
    throw new Error(`Platform has no managed root: ${platform}`);
  }

  return root;
}

async function assertExists(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch {
    throw new Error(message);
  }
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(message);
  } catch (error) {
    if (error instanceof Error && error.message === message) {
      throw error;
    }
  }
}

function createBackupId(label: string): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`;
}

async function readManifest(backupRoot: string): Promise<BackupManifest> {
  return JSON.parse(await readFile(join(backupRoot, "manifest.json"), "utf8")) as BackupManifest;
}

async function validateRestore(options: OperationOptions, manifest: BackupManifest): Promise<string[]> {
  const problems: string[] = [];
  const entryNames = new Set(manifest.entries.map((entry) => basename(entry.originalPath)));

  for (const entry of manifest.entries) {
    try {
      const parent = await stat(dirname(entry.originalPath));
      if (!parent.isDirectory()) {
        problems.push(`Original parent is not a directory: ${dirname(entry.originalPath)}`);
      }
    } catch {
      problems.push(`Original parent path does not exist: ${dirname(entry.originalPath)}`);
    }

    try {
      await lstat(entry.originalPath);
      problems.push(`Restore target already exists: ${entry.originalPath}`);
    } catch {
      // Missing target is expected.
    }
  }

  const duplicates = await findDuplicates({ home: options.home });
  for (const duplicate of duplicates) {
    if (entryNames.has(duplicate.name)) {
      problems.push(`Restoring would recreate duplicate skill "${duplicate.name}". Choose one skill first.`);
    }
  }

  for (const name of entryNames) {
    const existingLocations = (await findExistingSkillPaths(options.home, name)).filter(
      (path) => !manifest.entries.some((entry) => entry.originalPath === path),
    );
    if (existingLocations.length > 0) {
      problems.push(
        `Restoring would recreate duplicate skill "${name}". Existing paths: ${existingLocations.join(", ")}`,
      );
    }
  }

  return problems;
}

async function findExistingSkillPaths(home: string, skill: string): Promise<string[]> {
  const config = await loadConfig(home);
  const paths: string[] = [];
  const candidateRoots = [
    config.libraryRoot,
    ...Object.values(config.platforms).flatMap((platform) => platform.roots.map((root) => root.path)),
  ];

  for (const root of candidateRoots) {
    const candidate = join(root, skill);
    try {
      await lstat(join(candidate, "SKILL.md"));
      paths.push(candidate);
    } catch {
      // Skill not present in this root.
    }
  }

  return paths;
}
