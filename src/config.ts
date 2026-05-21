import { join } from "node:path";
import { readFile } from "node:fs/promises";

export type RootRole = "library" | "managed" | "readonly";

export type SkillRoot = {
  id: string;
  path: string;
  role: RootRole;
};

export type PlatformConfig = {
  roots: SkillRoot[];
};

export type SkillctlConfig = {
  libraryRoot: string;
  stateRoot: string;
  platforms: Record<string, PlatformConfig>;
};

export function defaultConfig(home: string): SkillctlConfig {
  return {
    libraryRoot: join(home, ".agents", "skills"),
    stateRoot: join(home, ".agents", "skillctl"),
    platforms: {
      codex: {
        roots: [
          { id: "default", path: join(home, ".codex", "skills"), role: "managed" },
          { id: "system", path: join(home, ".codex", "skills", ".system"), role: "readonly" },
        ],
      },
      claude: {
        roots: [{ id: "default", path: join(home, ".claude", "skills"), role: "managed" }],
      },
      cursor: {
        roots: [
          { id: "default", path: join(home, ".cursor", "skills"), role: "managed" },
          { id: "superpowers", path: join(home, ".cursor", "skills", "superpowers"), role: "readonly" },
          { id: "cursor-cli", path: join(home, ".cursor", "skills-cursor"), role: "readonly" },
        ],
      },
    },
  };
}

export async function loadConfig(home: string): Promise<SkillctlConfig> {
  const defaults = defaultConfig(home);
  const configPath = join(defaults.stateRoot, "config.json");

  let rawConfig: Partial<SkillctlConfig>;
  try {
    rawConfig = JSON.parse(await readFile(configPath, "utf8")) as Partial<SkillctlConfig>;
  } catch {
    return defaults;
  }

  return normalizeConfig(
    {
      ...defaults,
      ...rawConfig,
      platforms: rawConfig.platforms ?? defaults.platforms,
    },
    home,
  );
}

function normalizeConfig(config: SkillctlConfig, home: string): SkillctlConfig {
  return {
    libraryRoot: expandHome(config.libraryRoot, home),
    stateRoot: expandHome(config.stateRoot, home),
    platforms: Object.fromEntries(
      Object.entries(config.platforms).map(([platform, platformConfig]) => [
        platform,
        {
          roots: platformConfig.roots.map((root) => ({
            ...root,
            path: expandHome(root.path, home),
          })),
        },
      ]),
    ),
  };
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
