import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, SkillRoot } from "./config.js";

export type PlatformState = "missing" | "present" | "symlink";

export type ListedSkill = {
  name: string;
  description: string;
  libraryPath: string;
  platforms: Record<string, PlatformState>;
};

export type ListSkillsOptions = {
  home: string;
};

export type InspectedSkill = ListedSkill;

export type SkillLocation = {
  name: string;
  path: string;
  platform: string;
  rootId: string;
  rootRole: SkillRoot["role"];
};

export type DuplicateSkill = {
  name: string;
  locations: SkillLocation[];
};

export type PlatformSkill = {
  name: string;
  rootId: string;
  rootRole: SkillRoot["role"];
  type: "directory" | "symlink";
  description: string;
  path: string;
};

export async function listSkills(options: ListSkillsOptions): Promise<ListedSkill[]> {
  const config = await loadConfig(options.home);
  const entries = await readSkillDirs(config.libraryRoot);
  const skills: ListedSkill[] = [];

  for (const entry of entries) {
    const skillPath = join(config.libraryRoot, entry);
    const metadata = await readSkillMetadata(skillPath);
    const platforms: Record<string, PlatformState> = {};

    for (const [platform, platformConfig] of Object.entries(config.platforms)) {
      const root = platformConfig.roots.find((candidate) => candidate.role === "managed");
      platforms[platform] = root ? await readPlatformState(join(root.path, entry)) : "missing";
    }

    skills.push({
      name: entry,
      description: metadata.description,
      libraryPath: skillPath,
      platforms,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function inspectSkill(options: ListSkillsOptions, name: string): Promise<InspectedSkill | undefined> {
  const skills = await listSkills(options);
  return skills.find((skill) => skill.name === name);
}

export async function listPlatformSkills(options: ListSkillsOptions, platform: string): Promise<PlatformSkill[]> {
  const config = await loadConfig(options.home);
  const platformConfig = config.platforms[platform];
  if (!platformConfig) {
    throw new Error(`Unknown platform: ${platform}`);
  }

  const skills: PlatformSkill[] = [];
  for (const root of platformConfig.roots) {
    for (const name of await readSkillDirs(root.path)) {
      const skillPath = join(root.path, name);
      const metadata = await readSkillMetadata(skillPath);
      const entry = await lstat(skillPath);
      skills.push({
        name,
        rootId: root.id,
        rootRole: root.role,
        type: entry.isSymbolicLink() ? "symlink" : "directory",
        description: metadata.description,
        path: skillPath,
      });
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function findDuplicates(options: ListSkillsOptions): Promise<DuplicateSkill[]> {
  const config = await loadConfig(options.home);
  const locations: SkillLocation[] = [];

  for (const name of await readSkillDirs(config.libraryRoot)) {
    locations.push({
      name,
      path: join(config.libraryRoot, name),
      platform: "agents",
      rootId: "library",
      rootRole: "library",
    });
  }

  for (const [platform, platformConfig] of Object.entries(config.platforms)) {
    for (const root of platformConfig.roots) {
      for (const name of await readSkillDirs(root.path)) {
        const skillPath = join(root.path, name);
        if (await isLinkedSkill(skillPath)) {
          continue;
        }

        locations.push({
          name,
          path: skillPath,
          platform,
          rootId: root.id,
          rootRole: root.role,
        });
      }
    }
  }

  const byName = new Map<string, SkillLocation[]>();
  for (const location of locations) {
    byName.set(location.name, [...(byName.get(location.name) ?? []), location]);
  }

  return [...byName.entries()]
    .filter(([, duplicateLocations]) => duplicateLocations.length > 1)
    .map(([name, duplicateLocations]) => ({ name, locations: duplicateLocations }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const skillDirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }

      const skillPath = join(root, entry.name);
      try {
        const skillFile = await stat(join(skillPath, "SKILL.md"));
        if (skillFile.isFile()) {
          skillDirs.push(entry.name);
        }
      } catch {
        // Directories without SKILL.md are not skills.
      }
    }

    return skillDirs;
  } catch {
    return [];
  }
}

async function isLinkedSkill(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function readSkillMetadata(skillPath: string): Promise<{ description: string }> {
  try {
    const content = await readFile(join(skillPath, "SKILL.md"), "utf8");
    return { description: parseFrontmatterValue(content, "description") ?? "" };
  } catch {
    return { description: "" };
  }
}

function parseFrontmatterValue(content: string, key: string): string | undefined {
  if (!content.startsWith("---\n")) {
    return undefined;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return undefined;
  }

  const frontmatter = content.slice(4, end).split("\n");
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index];
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }

    if (line.slice(0, separator).trim() !== key) {
      continue;
    }

    const value = line.slice(separator + 1).trim();
    if (value === ">-" || value === ">" || value === "|" || value === "|-") {
      const block: string[] = [];
      for (let blockIndex = index + 1; blockIndex < frontmatter.length; blockIndex += 1) {
        const blockLine = frontmatter[blockIndex];
        if (blockLine.trim() !== "" && !/^\s/.test(blockLine)) {
          break;
        }
        block.push(blockLine.trim());
      }

      return value.startsWith("|") ? block.join("\n").trim() : block.filter(Boolean).join(" ").trim();
    }

    return value.replace(/^["']|["']$/g, "");
  }

  return undefined;
}

async function readPlatformState(path: string): Promise<PlatformState> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) {
      return "symlink";
    }

    return entry.isDirectory() ? "present" : "missing";
  } catch {
    return "missing";
  }
}
