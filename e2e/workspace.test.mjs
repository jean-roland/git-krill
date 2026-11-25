import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launch } from "./driver.mjs";

let k, top, board;
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd }).toString().trim();

// a repo tool checkout: each project's .git a link to .repo/projects/<path>.git, its folder listed in .repo/project.list
before(async () => {
  top = mkdtempSync(join(tmpdir(), "krill-workspace-"));
  for (const path of ["packages/app", "packages/radio", "products/board", "packages/stack"]) {
    const dir = join(top, path), gitDir = join(top, ".repo", "projects", `${path}.git`);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "first");
    mkdirSync(join(gitDir, ".."), { recursive: true });
    renameSync(join(dir, ".git"), gitDir);
    symlinkSync(gitDir, join(dir, ".git"));
    appendFileSync(join(top, ".repo", "project.list"), `${path}\n`);
  }
  writeFileSync(join(top, "packages/app/notes.txt"), "wip\n");
  git(join(top, "packages/radio"), "checkout", "-q", "-b", "pr-radio-tuning");
  git(join(top, "packages/radio"), "worktree", "add", "-q", join(top, "wt", "radio-main"), "main");
  git(join(top, "products/board"), "checkout", "-q", "--detach");
  board = git(join(top, "products/board"), "rev-parse", "HEAD").slice(0, 7);
  // stack follows a remote, where others push
  git(top, "init", "-q", "--bare", "-b", "main", "stack.git");
  git(join(top, "packages/stack"), "remote", "add", "origin", join(top, "stack.git"));
  git(join(top, "packages/stack"), "push", "-q", "-u", "origin", "main");
  k = await launch(join(top, "packages/app"));
});
after(() => k?.quit());

const rows = '#sidebar [data-key="workspace"] .item';

test("a repo tool checkout lists its projects under Workspace, each with its branch and state", async () => {
  await k.until((rows) => document.querySelectorAll(rows).length === 4, rows);
  const seen = await k.js((rows) => [...document.querySelectorAll(rows)].map((r) => [r.querySelector(".label").textContent, r.querySelector("small").textContent, r.querySelector(".sub-state").classList.contains("ok"), r.classList.contains("current")]), rows);
  assert.deepEqual(seen, [
    ["app", "main", false, true],
    ["radio", "pr-radio-tuning", true, false],
    ["board", `detached at ${board}`, true, false],
    ["stack", "main", true, false],
  ]);
  // radio's other folder, named with its branch
  const linked = await k.js((rows) => [...document.querySelectorAll(rows)][1].querySelector(".ico[title^='Linked']").title, rows);
  assert.equal(linked, `Linked worktrees:\n${join(top, "wt", "radio-main")}: main`);
});

test("a project double-clicked in Workspace opens in a tab", async () => {
  await k.js((rows) => [...document.querySelectorAll(rows)][1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), rows);
  await k.until(() => document.getElementById("repo-name").textContent.includes("radio"));
});

test("Fetch in a project's menu brings in what others pushed", async () => {
  const other = join(top, "other");
  git(top, "clone", "-q", "stack.git", other);
  git(other, "commit", "-q", "--allow-empty", "-m", "feat: from elsewhere");
  git(other, "push", "-q", "origin", "main");
  await k.menu(rows, "stack");
  await k.click("#menu button", "Fetch");
  await k.until((rows) => [...document.querySelectorAll(rows)].find((r) => r.textContent.includes("stack"))?.querySelector("small").textContent === "main ↓1", rows);
});

test("Fetch every project, on the Workspace header, fetches them all", async () => {
  git(join(top, "other"), "commit", "-q", "--allow-empty", "-m", "feat: from elsewhere again");
  git(join(top, "other"), "push", "-q", "origin", "main");
  await k.js(() => document.querySelector('#sidebar [data-key="workspace"] summary .add').click());
  await k.until((rows) => [...document.querySelectorAll(rows)].find((r) => r.textContent.includes("stack"))?.querySelector("small").textContent === "main ↓2", rows);
});

test("a removed worktree leaves its project's row at once, though the last ask was just now", async () => {
  git(join(top, "packages/radio"), "worktree", "remove", join(top, "wt", "radio-main"));
  // within 5 s of the fetch's ask: the read comes at the 5 s mark
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until((rows) => ![...document.querySelectorAll(rows)][1].querySelector(".ico[title^='Linked']"), rows);
});

test("a project the manifest lists but that is not on disk says so", async () => {
  appendFileSync(join(top, ".repo", "project.list"), "packages/missing\n");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until((rows) => document.querySelectorAll(rows).length === 5, rows);
  const row = await k.js((rows) => {
    const r = [...document.querySelectorAll(rows)].find((r) => r.querySelector(".label").textContent === "missing");
    return [r.classList.contains("off"), r.querySelector("small").textContent, r.title.split("\n")[1].startsWith("Not readable: ")];
  }, rows);
  assert.deepEqual(row, [true, "not readable", true]);
});

test("the manifest's checkout heads Workspace and opens in a tab of the same workspace", async () => {
  // its git dir beside it, as the repo tool keeps it
  const dir = join(top, ".repo", "manifests");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  renameSync(join(dir, ".git"), `${dir}.git`);
  symlinkSync(`${dir}.git`, join(dir, ".git"));
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until((rows) => document.querySelector(rows)?.querySelector(".label").textContent === "manifest", rows);
  await k.js((rows) => document.querySelector(rows).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), rows);
  // the row it was opened from is this tab's: its folder, not its git dir
  await k.until((rows) => document.getElementById("repo-name").textContent.includes("manifests") && document.querySelector(rows)?.classList.contains("current"), rows);
});
