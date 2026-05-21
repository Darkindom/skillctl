#!/usr/bin/env node

import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";

import { disableSkill, enableSkill, listBackups, removeDuplicateSkill, restoreBackup } from "./operations.js";
import { findDuplicates, inspectSkill, listPlatformSkills, listSkills } from "./skills.js";
import { createWebServer } from "./web.js";

const command = process.argv[2] ?? "list";
const home = process.env.SKILLCTL_HOME ?? homedir();

try {
  if (command === "list") {
    const platform = readFlag("--platform");
    if (platform) {
      const skills = await listPlatformSkills({ home }, platform);
      printTable([
        ["name", "root", "role", "type", "description"],
        ...skills.map((skill) => [skill.name, skill.rootId, skill.rootRole, skill.type, skill.description]),
      ]);
    } else {
      const skills = await listSkills({ home });
      printTable([
        ["name", "codex", "claude", "cursor", "description"],
        ...skills.map((skill) => [
          skill.name,
          skill.platforms.codex ?? "missing",
          skill.platforms.claude ?? "missing",
          skill.platforms.cursor ?? "missing",
          skill.description,
        ]),
      ]);
    }
  } else if (command === "inspect") {
    const skillName = process.argv[3];
    if (!skillName) {
      throw new Error("Usage: skillctl inspect <skill>");
    }

    const skill = await inspectSkill({ home }, skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    console.log(`name: ${skill.name}`);
    console.log(`description: ${skill.description}`);
    console.log(`library: ${skill.libraryPath}`);
    for (const [platform, state] of Object.entries(skill.platforms)) {
      console.log(`${platform}: ${state}`);
    }
  } else if (command === "enable") {
    const skillName = process.argv[3];
    const platform = readFlag("--platform");
    if (!skillName || !platform) {
      throw new Error("Usage: skillctl enable <skill> --platform <platform>");
    }

    const result = await enableSkill({ home, dryRun: hasFlag("--dry-run") }, skillName, platform);
    console.log(result.message);
  } else if (command === "disable") {
    const skillName = process.argv[3];
    const platform = readFlag("--platform");
    if (!skillName || !platform) {
      throw new Error("Usage: skillctl disable <skill> --platform <platform>");
    }

    const result = await disableSkill({ home, dryRun: hasFlag("--dry-run") }, skillName, platform);
    console.log(result.message);
  } else if (command === "duplicates") {
    const duplicates = await findDuplicates({ home });
    if (duplicates.length === 0) {
      console.log("No duplicates found.");
    }

    for (const duplicate of duplicates) {
      console.log(duplicate.name);
      for (const location of duplicate.locations) {
        console.log(`  - ${location.path} (${location.platform}/${location.rootId}, ${location.rootRole})`);
      }
    }
  } else if (command === "rm-duplicate") {
    const skillName = process.argv[3];
    let keepPath = readFlag("--keep");
    if (!skillName) {
      throw new Error("Usage: skillctl rm-duplicate <skill> [--keep <path>]");
    }

    if (!keepPath) {
      keepPath = await askDuplicateKeepPath(skillName);
    }

    const result = await removeDuplicateSkill({ home, dryRun: hasFlag("--dry-run") }, skillName, keepPath);
    console.log(result.message);
  } else if (command === "backups") {
    const backups = await listBackups({ home });
    if (backups.length === 0) {
      console.log("No backups found.");
    } else {
      printTable([
        ["id", "type", "skill", "entries"],
        ...backups.map((backup) => [backup.id, backup.type, backup.skill, String(backup.entryCount)]),
      ]);
    }
  } else if (command === "restore") {
    const backupId = process.argv[3] ?? "latest";
    const result = await restoreBackup({ home, dryRun: hasFlag("--dry-run") }, backupId);
    console.log(result.message);
  } else if (command === "web") {
    const port = Number(readFlag("--port") ?? "1717");
    const host = readFlag("--host") ?? "127.0.0.1";
    const server = createWebServer({ home });
    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      console.log(`skillctl web: http://${host}:${resolvedPort}`);
    });
  } else {
    console.error(`Unknown command: ${command}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function askDuplicateKeepPath(skillName: string): Promise<string> {
  const duplicate = (await findDuplicates({ home })).find((candidate) => candidate.name === skillName);
  if (!duplicate) {
    throw new Error(`No duplicate skill found: ${skillName}`);
  }

  console.log(`Duplicate skill: ${skillName}`);
  duplicate.locations.forEach((location, index) => {
    console.log(`${index + 1}. ${location.path}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Which one should be kept? [1-${duplicate.locations.length}] `);
  rl.close();

  const index = Number(answer.trim()) - 1;
  const location = duplicate.locations[index];
  if (!location) {
    throw new Error(`Invalid selection: ${answer}`);
  }

  return location.path;
}

function printTable(rows: string[][]): void {
  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex]?.length ?? 0)),
  );

  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd());
  }
}
