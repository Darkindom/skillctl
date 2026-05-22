import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { loadConfig } from "./config.js";
import { disableSkill, enableSkill, listBackups, resolveDuplicateSkill, restoreBackup } from "./operations.js";
import { findDuplicates, listSkills, type DuplicateSkill } from "./skills.js";

export type WebServerOptions = {
  home: string;
};

type WebActionRequest = {
  type: string;
  skill?: string;
  platform?: string;
  skills?: string[];
  backupId?: string;
  keepPath?: string;
};

type ResolveAllResult = {
  message: string;
  resolved: Array<{ skill: string; backupId: string }>;
  skipped: Array<{ skill: string; reason: string }>;
  failed: Array<{ skill: string; error: string }>;
};

export function createWebServer(options: WebServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        send(response, 200, "text/html; charset=utf-8", renderDashboardHtmlV2());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skills") {
        const [config, skills, duplicates, backups] = await Promise.all([
          loadConfig(options.home),
          listSkills({ home: options.home }),
          findDuplicates({ home: options.home }),
          listBackups({ home: options.home }),
        ]);
        const duplicateNames = new Set(duplicates.map((duplicate) => duplicate.name));
        const platforms = [...new Set(skills.flatMap((skill) => Object.keys(skill.platforms)))].sort();
        const enabledCount = skills.filter((skill) =>
          Object.values(skill.platforms).some((state) => state === "present" || state === "symlink"),
        ).length;

        sendJson(response, {
          summary: {
            total: skills.length,
            enabled: enabledCount,
            duplicates: duplicates.length,
            backups: backups.length,
          },
          config,
          platforms,
          skills: skills.map((skill) => ({
            ...skill,
            duplicate: duplicateNames.has(skill.name),
          })),
          duplicates,
          backups,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/actions") {
        const action = (await readJson(request)) as WebActionRequest;
        sendJson(response, await runWebAction(options.home, action));
        return;
      }

      send(response, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
    }
  });
}

function sendJson(response: ServerResponse, body: unknown): void {
  send(response, 200, "application/json; charset=utf-8", JSON.stringify(body));
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function runWebAction(home: string, action: WebActionRequest): Promise<{ message: string }> {
  if (action.type === "enable") {
    return enableSkill({ home }, requireSkill(action), requirePlatform(action));
  }

  if (action.type === "disable") {
    return disableSkill({ home }, requireSkill(action), requirePlatform(action));
  }

  if (action.type === "bulk-enable" || action.type === "bulk-disable") {
    const platform = requirePlatform(action);
    const skills = requireSkills(action);
    const messages: string[] = [];
    for (const skill of skills) {
      const result =
        action.type === "bulk-enable"
          ? await enableSkill({ home }, skill, platform)
          : await disableSkill({ home }, skill, platform);
      messages.push(result.message);
    }

    return { message: messages.join("\n") };
  }

  if (action.type === "find-duplicates") {
    const duplicates = await findDuplicates({ home });
    return {
      message:
        duplicates.length === 0
          ? "No duplicates found."
          : duplicates
              .map(
                (duplicate) =>
                  `${duplicate.name}\n${duplicate.locations
                    .map((location) => `  - ${location.path} (${location.platform}/${location.rootId})`)
                    .join("\n")}`,
              )
              .join("\n\n"),
    };
  }

  if (action.type === "show-backups") {
    const backups = await listBackups({ home });
    return {
      message:
        backups.length === 0
          ? "No backups found."
          : backups
              .map((backup) => `${backup.id}  ${backup.type}  ${backup.skill}  entries:${backup.entryCount}`)
              .join("\n"),
    };
  }

  if (action.type === "resolve-duplicate") {
    return resolveDuplicateSkill({ home }, requireSkill(action), requireKeepPath(action));
  }

  if (action.type === "resolve-all-duplicates") {
    return resolveAllDuplicates(home);
  }

  if (action.type === "restore-backup") {
    return restoreBackup({ home }, requireBackupId(action));
  }

  if (action.type === "restore-latest") {
    return restoreBackup({ home }, action.backupId ?? "latest");
  }

  throw new Error(`Unknown action: ${action.type}`);
}

async function resolveAllDuplicates(home: string): Promise<ResolveAllResult> {
  const duplicates = await findDuplicates({ home });
  const resolved: ResolveAllResult["resolved"] = [];
  const skipped: ResolveAllResult["skipped"] = [];
  const failed: ResolveAllResult["failed"] = [];

  for (const duplicate of duplicates) {
    const keepPath = autoKeepPath(duplicate);
    if (!keepPath) {
      skipped.push({ skill: duplicate.name, reason: "No central library copy found." });
      continue;
    }

    try {
      const result = await resolveDuplicateSkill({ home }, duplicate.name, keepPath);
      resolved.push({
        skill: duplicate.name,
        backupId: result.message.match(/Backup:\s+(\S+)/)?.[1] ?? "",
      });
    } catch (error) {
      failed.push({
        skill: duplicate.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    message: `Resolved ${resolved.length} duplicates, skipped ${skipped.length}, failed ${failed.length}.`,
    resolved,
    skipped,
    failed,
  };
}

function autoKeepPath(duplicate: DuplicateSkill): string | undefined {
  return duplicate.locations.find((location) => location.rootRole === "library")?.path;
}

function requireSkill(action: WebActionRequest): string {
  if (!action.skill) {
    throw new Error("Missing skill.");
  }

  return action.skill;
}

function requireSkills(action: WebActionRequest): string[] {
  if (!action.skills || action.skills.length === 0) {
    throw new Error("Select at least one skill.");
  }

  return action.skills;
}

function requirePlatform(action: WebActionRequest): string {
  if (!action.platform) {
    throw new Error("Missing platform.");
  }

  return action.platform;
}

function requireKeepPath(action: WebActionRequest): string {
  if (!action.keepPath) {
    throw new Error("Missing keep path.");
  }

  return action.keepPath;
}

function requireBackupId(action: WebActionRequest): string {
  if (!action.backupId) {
    throw new Error("Missing backup id.");
  }

  return action.backupId;
}

function renderDashboardHtmlV2(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>skillctl</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f6f8;
        --sidebar: #111827;
        --sidebar-muted: #9ca3af;
        --surface: #ffffff;
        --surface-muted: #eef2f6;
        --line: #d7dde5;
        --text: #111827;
        --muted: #5f6f82;
        --blue: #1f6fd6;
        --green: #087443;
        --amber: #9a5b00;
        --red: #b42318;
        --shadow: 0 16px 40px rgba(17, 24, 39, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100dvh;
        background: var(--bg);
        color: var(--text);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }

      button,
      input,
      select {
        font: inherit;
      }

      button {
        cursor: pointer;
      }

      button:focus-visible,
      input:focus-visible,
      select:focus-visible {
        outline: 3px solid rgba(31, 111, 214, 0.24);
        outline-offset: 2px;
      }

      .app {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 280px minmax(0, 1fr);
      }

      .sidebar {
        position: sticky;
        top: 0;
        height: 100dvh;
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: 22px;
        padding: 24px 18px;
        overflow: auto;
        color: #e5e7eb;
        background: var(--sidebar);
      }

      .brand {
        display: grid;
        gap: 6px;
        padding: 0 6px;
      }

      .brand h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.1;
        letter-spacing: 0;
      }

      .brand p,
      .sidebar-foot p {
        margin: 0;
        color: var(--sidebar-muted);
        overflow-wrap: anywhere;
      }

      .nav-list {
        display: grid;
        gap: 6px;
      }

      .nav-button {
        width: 100%;
        min-height: 42px;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        color: #cbd5e1;
        background: transparent;
        text-align: left;
      }

      .nav-button:hover,
      .nav-button:focus-visible {
        color: #ffffff;
        background: rgba(255, 255, 255, 0.08);
      }

      .nav-button[aria-current="page"] {
        color: #ffffff;
        background: #1f2937;
        border-color: rgba(255, 255, 255, 0.1);
      }

      .nav-count {
        min-width: 28px;
        border-radius: 999px;
        padding: 2px 8px;
        color: #dbeafe;
        background: rgba(59, 130, 246, 0.18);
        text-align: center;
        font-variant-numeric: tabular-nums;
        font-size: 12px;
        font-weight: 700;
      }

      .sidebar-foot {
        display: grid;
        gap: 12px;
        padding: 14px 6px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.12);
      }

      .status-line {
        min-height: 20px;
        color: #cbd5e1;
      }

      main {
        min-width: 0;
        padding: 28px 32px;
        display: grid;
        align-content: start;
        gap: 18px;
      }

      .view {
        display: none;
      }

      .view.active {
        display: grid;
        gap: 18px;
      }

      .page-header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 18px;
        align-items: start;
      }

      .title-block {
        display: grid;
        gap: 4px;
      }

      .title-block h2 {
        margin: 0;
        font-size: 28px;
        line-height: 1.15;
        letter-spacing: 0;
      }

      .title-block p {
        margin: 0;
        color: var(--muted);
      }

      .controls {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        flex-wrap: wrap;
      }

      .platform-select,
      .search {
        min-height: 42px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
      }

      .platform-select {
        padding: 0 12px;
      }

      .search {
        width: 320px;
        padding: 0 14px;
      }

      .tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .filter {
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
        background: var(--surface);
      }

      .filter[aria-pressed="true"] {
        border-color: var(--blue);
        color: #0b4d96;
        background: #e8f1ff;
      }

      .filter-count {
        font-variant-numeric: tabular-nums;
        font-weight: 700;
      }

      .bulk-bar {
        min-height: 54px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fbfcfd;
      }

      .bulk-actions {
        display: flex;
        gap: 8px;
      }

      .button {
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        color: var(--text);
        background: var(--surface);
        font-weight: 650;
      }

      .button.primary {
        border-color: #0b5fc2;
        color: #ffffff;
        background: var(--blue);
      }

      .button.warning {
        color: #734300;
        background: #fff7e8;
      }

      .button.danger {
        color: var(--red);
        background: #fff1f0;
      }

      .button[disabled] {
        cursor: not-allowed;
        color: #6b7280;
        background: var(--surface-muted);
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .table-wrap {
        overflow: auto;
        max-height: calc(100dvh - 230px);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      th,
      td {
        padding: 13px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: middle;
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #f9fafb;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      tbody tr:hover td {
        background: #f7fbff;
      }

      .selection-cell {
        text-align: center;
      }

      .selection-cell input {
        width: 18px;
        height: 18px;
      }

      .name-cell {
        font-weight: 700;
        overflow-wrap: anywhere;
      }

      .description {
        color: var(--muted);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        border-radius: 999px;
        padding: 0 9px;
        font-size: 12px;
        font-weight: 700;
        white-space: nowrap;
      }

      .badge.linked {
        color: #075a35;
        background: #ddf7ea;
      }

      .badge.missing {
        color: #5b6675;
        background: #edf1f6;
      }

      .badge.duplicate {
        color: #734300;
        background: #fff0d1;
      }

      .badge.readonly {
        color: #475569;
        background: #e2e8f0;
      }

      .row-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .action-cell {
        text-align: right;
      }

      .empty {
        padding: 28px;
        color: var(--muted);
      }

      .workbench {
        display: grid;
        gap: 12px;
      }

      .record {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        overflow: hidden;
      }

      .record-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        background: #fbfcfd;
      }

      .record-title {
        margin: 0;
        font-size: 16px;
        letter-spacing: 0;
      }

      .record-body {
        display: grid;
        gap: 10px;
        padding: 14px 16px;
      }

      .path-option,
      .root-row,
      .backup-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #ffffff;
      }

      code {
        color: #1f2937;
        overflow-wrap: anywhere;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 12px;
      }

      .muted {
        color: var(--muted);
      }

      .detail-drawer {
        position: fixed;
        top: 0;
        right: 0;
        z-index: 20;
        width: 420px;
        height: 100dvh;
        display: grid;
        grid-template-rows: auto 1fr;
        background: var(--surface);
        border-left: 1px solid var(--line);
        box-shadow: -20px 0 40px rgba(17, 24, 39, 0.14);
        transform: translateX(100%);
        transition: transform 180ms ease-out;
      }

      .detail-drawer.open {
        transform: translateX(0);
      }

      .drawer-header,
      .dialog-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--line);
      }

      .drawer-body {
        display: grid;
        align-content: start;
        gap: 14px;
        padding: 20px;
        overflow: auto;
      }

      .drawer-title,
      .dialog-title {
        margin: 0;
        font-size: 20px;
        letter-spacing: 0;
      }

      .detail-grid {
        display: grid;
        gap: 8px;
      }

      .detail-grid dt {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
      }

      .detail-grid dd {
        margin: 0 0 8px;
      }

      dialog {
        width: min(520px, calc(100vw - 32px));
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0;
        color: var(--text);
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      dialog::backdrop {
        background: rgba(17, 24, 39, 0.42);
      }

      .dialog-body {
        display: grid;
        gap: 14px;
        padding: 18px 20px;
      }

      .view-status {
        min-height: 22px;
        color: var(--muted);
      }

      .summary-list {
        margin: 0;
        padding-left: 18px;
      }

      .summary-list.collapsed li:nth-child(n + 11) {
        display: none;
      }

      .result-box {
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: #fbfcfd;
      }
    </style>
  </head>
  <body>
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <h1>skillctl</h1>
          <p id="library-path">Loading library root</p>
        </div>
        <nav aria-label="Primary navigation" class="nav-list">
          <button class="nav-button" type="button" data-view="skills" aria-current="page">
            <span>Skills</span><span class="nav-count" id="nav-skills-count">0</span>
          </button>
          <button class="nav-button" type="button" data-view="duplicates">
            <span>Duplicates</span><span class="nav-count" id="nav-duplicates-count">0</span>
          </button>
          <button class="nav-button" type="button" data-view="backups">
            <span>Backups</span><span class="nav-count" id="nav-backups-count">0</span>
          </button>
          <button class="nav-button" type="button" data-view="settings">
            <span>Settings</span>
          </button>
        </nav>
        <div class="sidebar-foot">
          <p>Recent operation</p>
          <div class="status-line" id="operation-status" aria-live="polite">Ready</div>
        </div>
      </aside>

      <main>
        <section class="view active" id="skills-view" data-view-panel="skills">
          <div class="page-header">
            <div class="title-block">
              <h2>Skills</h2>
              <p>Choose one platform first, then manage each skill status on that platform.</p>
            </div>
            <div class="controls">
              <label>
                <span class="muted">Target platform</span>
                <select class="platform-select" id="platform-select" aria-label="Target platform">
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                  <option value="cursor">cursor</option>
                </select>
              </label>
              <input class="search" id="search" type="search" aria-label="Search skills" placeholder="Search skills">
            </div>
          </div>

          <div class="tabs" aria-label="Filters">
            <button class="filter" type="button" data-filter="all" aria-pressed="true">
              <span>All</span><strong class="filter-count" id="total-count">0</strong>
            </button>
            <button class="filter" type="button" data-filter="linked" aria-pressed="false">
              <span>linked</span><strong class="filter-count" id="linked-count">0</strong>
            </button>
            <button class="filter" type="button" data-filter="missing" aria-pressed="false">
              <span>missing</span><strong class="filter-count" id="missing-count">0</strong>
            </button>
            <button class="filter" type="button" data-filter="duplicate" aria-pressed="false">
              <span>duplicate</span><strong class="filter-count" id="duplicate-count">0</strong>
            </button>
          </div>

          <div class="bulk-bar">
            <span><strong id="selected-count">0</strong> selected</span>
            <div class="bulk-actions">
              <button class="button" id="bulk-enable" type="button" data-action="bulk-enable" data-dangerous="true" disabled>Enable selected</button>
              <button class="button warning" id="bulk-disable" type="button" data-action="bulk-disable" data-dangerous="true" disabled>Disable selected</button>
            </div>
          </div>

          <section class="panel">
            <div class="table-wrap">
              <table id="skills-table">
                <colgroup>
                  <col style="width: 52px">
                  <col style="width: 22%">
                  <col style="width: 150px">
                  <col>
                  <col style="width: 250px">
                </colgroup>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Name</th>
                    <th>Target status</th>
                    <th>Description</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="skills-body"></tbody>
              </table>
            </div>
            <div id="skills-empty" class="empty" hidden>No matching skills.</div>
          </section>
        </section>

        <section class="view" id="duplicates-view" data-view-panel="duplicates">
          <div class="page-header">
            <div class="title-block">
              <h2>Duplicates</h2>
              <p>Resolve duplicate skills by choosing one path to keep. File contents are not merged.</p>
            </div>
            <div class="controls">
              <button class="button danger" id="resolve-all-duplicates" type="button" data-action="resolve-all-duplicates" data-dangerous="true">Resolve all duplicates</button>
            </div>
          </div>
          <div class="view-status" id="duplicates-status"></div>
          <div class="workbench" id="duplicates-list"></div>
          <div class="empty" id="duplicates-empty" hidden>No duplicate skills found.</div>
        </section>

        <section class="view" id="backups-view" data-view-panel="backups">
          <div class="page-header">
            <div class="title-block">
              <h2>Backups</h2>
              <p>Restore backed up duplicate removals when the filesystem is safe.</p>
            </div>
          </div>
          <div class="workbench" id="backups-list"></div>
          <div class="empty" id="backups-empty" hidden>No backups found.</div>
        </section>

        <section class="view" id="settings-view" data-view-panel="settings">
          <div class="page-header">
            <div class="title-block">
              <h2>Settings</h2>
              <p>Configured skill roots and write roles.</p>
            </div>
          </div>
          <div class="workbench" id="settings-list"></div>
        </section>
      </main>
    </div>

    <aside class="detail-drawer" id="detail-drawer" aria-label="Skill detail" aria-hidden="true">
      <div class="drawer-header">
        <h2 class="drawer-title" id="detail-title">Skill detail</h2>
        <button class="button" type="button" id="detail-close">Close</button>
      </div>
      <div class="drawer-body" id="detail-body"></div>
    </aside>

    <dialog id="confirm-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">Confirm action</h2>
        <button class="button" type="button" id="confirm-cancel">Cancel</button>
      </div>
      <div class="dialog-body">
        <p id="confirm-message">This action changes skill files.</p>
        <div id="confirm-detail"></div>
        <button class="button primary" type="button" id="confirm-run">Run action</button>
      </div>
    </dialog>

    <script>
      const state = {
        skills: [],
        duplicates: [],
        backups: [],
        config: null,
        filter: "all",
        platform: "codex",
        query: "",
        selected: new Set(),
        activeView: "skills",
        pendingAction: null,
      };

      const nodes = {
        navButtons: [...document.querySelectorAll(".nav-button")],
        viewPanels: [...document.querySelectorAll("[data-view-panel]")],
        libraryPath: document.querySelector("#library-path"),
        operationStatus: document.querySelector("#operation-status"),
        platform: document.querySelector("#platform-select"),
        search: document.querySelector("#search"),
        filters: [...document.querySelectorAll(".filter")],
        total: document.querySelector("#total-count"),
        linked: document.querySelector("#linked-count"),
        missing: document.querySelector("#missing-count"),
        duplicate: document.querySelector("#duplicate-count"),
        selectedCount: document.querySelector("#selected-count"),
        navSkillsCount: document.querySelector("#nav-skills-count"),
        navDuplicatesCount: document.querySelector("#nav-duplicates-count"),
        navBackupsCount: document.querySelector("#nav-backups-count"),
        bulkEnable: document.querySelector("#bulk-enable"),
        bulkDisable: document.querySelector("#bulk-disable"),
        skillsBody: document.querySelector("#skills-body"),
        skillsEmpty: document.querySelector("#skills-empty"),
        duplicatesList: document.querySelector("#duplicates-list"),
        duplicatesEmpty: document.querySelector("#duplicates-empty"),
        backupsList: document.querySelector("#backups-list"),
        backupsEmpty: document.querySelector("#backups-empty"),
        settingsList: document.querySelector("#settings-list"),
        resolveAllDuplicates: document.querySelector("#resolve-all-duplicates"),
        duplicatesStatus: document.querySelector("#duplicates-status"),
        detailDrawer: document.querySelector("#detail-drawer"),
        detailTitle: document.querySelector("#detail-title"),
        detailBody: document.querySelector("#detail-body"),
        detailClose: document.querySelector("#detail-close"),
        confirmDialog: document.querySelector("#confirm-dialog"),
        confirmMessage: document.querySelector("#confirm-message"),
        confirmDetail: document.querySelector("#confirm-detail"),
        confirmCancel: document.querySelector("#confirm-cancel"),
        confirmRun: document.querySelector("#confirm-run"),
      };

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]);
      }

      function displayPlatformState(value) {
        if (value === "symlink") return "linked";
        if (value === "present") return "duplicate";
        return "missing";
      }

      function targetRawState(skill) {
        return skill.platforms[state.platform] || "missing";
      }

      function targetStatus(skill) {
        return displayPlatformState(targetRawState(skill));
      }

      function countsForPlatform() {
        const counts = { total: state.skills.length, linked: 0, missing: 0, duplicate: 0 };
        for (const skill of state.skills) {
          counts[targetStatus(skill)] += 1;
        }
        return counts;
      }

      function filteredSkills() {
        const query = state.query.trim().toLowerCase();
        return state.skills.filter((skill) => {
          const status = targetStatus(skill);
          if (state.filter !== "all" && status !== state.filter) return false;
          if (!query) return true;
          return [skill.name, skill.description, skill.libraryPath].join(" ").toLowerCase().includes(query);
        });
      }

      function renderStatusBadge(status) {
        return '<span class="badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
      }

      function rowActionButton(skill) {
        const rawState = targetRawState(skill);
        if (rawState === "missing") {
          return '<button class="button primary" type="button" data-row-action="enable" data-dangerous="true" data-skill="' + escapeHtml(skill.name) + '">Enable</button>';
        }
        if (rawState === "symlink") {
          return '<button class="button warning" type="button" data-row-action="disable" data-dangerous="true" data-skill="' + escapeHtml(skill.name) + '">Disable</button>';
        }
        return '<button class="button" type="button" data-row-action="open-duplicate" data-skill="' + escapeHtml(skill.name) + '">Resolve duplicate</button>';
      }

      function renderSkills() {
        const counts = countsForPlatform();
        nodes.total.textContent = counts.total;
        nodes.linked.textContent = counts.linked;
        nodes.missing.textContent = counts.missing;
        nodes.duplicate.textContent = counts.duplicate;
        nodes.selectedCount.textContent = state.selected.size;
        nodes.navSkillsCount.textContent = state.skills.length;
        nodes.navDuplicatesCount.textContent = state.duplicates.length;
        nodes.navBackupsCount.textContent = state.backups.length;
        nodes.bulkEnable.disabled = state.selected.size === 0;
        nodes.bulkDisable.disabled = state.selected.size === 0;
        nodes.libraryPath.textContent = state.config?.libraryRoot || "No library root";

        const rows = filteredSkills();
        nodes.skillsBody.innerHTML = rows.map((skill) => {
          const checked = state.selected.has(skill.name) ? " checked" : "";
          return '<tr>' +
            '<td class="selection-cell"><input class="skill-select" type="checkbox" data-skill="' + escapeHtml(skill.name) + '"' + checked + ' aria-label="Select ' + escapeHtml(skill.name) + '"></td>' +
            '<td class="name-cell">' + escapeHtml(skill.name) + '</td>' +
            '<td>' + renderStatusBadge(targetStatus(skill)) + '</td>' +
            '<td><div class="description">' + escapeHtml(skill.description || "No description") + '</div></td>' +
            '<td class="action-cell"><div class="row-actions"><button class="button" type="button" data-detail="' + escapeHtml(skill.name) + '">Detail</button>' + rowActionButton(skill) + '</div></td>' +
            '</tr>';
        }).join("");
        nodes.skillsEmpty.hidden = rows.length !== 0;
      }

      function preferredKeepLocation(duplicate) {
        return duplicate.locations.find((location) => location.rootRole === "library") || duplicate.locations[0];
      }

      function autoResolvableDuplicates() {
        return state.duplicates.filter((duplicate) => duplicate.locations.some((location) => location.rootRole === "library"));
      }

      function skippedAutoResolveDuplicates() {
        return state.duplicates
          .filter((duplicate) => !duplicate.locations.some((location) => location.rootRole === "library"))
          .map((duplicate) => ({ skill: duplicate.name, reason: "No central library copy found." }));
      }

      function renderDuplicates() {
        const resolvable = autoResolvableDuplicates();
        nodes.resolveAllDuplicates.disabled = resolvable.length === 0;
        nodes.duplicatesList.innerHTML = state.duplicates.map((duplicate) => {
          const preferred = preferredKeepLocation(duplicate);
          const options = duplicate.locations.map((location) => {
            const checked = location.path === preferred.path ? " checked" : "";
            const readonly = location.rootRole === "readonly" ? '<span class="badge readonly">readonly</span>' : "";
            return '<label class="path-option">' +
              '<input type="radio" name="keep-' + escapeHtml(duplicate.name) + '" value="' + escapeHtml(location.path) + '"' + checked + '>' +
              '<span><strong>' + escapeHtml(location.platform + " / " + location.rootId) + '</strong><br><code>' + escapeHtml(location.path) + '</code></span>' +
              '<span class="badge ' + (location.rootRole === "library" ? "linked" : "missing") + '">' + escapeHtml(location.rootRole) + '</span>' +
              readonly +
            '</label>';
          }).join("");

          return '<article class="record" data-duplicate="' + escapeHtml(duplicate.name) + '">' +
            '<div class="record-header"><h3 class="record-title">' + escapeHtml(duplicate.name) + '</h3><button class="button danger" type="button" data-resolve-duplicate="' + escapeHtml(duplicate.name) + '">Resolve duplicate</button></div>' +
            '<div class="record-body"><p class="muted">Choose one path to keep. Other entries will be backed up and removed.</p>' + options + '</div>' +
          '</article>';
        }).join("");
        nodes.duplicatesEmpty.hidden = state.duplicates.length !== 0;
      }

      function renderBackups() {
        nodes.backupsList.innerHTML = state.backups.map((backup) =>
          '<article class="backup-row">' +
            '<span class="badge duplicate">' + escapeHtml(backup.type) + '</span>' +
            '<span><strong>' + escapeHtml(backup.skill) + '</strong><br><code>' + escapeHtml(backup.id) + '</code><br><span class="muted">entries: ' + escapeHtml(backup.entryCount) + '</span></span>' +
            '<button class="button warning" type="button" data-restore-backup="' + escapeHtml(backup.id) + '" data-dangerous="true">Restore</button>' +
          '</article>',
        ).join("");
        nodes.backupsEmpty.hidden = state.backups.length !== 0;
      }

      function renderSettings() {
        if (!state.config) {
          nodes.settingsList.innerHTML = "";
          return;
        }
        const platformRows = Object.entries(state.config.platforms).flatMap(([platform, config]) =>
          config.roots.map((root) =>
            '<article class="root-row">' +
              '<span class="badge ' + (root.role === "readonly" ? "readonly" : "linked") + '">' + escapeHtml(root.role) + '</span>' +
              '<span><strong>' + escapeHtml(platform + " / " + root.id) + '</strong><br><code>' + escapeHtml(root.path) + '</code></span>' +
              '<span></span>' +
            '</article>',
          ),
        );
        nodes.settingsList.innerHTML =
          '<article class="root-row"><span class="badge linked">library</span><span><strong>agents / library</strong><br><code>' + escapeHtml(state.config.libraryRoot) + '</code></span><span></span></article>' +
          platformRows.join("");
      }

      function renderView() {
        for (const button of nodes.navButtons) {
          button.setAttribute("aria-current", button.dataset.view === state.activeView ? "page" : "false");
        }
        for (const panel of nodes.viewPanels) {
          panel.classList.toggle("active", panel.dataset.viewPanel === state.activeView);
        }
      }

      function render() {
        renderView();
        renderSkills();
        renderDuplicates();
        renderBackups();
        renderSettings();
      }

      function actionFromButton(button) {
        const type = button.dataset.action || button.dataset.rowAction;
        if (type === "enable" || type === "disable") {
          return { type, skill: button.dataset.skill, platform: state.platform };
        }
        if (type === "bulk-enable" || type === "bulk-disable") {
          return { type, skills: [...state.selected], platform: state.platform };
        }
        return { type };
      }

      function describeAction(action) {
        if (action.type === "resolve-all-duplicates") return "Resolve all " + action.resolvableCount + " duplicates";
        if (action.type === "resolve-duplicate") return "Resolve duplicate " + action.skill;
        if (action.type === "restore-backup") return "Restore backup " + action.backupId;
        if (action.skill) return action.type + " " + action.skill + " on " + action.platform;
        if (action.skills) return action.type + " " + action.skills.length + " selected skills on " + action.platform;
        return action.type;
      }

      function renderResolveAllConfirmDetail(action) {
        if (action.type !== "resolve-all-duplicates") return "";
        const resolvedItems = action.resolvableNames.map((name) => '<li>' + escapeHtml(name) + '</li>').join("");
        const skippedItems = action.skipped.map((item) => '<li>' + escapeHtml(item.skill + ": " + item.reason) + '</li>').join("");
        const extraCount = Math.max(0, action.resolvableNames.length - 10);
        return '<div class="result-box">' +
          '<p>Keep .agents copies, back up platform real directories, then replace them with links. Linked skills are left untouched.</p>' +
          '<strong>Will resolve</strong>' +
          '<ol class="summary-list collapsed" id="resolve-all-summary">' + resolvedItems + '</ol>' +
          (extraCount > 0 ? '<button class="button" type="button" id="show-all-resolve-items">Show all (' + escapeHtml(extraCount) + ' more)</button>' : '<button class="button" type="button" id="show-all-resolve-items" hidden>Show all</button>') +
          (action.skipped.length > 0 ? '<strong>Will skip</strong><ul class="summary-list">' + skippedItems + '</ul>' : "") +
        '</div>';
      }

      function queueAction(action, dangerous) {
        if (!action.type) return;
        if (action.skills && action.skills.length === 0) {
          nodes.operationStatus.textContent = "Select at least one skill.";
          return;
        }
        if (dangerous) {
          state.pendingAction = action;
          nodes.confirmMessage.textContent = "Run " + describeAction(action) + "? This will change skill files.";
          nodes.confirmDetail.innerHTML = renderResolveAllConfirmDetail(action);
          if (typeof nodes.confirmDialog.showModal === "function") {
            nodes.confirmDialog.showModal();
          } else {
            nodes.confirmDialog.setAttribute("open", "");
          }
          return;
        }
        nodes.confirmDetail.innerHTML = "";
        void runAction(action);
      }

      async function runAction(action) {
        nodes.operationStatus.textContent = "Running " + describeAction(action);
        try {
          const response = await fetch("/api/actions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(action),
          });
          const text = await response.text();
          let payload = {};
          try {
            payload = text ? JSON.parse(text) : {};
          } catch {
            payload = { message: text };
          }
          if (!response.ok) {
            throw new Error(payload.message || text || "Action failed.");
          }
          if (action.type === "resolve-all-duplicates") {
            nodes.duplicatesStatus.innerHTML = renderResolveAllResult(payload);
            state.activeView = "duplicates";
          }
          nodes.operationStatus.textContent = payload.message || "Done.";
          state.selected.clear();
          await fetchData();
        } catch (error) {
          nodes.operationStatus.textContent = error instanceof Error ? error.message : String(error);
        }
      }

      function renderResolveAllResult(payload) {
        const resolved = (payload.resolved || []).map((item) => '<li>' + escapeHtml(item.skill + " -> " + item.backupId) + '</li>').join("");
        const skipped = (payload.skipped || []).map((item) => '<li>' + escapeHtml(item.skill + ": " + item.reason) + '</li>').join("");
        const failed = (payload.failed || []).map((item) => '<li>' + escapeHtml(item.skill + ": " + item.error) + '</li>').join("");
        return '<div class="result-box">' +
          '<strong>Resolved</strong><ul class="summary-list">' + (resolved || "<li>None</li>") + '</ul>' +
          '<strong>Skipped</strong><ul class="summary-list">' + (skipped || "<li>None</li>") + '</ul>' +
          '<strong>Failed</strong><ul class="summary-list">' + (failed || "<li>None</li>") + '</ul>' +
        '</div>';
      }

      function showDetail(skill) {
        if (!skill) return;
        const otherStates = Object.entries(skill.platforms).map(([platform, value]) =>
          '<span class="badge ' + displayPlatformState(value) + '">' + escapeHtml(platform + ": " + displayPlatformState(value)) + '</span>',
        ).join(" ");
        nodes.detailTitle.textContent = skill.name;
        nodes.detailBody.innerHTML =
          '<p>' + escapeHtml(skill.description || "No description") + '</p>' +
          '<dl class="detail-grid">' +
            '<dt>Library path</dt><dd><code>' + escapeHtml(skill.libraryPath) + '</code></dd>' +
            '<dt>Target platform</dt><dd>' + escapeHtml(state.platform) + " " + renderStatusBadge(targetStatus(skill)) + '</dd>' +
            '<dt>Other platforms</dt><dd>' + otherStates + '</dd>' +
          '</dl>';
        nodes.detailDrawer.classList.add("open");
        nodes.detailDrawer.setAttribute("aria-hidden", "false");
      }

      function openDuplicate(name) {
        state.activeView = "duplicates";
        render();
        const record = document.querySelector('[data-duplicate="' + CSS.escape(name) + '"]');
        if (record) record.scrollIntoView({ block: "center" });
      }

      async function fetchData() {
        const response = await fetch("/api/skills");
        const payload = await response.json();
        state.skills = payload.skills;
        state.duplicates = payload.duplicates;
        state.backups = payload.backups;
        state.config = payload.config;
        state.selected = new Set([...state.selected].filter((name) => state.skills.some((skill) => skill.name === name)));
        render();
      }

      for (const button of nodes.navButtons) {
        button.addEventListener("click", () => {
          state.activeView = button.dataset.view;
          render();
        });
      }

      nodes.platform.addEventListener("change", (event) => {
        state.platform = event.target.value;
        state.selected.clear();
        render();
      });

      nodes.search.addEventListener("input", (event) => {
        state.query = event.target.value;
        renderSkills();
      });

      for (const button of nodes.filters) {
        button.addEventListener("click", () => {
          state.filter = button.dataset.filter;
          for (const other of nodes.filters) {
            other.setAttribute("aria-pressed", String(other === button));
          }
          renderSkills();
        });
      }

      nodes.bulkEnable.addEventListener("click", () => queueAction(actionFromButton(nodes.bulkEnable), true));
      nodes.bulkDisable.addEventListener("click", () => queueAction(actionFromButton(nodes.bulkDisable), true));
      nodes.resolveAllDuplicates.addEventListener("click", () => {
        const resolvable = autoResolvableDuplicates();
        queueAction({
          type: "resolve-all-duplicates",
          resolvableCount: resolvable.length,
          resolvableNames: resolvable.map((duplicate) => duplicate.name),
          skipped: skippedAutoResolveDuplicates(),
        }, true);
      });

      nodes.skillsBody.addEventListener("click", (event) => {
        const checkbox = event.target.closest(".skill-select");
        if (checkbox) {
          if (checkbox.checked) {
            state.selected.add(checkbox.dataset.skill);
          } else {
            state.selected.delete(checkbox.dataset.skill);
          }
          renderSkills();
          return;
        }
        const detail = event.target.closest("[data-detail]");
        if (detail) {
          showDetail(state.skills.find((skill) => skill.name === detail.dataset.detail));
          return;
        }
        const rowAction = event.target.closest("[data-row-action]");
        if (rowAction) {
          if (rowAction.dataset.rowAction === "open-duplicate") {
            openDuplicate(rowAction.dataset.skill);
            return;
          }
          queueAction(actionFromButton(rowAction), rowAction.dataset.dangerous === "true");
        }
      });

      nodes.duplicatesList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-resolve-duplicate]");
        if (!button) return;
        const skill = button.dataset.resolveDuplicate;
        const selected = document.querySelector('input[name="keep-' + CSS.escape(skill) + '"]:checked');
        queueAction({ type: "resolve-duplicate", skill, keepPath: selected?.value }, true);
      });

      nodes.backupsList.addEventListener("click", (event) => {
        const button = event.target.closest("[data-restore-backup]");
        if (!button) return;
        queueAction({ type: "restore-backup", backupId: button.dataset.restoreBackup }, true);
      });

      nodes.detailClose.addEventListener("click", () => {
        nodes.detailDrawer.classList.remove("open");
        nodes.detailDrawer.setAttribute("aria-hidden", "true");
      });

      nodes.confirmCancel.addEventListener("click", () => nodes.confirmDialog.close());
      nodes.confirmDetail.addEventListener("click", (event) => {
        const button = event.target.closest("#show-all-resolve-items");
        if (!button) return;
        document.querySelector("#resolve-all-summary")?.classList.remove("collapsed");
        button.hidden = true;
      });
      nodes.confirmRun.addEventListener("click", () => {
        const action = state.pendingAction;
        state.pendingAction = null;
        nodes.confirmDialog.close();
        if (action) void runAction(action);
      });

      fetchData().catch((error) => {
        nodes.operationStatus.textContent = error instanceof Error ? error.message : String(error);
      });
    </script>
  </body>
</html>`;
}
