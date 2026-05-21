import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { disableSkill, enableSkill, listBackups, restoreBackup } from "./operations.js";
import { findDuplicates, listSkills } from "./skills.js";

export type WebServerOptions = {
  home: string;
};

type WebActionRequest = {
  type: string;
  skill?: string;
  platform?: string;
  skills?: string[];
  backupId?: string;
};

export function createWebServer(options: WebServerOptions): Server {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/") {
        send(response, 200, "text/html; charset=utf-8", renderDashboardHtml());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/skills") {
        const [skills, duplicates, backups] = await Promise.all([
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

  if (action.type === "restore-latest") {
    return restoreBackup({ home }, action.backupId ?? "latest");
  }

  throw new Error(`Unknown action: ${action.type}`);
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

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>skillctl</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7f9;
        --surface: #ffffff;
        --surface-muted: #eef2f6;
        --line: #d7dde5;
        --text: #142033;
        --muted: #5d6b7c;
        --blue: #1d6fd8;
        --green: #138a55;
        --amber: #a46300;
        --red: #b3261e;
        --shadow: 0 18px 45px rgba(20, 32, 51, 0.08);
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
        font-size: 15px;
        line-height: 1.5;
      }

      button,
      input,
      select {
        font: inherit;
      }

      .app {
        min-height: 100dvh;
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
      }

      aside {
        position: sticky;
        top: 0;
        height: 100dvh;
        overflow: auto;
        padding: 24px;
        border-right: 1px solid var(--line);
        background: #fbfcfd;
      }

      main {
        min-width: 0;
        padding: 24px;
        display: grid;
        align-content: start;
        gap: 16px;
      }

      h1 {
        margin: 0;
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: 0;
      }

      h2 {
        margin: 0;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0;
        color: var(--muted);
      }

      .subtle {
        color: var(--muted);
      }

      .stack {
        display: grid;
        gap: 20px;
      }

      .sidebar-header {
        display: grid;
        gap: 6px;
      }

      .sidebar-section {
        display: grid;
        gap: 10px;
      }

      .sidebar-meta {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        color: var(--muted);
        font-size: 13px;
      }

      .action-list {
        display: grid;
        gap: 8px;
      }

      .action-button {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
        text-align: left;
        overflow-wrap: anywhere;
      }

      .action-button:hover,
      .action-button:focus-visible {
        border-color: var(--blue);
        background: #f4f8ff;
        outline: none;
      }

      .action-status {
        min-height: 20px;
        color: var(--muted);
        font-size: 13px;
      }

      .toolbar {
        display: grid;
        grid-template-columns: minmax(260px, 420px) auto;
        align-items: start;
        justify-content: space-between;
        gap: 16px;
      }

      .toolbar-controls {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
      }

      .search {
        width: 100%;
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 14px;
        background: var(--surface);
        color: var(--text);
      }

      .filter-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .platform-select {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        background: var(--surface);
        color: var(--text);
      }

      .filter {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
        text-align: left;
      }

      .filter:hover,
      .filter:focus-visible {
        border-color: var(--blue);
        outline: none;
      }

      .filter[aria-pressed="true"] {
        border-color: var(--blue);
        background: #e8f1ff;
        color: #0c4f9f;
      }

      .filter-count,
      .sidebar-count {
        font-variant-numeric: tabular-nums;
        font-weight: 700;
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
        max-height: calc(100dvh - 108px);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      th,
      td {
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #f9fafc;
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      tr:hover td {
        background: #f4f8ff;
      }

      .name-cell {
        font-weight: 650;
        overflow-wrap: anywhere;
      }

      .description {
        color: var(--muted);
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .action-cell {
        text-align: right;
      }

      .selection-cell {
        text-align: center;
      }

      .selection-cell input {
        width: 18px;
        height: 18px;
      }

      .row-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }

      .detail-button {
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        background: var(--surface);
        color: #0c4f9f;
        cursor: pointer;
        font-weight: 650;
      }

      .detail-button:hover,
      .detail-button:focus-visible,
      .row-action:hover,
      .row-action:focus-visible {
        border-color: var(--blue);
        background: #e8f1ff;
        outline: none;
      }

      .row-action {
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        background: var(--surface);
        color: #075a35;
        cursor: pointer;
        font-weight: 650;
      }

      .row-action.disable {
        color: #794600;
      }

      .row-action[disabled] {
        cursor: not-allowed;
        color: var(--muted);
        background: var(--surface-muted);
      }

      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        border-radius: 999px;
        padding: 0 9px;
        font-size: 12px;
        font-weight: 650;
        white-space: nowrap;
      }

      .badge.linked {
        color: #075a35;
        background: #dff5e9;
      }

      .badge.missing {
        color: #606a76;
        background: var(--surface-muted);
      }

      .badge.duplicate {
        color: #794600;
        background: #fff0d1;
      }

      .detail-dialog {
        width: min(760px, calc(100vw - 32px));
        max-height: min(720px, calc(100dvh - 32px));
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0;
        color: var(--text);
        background: var(--surface);
        box-shadow: var(--shadow);
      }

      .detail-dialog::backdrop {
        background: rgba(20, 32, 51, 0.36);
      }

      .dialog-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--line);
      }

      .dialog-title {
        margin: 0;
        font-size: 20px;
        letter-spacing: 0;
      }

      .dialog-body {
        display: grid;
        gap: 14px;
        padding: 20px;
      }

      .dialog-body p {
        margin: 0;
        color: var(--muted);
      }

      .close-button {
        min-height: 36px;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0 12px;
        background: var(--surface);
        color: var(--text);
        cursor: pointer;
      }

      .close-button:hover,
      .close-button:focus-visible {
        border-color: var(--blue);
        outline: none;
      }

      code {
        display: block;
        padding: 10px 12px;
        border-radius: 8px;
        background: #101828;
        color: #eef4ff;
        overflow-wrap: anywhere;
      }

      .empty {
        padding: 28px;
        color: var(--muted);
      }

      .output {
        margin: 0;
        min-height: 120px;
        white-space: pre-wrap;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-size: 12px;
      }

    </style>
  </head>
  <body>
    <div class="app">
      <aside>
        <div class="stack">
          <div class="sidebar-header">
            <h1>skillctl</h1>
            <div class="subtle" id="library-path">Loading</div>
          </div>
          <section class="sidebar-section" aria-labelledby="actions-heading">
            <h2 id="actions-heading">Actions</h2>
            <div class="sidebar-meta">
              <span>Selected <strong class="sidebar-count" id="selected-count">0</strong></span>
              <span>Backups <strong class="sidebar-count" id="backup-count">0</strong></span>
            </div>
            <div class="action-list">
              <button class="action-button" id="bulk-enable" type="button" data-action="bulk-enable" data-dangerous="true">Enable selected</button>
              <button class="action-button" id="bulk-disable" type="button" data-action="bulk-disable" data-dangerous="true">Disable selected</button>
              <button class="action-button" type="button" data-action="find-duplicates">Find duplicates</button>
              <button class="action-button" type="button" data-action="show-backups">Show backups</button>
              <button class="action-button" type="button" data-action="restore-latest" data-dangerous="true">Restore latest backup</button>
            </div>
            <div class="action-status" id="action-status" aria-live="polite"></div>
          </section>
        </div>
      </aside>
      <main>
        <div class="toolbar">
          <input class="search" id="search" type="search" aria-label="Search skills" placeholder="Search skills">
          <div class="toolbar-controls">
            <select class="platform-select" id="platform-select" aria-label="Target platform">
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="cursor">cursor</option>
            </select>
            <div class="filter-list" aria-label="Filters">
              <button class="filter" type="button" data-filter="all" aria-pressed="true">
                <span>All</span>
                <strong class="filter-count" id="total-count">0</strong>
              </button>
              <button class="filter" type="button" data-filter="enabled" aria-pressed="false">
                <span>Enabled</span>
                <strong class="filter-count" id="enabled-count">0</strong>
              </button>
              <button class="filter" type="button" data-filter="missing" aria-pressed="false">
                <span>Missing</span>
                <strong class="filter-count" id="missing-count">0</strong>
              </button>
              <button class="filter" type="button" data-filter="duplicate" aria-pressed="false">
                <span>Duplicates</span>
                <strong class="filter-count" id="duplicate-count">0</strong>
              </button>
            </div>
          </div>
        </div>
        <section class="panel">
          <div class="table-wrap">
            <table id="skills-table">
              <colgroup>
                <col style="width: 48px">
                <col style="width: 20%">
                <col style="width: 22%">
                <col style="width: 12%">
                <col>
                <col style="width: 190px">
              </colgroup>
              <thead>
                <tr>
                  <th>Select</th>
                  <th>Name</th>
                  <th>Platforms</th>
                  <th>Flags</th>
                  <th>Description</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="skills-body"></tbody>
            </table>
          </div>
          <div id="empty" class="empty" hidden>No matching skills.</div>
        </section>
        <section class="panel">
          <pre id="operation-output" class="empty output">Operation output will appear here.</pre>
        </section>
      </main>
    </div>
    <dialog class="detail-dialog" id="detail-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title" id="detail-title">Skill detail</h2>
        <button class="close-button" type="button" id="detail-close">Close</button>
      </div>
      <div class="dialog-body" id="detail-body"></div>
    </dialog>
    <dialog class="detail-dialog" id="confirm-dialog">
      <div class="dialog-header">
        <h2 class="dialog-title">Confirm command</h2>
        <button class="close-button" type="button" id="confirm-cancel">Cancel</button>
      </div>
      <div class="dialog-body">
        <p id="confirm-message">This command changes skill files.</p>
        <button class="detail-button" type="button" id="confirm-run">Run command</button>
      </div>
    </dialog>
    <script>
      const state = {
        skills: [],
        summary: { total: 0, enabled: 0, duplicates: 0, backups: 0 },
        filter: "all",
        platform: "codex",
        query: "",
        selected: new Set(),
        pendingAction: null,
      };

      const nodes = {
        body: document.querySelector("#skills-body"),
        empty: document.querySelector("#empty"),
        dialog: document.querySelector("#detail-dialog"),
        dialogTitle: document.querySelector("#detail-title"),
        dialogBody: document.querySelector("#detail-body"),
        dialogClose: document.querySelector("#detail-close"),
        confirmDialog: document.querySelector("#confirm-dialog"),
        confirmMessage: document.querySelector("#confirm-message"),
        confirmRun: document.querySelector("#confirm-run"),
        confirmCancel: document.querySelector("#confirm-cancel"),
        search: document.querySelector("#search"),
        platform: document.querySelector("#platform-select"),
        filters: [...document.querySelectorAll(".filter")],
        actionButtons: [...document.querySelectorAll("[data-action]")],
        actionStatus: document.querySelector("#action-status"),
        output: document.querySelector("#operation-output"),
        total: document.querySelector("#total-count"),
        enabled: document.querySelector("#enabled-count"),
        missing: document.querySelector("#missing-count"),
        duplicates: document.querySelector("#duplicate-count"),
        backups: document.querySelector("#backup-count"),
        selectedCount: document.querySelector("#selected-count"),
        libraryPath: document.querySelector("#library-path"),
      };

      function platformBadges(skill) {
        return Object.entries(skill.platforms)
          .map(([platform, value]) => '<span class="badge ' + platformStateClass(value) + '">' + escapeHtml(platform + ': ' + displayPlatformState(value)) + '</span>')
          .join("");
      }

      function displayPlatformState(value) {
        if (value === "symlink") return "linked";
        if (value === "present") return "duplicate";
        return "missing";
      }

      function platformStateClass(value) {
        if (value === "symlink") return "linked";
        if (value === "present") return "duplicate";
        return "missing";
      }

      function isEnabled(skill) {
        return Object.values(skill.platforms).some((value) => value === "present" || value === "symlink");
      }

      function targetPlatformState(skill) {
        return skill.platforms[state.platform] || "missing";
      }

      function rowActionButton(skill) {
        const platformState = targetPlatformState(skill);
        if (platformState === "missing") {
          return '<button class="row-action" type="button" data-row-action="enable" data-dangerous="true" data-skill="' + escapeHtml(skill.name) + '">Enable</button>';
        }

        if (platformState === "symlink") {
          return '<button class="row-action disable" type="button" data-row-action="disable" data-dangerous="true" data-skill="' + escapeHtml(skill.name) + '">Disable</button>';
        }

        return '<button class="row-action" type="button" disabled>Duplicate</button>';
      }

      function filteredSkills() {
        const query = state.query.trim().toLowerCase();
        return state.skills.filter((skill) => {
          if (state.filter === "enabled" && !isEnabled(skill)) return false;
          if (state.filter === "missing" && isEnabled(skill)) return false;
          if (state.filter === "duplicate" && !skill.duplicate) return false;
          if (!query) return true;
          return [skill.name, skill.description, skill.libraryPath].join(" ").toLowerCase().includes(query);
        });
      }

      function render() {
        const missingCount = state.summary.total - state.summary.enabled;
        nodes.total.textContent = state.summary.total;
        nodes.enabled.textContent = state.summary.enabled;
        nodes.missing.textContent = missingCount;
        nodes.duplicates.textContent = state.summary.duplicates;
        nodes.backups.textContent = state.summary.backups;
        nodes.selectedCount.textContent = state.selected.size;
        nodes.libraryPath.textContent = state.skills[0]?.libraryPath?.replace(/\\/[^\\/]+$/, "") || "No library skills";

        const rows = filteredSkills();
        nodes.body.innerHTML = rows
          .map((skill) => {
            const flags = skill.duplicate ? '<span class="badge duplicate">duplicate</span>' : "";
            const checked = state.selected.has(skill.name) ? " checked" : "";
            return '<tr>' +
              '<td class="selection-cell" data-label="Select"><input class="skill-select" type="checkbox" data-skill="' + escapeHtml(skill.name) + '"' + checked + ' aria-label="Select ' + escapeHtml(skill.name) + '"></td>' +
              '<td class="name-cell" data-label="Name">' + escapeHtml(skill.name) + '</td>' +
              '<td data-label="Platforms"><div class="badges">' + platformBadges(skill) + '</div></td>' +
              '<td data-label="Flags"><div class="badges">' + flags + '</div></td>' +
              '<td data-label="Description"><div class="description">' + escapeHtml(skill.description || "No description") + '</div></td>' +
              '<td class="action-cell" data-label="Action"><div class="row-actions"><button class="detail-button" type="button" data-name="' + escapeHtml(skill.name) + '" aria-label="View details for ' + escapeHtml(skill.name) + '">Detail</button>' + rowActionButton(skill) + '</div></td>' +
              '</tr>';
          })
          .join("");
        nodes.empty.hidden = rows.length !== 0;
      }

      function showDetail(skill) {
        if (!skill) {
          return;
        }

        nodes.dialogTitle.textContent = skill.name;
        nodes.dialogBody.innerHTML =
          "<p>" + escapeHtml(skill.description || "No description") + "</p>" +
          "<code>" + escapeHtml(skill.libraryPath) + "</code>" +
          '<div class="badges">' + platformBadges(skill) + (skill.duplicate ? '<span class="badge duplicate">duplicate</span>' : "") + "</div>";

        if (typeof nodes.dialog.showModal === "function") {
          nodes.dialog.showModal();
        } else {
          nodes.dialog.setAttribute("open", "");
        }
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (char) => ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]);
      }

      function actionFromButton(button) {
        const type = button.dataset.action || button.dataset.rowAction;
        const skill = button.dataset.skill;
        if (type === "enable" || type === "disable") {
          return { type, skill, platform: state.platform };
        }

        if (type === "bulk-enable" || type === "bulk-disable") {
          return { type, skills: [...state.selected], platform: state.platform };
        }

        return { type };
      }

      function describeAction(action) {
        if (action.skill) {
          return action.type + " " + action.skill + " on " + state.platform;
        }

        if (action.skills) {
          return action.type + " " + action.skills.length + " selected skills on " + state.platform;
        }

        return action.type;
      }

      function queueAction(action, dangerous) {
        if (!action.type) {
          return;
        }

        if (action.skills && action.skills.length === 0) {
          nodes.output.textContent = "Select at least one skill.";
          return;
        }

        if (dangerous) {
          state.pendingAction = action;
          nodes.confirmMessage.textContent = "Run " + describeAction(action) + "? This will change skill files.";
          if (typeof nodes.confirmDialog.showModal === "function") {
            nodes.confirmDialog.showModal();
          } else {
            nodes.confirmDialog.setAttribute("open", "");
          }
          return;
        }

        void runAction(action);
      }

      async function runAction(action) {
        if (action.type === "refresh") {
          await fetchData();
          return;
        }

        nodes.actionStatus.textContent = "Running " + describeAction(action);
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

          nodes.output.textContent = payload.message || "Done.";
          nodes.actionStatus.textContent = "Done";
          await fetchData();
        } catch (error) {
          nodes.output.textContent = error instanceof Error ? error.message : String(error);
          nodes.actionStatus.textContent = "Failed";
        }
      }

      async function fetchData() {
        const response = await fetch("/api/skills");
        const payload = await response.json();
        state.skills = payload.skills;
        state.summary = payload.summary;
        state.selected = new Set([...state.selected].filter((name) => state.skills.some((skill) => skill.name === name)));
        render();
      }

      nodes.search.addEventListener("input", (event) => {
        state.query = event.target.value;
        render();
      });

      nodes.platform.addEventListener("change", (event) => {
        state.platform = event.target.value;
        render();
      });

      for (const button of nodes.filters) {
        button.addEventListener("click", () => {
          state.filter = button.dataset.filter;
          for (const other of nodes.filters) {
            other.setAttribute("aria-pressed", String(other === button));
          }
          render();
        });
      }

      for (const button of nodes.actionButtons) {
        button.addEventListener("click", () => {
          queueAction(actionFromButton(button), button.dataset.dangerous === "true");
        });
      }

      nodes.body.addEventListener("click", (event) => {
        const checkbox = event.target.closest(".skill-select");
        if (checkbox) {
          if (checkbox.checked) {
            state.selected.add(checkbox.dataset.skill);
          } else {
            state.selected.delete(checkbox.dataset.skill);
          }
          render();
          return;
        }

        const rowAction = event.target.closest("[data-row-action]");
        if (rowAction) {
          queueAction(actionFromButton(rowAction), rowAction.dataset.dangerous === "true");
          return;
        }

        const button = event.target.closest(".detail-button");
        if (button) {
          showDetail(state.skills.find((skill) => skill.name === button.dataset.name));
        }
      });

      nodes.dialogClose.addEventListener("click", () => nodes.dialog.close());
      nodes.dialog.addEventListener("click", (event) => {
        if (event.target === nodes.dialog) {
          nodes.dialog.close();
        }
      });

      nodes.confirmCancel.addEventListener("click", () => nodes.confirmDialog.close());
      nodes.confirmRun.addEventListener("click", () => {
        const action = state.pendingAction;
        state.pendingAction = null;
        nodes.confirmDialog.close();
        if (action) {
          void runAction(action);
        }
      });

      fetchData()
        .catch((error) => {
          nodes.empty.hidden = false;
          nodes.empty.textContent = error.message;
        });
    </script>
  </body>
</html>`;
}
