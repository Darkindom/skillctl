import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { tmpdir } from "node:os";

import { listSkills } from "../src/skills.js";
import { createWebServer } from "../src/web.js";

test("lists central skills with platform enablement", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "tdd");
  await mkdir(agentsSkill, { recursive: true });
  await writeFile(
    join(agentsSkill, "SKILL.md"),
    "---\nname: tdd\ndescription: Test-driven development\n---\n\n# TDD\n",
  );

  const result = await listSkills({ home });

  assert.deepEqual(result, [
    {
      name: "tdd",
      description: "Test-driven development",
      libraryPath: join(home, ".agents", "skills", "tdd"),
      platforms: {
        claude: "missing",
        codex: "missing",
        cursor: "missing",
      },
    },
  ]);
});

test("loads config from ~/.agents/skillctl/config.json with home expansion", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const customSkill = join(home, ".custom-skills", "review");
  await mkdir(customSkill, { recursive: true });
  await mkdir(join(home, ".agents", "skillctl"), { recursive: true });
  await writeFile(join(customSkill, "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n");
  await writeFile(
    join(home, ".agents", "skillctl", "config.json"),
    JSON.stringify({
      libraryRoot: "~/.custom-skills",
      platforms: {},
    }),
  );

  const result = await listSkills({ home });

  assert.equal(result[0].name, "review");
  assert.equal(result[0].libraryPath, customSkill);
});

test("parses folded frontmatter descriptions", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const skill = join(home, ".agents", "skills", "confluence-upload-markdown");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: confluence-upload-markdown\ndescription: >-\n  Push Markdown to Confluence.\n  Keeps tables readable.\n---\n",
  );

  const result = await listSkills({ home });

  assert.equal(result[0].description, "Push Markdown to Confluence. Keeps tables readable.");
});

test("package metadata points to the compiled CLI entry", async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
    bin: { skillctl: string };
    scripts: { start: string };
  };

  assert.equal(packageJson.bin.skillctl, "./dist/src/cli.js");
  assert.equal(packageJson.scripts.start, "node dist/src/cli.js");
});

test("web server serves the platform-focused dashboard shell and skills API", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const skill = join(home, ".agents", "skills", "tdd");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: tdd\ndescription: Test-driven development\n---\n");
  const server = createWebServer({ home });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const html = await (await fetch(baseUrl)).text();
    assert.match(html, /<title>skillctl<\/title>/);
    assert.match(html, /aria-label="Primary navigation"/);
    assert.match(html, /data-view="skills"/);
    assert.match(html, /data-view="duplicates"/);
    assert.match(html, /data-view="backups"/);
    assert.match(html, /data-view="settings"/);
    assert.match(html, /id="skills-table"/);
    assert.match(html, /id="detail-drawer"/);
    assert.match(html, /id="search"/);
    assert.match(html, /id="platform-select"/);
    assert.match(html, /Target status/);
    assert.match(html, /id="bulk-enable"/);
    assert.match(html, /id="bulk-disable"/);
    assert.match(html, /id="duplicates-view"/);
    assert.match(html, /id="backups-view"/);
    assert.match(html, /id="settings-view"/);
    assert.match(html, /data-row-action="enable"/);
    assert.match(html, /data-row-action="disable"/);
    assert.match(html, /Resolve duplicate/);
    assert.match(html, /data-dangerous="true"/);
    assert.match(html, /id="confirm-dialog"/);
    assert.match(html, /Detail/);
    assert.match(html, /linked/);
    assert.match(html, /missing/);
    assert.match(html, /duplicate/);
    assert.doesNotMatch(html, /id="operation-output"/);
    assert.doesNotMatch(html, /<h2[^>]*>Actions<\/h2>/);
    assert.doesNotMatch(html, />Present</);
    assert.doesNotMatch(html, />symlink</);

    const payload = (await (await fetch(`${baseUrl}/api/skills`)).json()) as {
      skills: Array<{ name: string; description: string }>;
      config: { libraryRoot: string; platforms: Record<string, { roots: Array<{ id: string; role: string }> }> };
      summary: { total: number };
    };
    assert.equal(payload.summary.total, 1);
    assert.equal(payload.skills[0].name, "tdd");
    assert.equal(payload.skills[0].description, "Test-driven development");
    assert.equal(payload.config.libraryRoot, join(home, ".agents", "skills"));
    assert.equal(payload.config.platforms.codex.roots[0].role, "managed");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
});

test("web action API enables a skill for a platform", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const skill = join(home, ".agents", "skills", "tdd");
  const target = join(home, ".codex", "skills", "tdd");
  await mkdir(skill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: tdd\ndescription: Test-driven development\n---\n");
  const server = createWebServer({ home });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "enable", skill: "tdd", platform: "codex" }),
    });
    const payload = (await response.json()) as { message: string };

    assert.equal(response.status, 200);
    assert.match(payload.message, /Created symlink/);
    assert.equal((await lstat(target)).isSymbolicLink(), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
});

test("web action API resolves duplicates with a keep path, links managed targets, and restores the backup by id", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");
  const server = createWebServer({ home });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const resolveResponse = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "resolve-duplicate", skill: "tdd", keepPath: librarySkill }),
    });
    const resolvePayload = (await resolveResponse.json()) as { message: string };
    const backupId = resolvePayload.message.match(/Backup:\s+(\S+)/)?.[1];

    assert.equal(resolveResponse.status, 200);
    assert.match(resolvePayload.message, /Removed duplicates for tdd/);
    assert.match(resolvePayload.message, /Linked:/);
    assert.ok(backupId);
    assert.equal((await lstat(librarySkill)).isDirectory(), true);
    assert.equal((await lstat(codexSkill)).isSymbolicLink(), true);
    assert.equal(await readlink(codexSkill), librarySkill);

    await rm(codexSkill);
    await rm(librarySkill, { recursive: true });
    const restoreResponse = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "restore-backup", backupId }),
    });
    const restorePayload = (await restoreResponse.json()) as { message: string };

    assert.equal(restoreResponse.status, 200);
    assert.match(restorePayload.message, new RegExp(escapeRegExp(`Restored backup: ${backupId}`)));
    assert.equal((await lstat(codexSkill)).isDirectory(), true);
    assert.match(await readFile(join(codexSkill, "SKILL.md"), "utf8"), /tdd codex/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
});

test("web duplicate resolution preserves linked symlinks and enable keeps the skill non-duplicate", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "grill-me");
  const codexSkill = join(home, ".codex", "skills", "grill-me");
  const claudeSkill = join(home, ".claude", "skills", "grill-me");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await mkdir(join(home, ".claude", "skills"), { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: grill-me\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: grill-me codex copy\n---\n");
  await symlink(librarySkill, claudeSkill, "dir");
  const server = createWebServer({ home });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const resolveResponse = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "resolve-duplicate", skill: "grill-me", keepPath: librarySkill }),
    });

    assert.equal(resolveResponse.status, 200);
    assert.equal((await lstat(codexSkill)).isSymbolicLink(), true);
    assert.equal(await readlink(codexSkill), librarySkill);
    assert.equal((await lstat(claudeSkill)).isSymbolicLink(), true);

    const payload = (await (await fetch(`${baseUrl}/api/skills`)).json()) as {
      skills: Array<{ name: string; duplicate: boolean; platforms: Record<string, string> }>;
      duplicates: Array<{ name: string }>;
    };
    const skill = payload.skills.find((candidate) => candidate.name === "grill-me");

    assert.ok(skill);
    assert.equal(skill.duplicate, false);
    assert.equal(skill.platforms.codex, "symlink");
    assert.equal(skill.platforms.claude, "symlink");
    assert.equal(payload.duplicates.some((duplicate) => duplicate.name === "grill-me"), false);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
});

test("web action API resolves all auto-resolvable duplicates and skips ambiguous groups", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const libraryTdd = join(home, ".agents", "skills", "tdd");
  const codexTdd = join(home, ".codex", "skills", "tdd");
  const libraryDiagnose = join(home, ".agents", "skills", "diagnose");
  const codexDiagnose = join(home, ".codex", "skills", "diagnose");
  const claudeDiagnose = join(home, ".claude", "skills", "diagnose");
  const codexLocalOnly = join(home, ".codex", "skills", "local-only");
  const claudeLocalOnly = join(home, ".claude", "skills", "local-only");
  await mkdir(libraryTdd, { recursive: true });
  await mkdir(codexTdd, { recursive: true });
  await mkdir(libraryDiagnose, { recursive: true });
  await mkdir(codexDiagnose, { recursive: true });
  await mkdir(claudeDiagnose, { recursive: true });
  await mkdir(codexLocalOnly, { recursive: true });
  await mkdir(claudeLocalOnly, { recursive: true });
  await writeFile(join(libraryTdd, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexTdd, "SKILL.md"), "---\nname: tdd codex copy\n---\n");
  await writeFile(join(libraryDiagnose, "SKILL.md"), "---\nname: diagnose\n---\n");
  await writeFile(join(codexDiagnose, "SKILL.md"), "---\nname: diagnose codex copy\n---\n");
  await writeFile(join(claudeDiagnose, "SKILL.md"), "---\nname: diagnose claude copy\n---\n");
  await writeFile(join(codexLocalOnly, "SKILL.md"), "---\nname: local only codex\n---\n");
  await writeFile(join(claudeLocalOnly, "SKILL.md"), "---\nname: local only claude\n---\n");
  const server = createWebServer({ home });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (typeof address !== "object" || !address) {
      throw new Error("Expected server to listen on a TCP port");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const html = await (await fetch(baseUrl)).text();
    assert.match(html, /id="resolve-all-duplicates"/);
    assert.match(html, /Resolve all duplicates/);
    assert.match(html, /Show all/);

    const response = await fetch(`${baseUrl}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "resolve-all-duplicates" }),
    });
    const payload = (await response.json()) as {
      message: string;
      resolved: Array<{ skill: string; backupId: string }>;
      skipped: Array<{ skill: string; reason: string }>;
      failed: Array<{ skill: string; error: string }>;
    };

    assert.equal(response.status, 200);
    assert.match(payload.message, /Resolved 2 duplicates/);
    assert.deepEqual(
      payload.resolved.map((result) => result.skill).sort(),
      ["diagnose", "tdd"],
    );
    assert.ok(payload.resolved.every((result) => result.backupId.length > 0));
    assert.deepEqual(payload.skipped, [
      { skill: "local-only", reason: "No central library copy found." },
    ]);
    assert.deepEqual(payload.failed, []);
    assert.equal((await lstat(codexTdd)).isSymbolicLink(), true);
    assert.equal(await readlink(codexTdd), libraryTdd);
    assert.equal((await lstat(codexDiagnose)).isSymbolicLink(), true);
    assert.equal(await readlink(codexDiagnose), libraryDiagnose);
    assert.equal((await lstat(claudeDiagnose)).isSymbolicLink(), true);
    assert.equal(await readlink(claudeDiagnose), libraryDiagnose);
    assert.equal((await lstat(libraryTdd)).isDirectory(), true);
    assert.equal((await lstat(libraryDiagnose)).isDirectory(), true);
    assert.equal((await lstat(codexLocalOnly)).isDirectory(), true);
    assert.equal((await lstat(claudeLocalOnly)).isDirectory(), true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error: Error | undefined) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }),
    );
  }
});

test("CLI prints list output", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "prototype");
  await mkdir(agentsSkill, { recursive: true });
  await writeFile(
    join(agentsSkill, "SKILL.md"),
    "---\nname: prototype\ndescription: Build prototypes\n---\n",
  );

  const result = await runCli(["list"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /name\s+codex\s+claude\s+cursor\s+description/);
  assert.match(result.stdout, /prototype\s+missing\s+missing\s+missing\s+Build prototypes/);
});

test("CLI lists skills for one platform", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const codexSkill = join(home, ".codex", "skills", "review");
  await mkdir(codexSkill, { recursive: true });
  await writeFile(
    join(codexSkill, "SKILL.md"),
    "---\nname: review\ndescription: Review changes\n---\n",
  );

  const result = await runCli(["list", "--platform", "codex"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /name\s+root\s+role\s+type\s+description/);
  assert.match(result.stdout, /review\s+default\s+managed\s+directory\s+Review changes/);
});

test("CLI inspects a skill", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "grill-me");
  await mkdir(agentsSkill, { recursive: true });
  await writeFile(
    join(agentsSkill, "SKILL.md"),
    "---\nname: grill-me\ndescription: Interview relentlessly\n---\n",
  );

  const result = await runCli(["inspect", "grill-me"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /name:\s+grill-me/);
  assert.match(result.stdout, /description:\s+Interview relentlessly/);
  assert.match(result.stdout, new RegExp(escapeRegExp(`library: ${agentsSkill}`)));
  assert.match(result.stdout, /codex:\s+missing/);
  assert.match(result.stdout, /claude:\s+missing/);
  assert.match(result.stdout, /cursor:\s+missing/);
});

test("CLI enables a skill for a platform by creating a symlink", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "tdd");
  await mkdir(agentsSkill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(agentsSkill, "SKILL.md"), "---\nname: tdd\n---\n");

  const result = await runCli(["enable", "tdd", "--platform", "codex"], { SKILLCTL_HOME: home });

  const target = join(home, ".codex", "skills", "tdd");
  const targetStat = await lstat(target);
  assert.equal(result.code, 0);
  assert.equal(targetStat.isSymbolicLink(), true);
  assert.equal(await readlink(target), agentsSkill);
  assert.match(result.stdout, new RegExp(escapeRegExp(`Created symlink: ${target} -> ${agentsSkill}`)));
});

test("CLI dry-runs enable without creating a symlink", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "tdd");
  const target = join(home, ".codex", "skills", "tdd");
  await mkdir(agentsSkill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(agentsSkill, "SKILL.md"), "---\nname: tdd\n---\n");

  const result = await runCli(["enable", "tdd", "--platform", "codex", "--dry-run"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.match(result.stdout, /Would create symlink/);
});

test("CLI refuses to enable over an existing target", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "tdd");
  const target = join(home, ".codex", "skills", "tdd");
  await mkdir(agentsSkill, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(agentsSkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(target, "SKILL.md"), "---\nname: tdd local\n---\n");

  const result = await runCli(["enable", "tdd", "--platform", "codex"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Target already exists/);
  assert.equal((await lstat(target)).isDirectory(), true);
});

test("CLI disables a skill by removing only a platform symlink", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const agentsSkill = join(home, ".agents", "skills", "tdd");
  const target = join(home, ".codex", "skills", "tdd");
  await mkdir(agentsSkill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(agentsSkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await symlink(agentsSkill, target, "dir");

  const result = await runCli(["disable", "tdd", "--platform", "codex"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.match(result.stdout, new RegExp(escapeRegExp(`Removed symlink: ${target}`)));
});

test("CLI refuses to disable a real skill directory", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const target = join(home, ".codex", "skills", "tdd");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "SKILL.md"), "---\nname: tdd\n---\n");

  const result = await runCli(["disable", "tdd", "--platform", "codex"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Target is not a symlink/);
  assert.equal((await lstat(target)).isDirectory(), true);
});

test("CLI lists duplicate skills by directory name across roots", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  const claudeSkill = join(home, ".claude", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await mkdir(claudeSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: test-driven\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(claudeSkill, "SKILL.md"), "---\nname: something-else\n---\n");

  const result = await runCli(["duplicates"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /tdd/);
  assert.match(result.stdout, new RegExp(escapeRegExp(librarySkill)));
  assert.match(result.stdout, new RegExp(escapeRegExp(codexSkill)));
  assert.match(result.stdout, new RegExp(escapeRegExp(claudeSkill)));
});

test("CLI removes duplicate real directories with backup while keeping selected path", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");

  const result = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.equal((await lstat(librarySkill)).isDirectory(), true);
  await assert.rejects(lstat(codexSkill), { code: "ENOENT" });
  assert.match(result.stdout, /Backup:/);
  const backupId = result.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);
  const manifest = JSON.parse(
    await readFile(join(home, ".agents", "skillctl", "backups", backupId, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.entries[0].originalPath, codexSkill);
  assert.equal(manifest.entries[0].kind, "directory");
});

test("CLI interactively asks which duplicate to keep", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");

  const result = await runCli(["rm-duplicate", "tdd"], { SKILLCTL_HOME: home }, "1\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Duplicate skill: tdd/);
  assert.match(result.stdout, /Which one should be kept/);
  assert.equal((await lstat(librarySkill)).isDirectory(), true);
  await assert.rejects(lstat(codexSkill), { code: "ENOENT" });
});

test("CLI dry-runs duplicate removal without deleting or creating a backup", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");

  const result = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill, "--dry-run"], {
    SKILLCTL_HOME: home,
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Would remove duplicates/);
  assert.equal((await lstat(codexSkill)).isDirectory(), true);
  await assert.rejects(lstat(join(home, ".agents", "skillctl", "backups")), { code: "ENOENT" });
});

test("CLI does not treat linked platform symlinks as duplicate skills", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await symlink(librarySkill, codexSkill, "dir");

  const duplicateResult = await runCli(["duplicates"], { SKILLCTL_HOME: home });
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });

  assert.equal(duplicateResult.code, 0);
  assert.match(duplicateResult.stdout, /No duplicates found/);
  assert.equal(removeResult.code, 1);
  assert.match(removeResult.stderr, /No duplicate skill found: tdd/);
  assert.equal((await lstat(codexSkill)).isSymbolicLink(), true);
});

test("CLI lists available backups", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd\n---\n");
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });
  const backupId = removeResult.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);

  const result = await runCli(["backups"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, new RegExp(escapeRegExp(backupId)));
  assert.match(result.stdout, /rm-duplicate/);
  assert.match(result.stdout, /tdd/);
});

test("CLI restores a backed up real directory when no duplicate remains", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });
  const backupId = removeResult.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);
  await rm(librarySkill, { recursive: true });

  const result = await runCli(["restore", backupId], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.equal((await lstat(codexSkill)).isDirectory(), true);
  assert.match(await readFile(join(codexSkill, "SKILL.md"), "utf8"), /tdd codex/);
  assert.match(result.stdout, new RegExp(escapeRegExp(`Restored backup: ${backupId}`)));
});

test("CLI blocks restore when it would recreate a duplicate", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });
  const backupId = removeResult.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);

  const result = await runCli(["restore", backupId], { SKILLCTL_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Restore blocked/);
  assert.match(result.stderr, /duplicate skill "tdd"/);
  await assert.rejects(lstat(codexSkill), { code: "ENOENT" });
});

test("CLI dry-runs restore without writing files", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });
  const backupId = removeResult.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);
  await rm(librarySkill, { recursive: true });

  const result = await runCli(["restore", backupId, "--dry-run"], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Would restore backup/);
  await assert.rejects(lstat(codexSkill), { code: "ENOENT" });
});

test("CLI restores a backed up symlink with its original target", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  const backupId = "manual-symlink-backup";
  const backupRoot = join(home, ".agents", "skillctl", "backups", backupId);
  await mkdir(librarySkill, { recursive: true });
  await mkdir(join(home, ".codex", "skills"), { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await mkdir(backupRoot, { recursive: true });
  await writeFile(
    join(backupRoot, "manifest.json"),
    JSON.stringify({
      id: backupId,
      type: "rm-duplicate",
      skill: "tdd",
      keepPath: librarySkill,
      entries: [
        {
          originalPath: codexSkill,
          kind: "symlink",
          linkTarget: librarySkill,
        },
      ],
    }),
  );

  const result = await runCli(["restore", backupId], { SKILLCTL_HOME: home });

  assert.equal(result.code, 0);
  assert.equal((await lstat(codexSkill)).isSymbolicLink(), true);
  assert.equal(await readlink(codexSkill), librarySkill);
});

test("CLI blocks restore when target path already exists", async () => {
  const home = join(tmpdir(), `skillctl-${Date.now()}-${Math.random()}`);
  const librarySkill = join(home, ".agents", "skills", "tdd");
  const codexSkill = join(home, ".codex", "skills", "tdd");
  await mkdir(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(librarySkill, "SKILL.md"), "---\nname: tdd\n---\n");
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: tdd codex\n---\n");
  const removeResult = await runCli(["rm-duplicate", "tdd", "--keep", librarySkill], { SKILLCTL_HOME: home });
  const backupId = removeResult.stdout.match(/Backup:\s+(\S+)/)?.[1];
  assert.ok(backupId);
  await rm(librarySkill, { recursive: true });
  await mkdir(codexSkill, { recursive: true });
  await writeFile(join(codexSkill, "SKILL.md"), "---\nname: replacement\n---\n");

  const result = await runCli(["restore", backupId], { SKILLCTL_HOME: home });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Restore target already exists/);
  assert.match(await readFile(join(codexSkill, "SKILL.md"), "utf8"), /replacement/);
});

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  input = "",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "src", "cli.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(input);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
