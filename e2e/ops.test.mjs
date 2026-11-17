import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, dir;
before(async () => ((dir = demo()), (k = await launch(`${dir}/tidepool`))));
after(() => k?.quit());

// git as someone else, beside the app: a colleague's clone of the same remote
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Eve", GIT_AUTHOR_EMAIL: "eve@example.com", GIT_COMMITTER_NAME: "Eve", GIT_COMMITTER_EMAIL: "eve@example.com" } }).toString();
const toast = (text) => k.until((text) => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes(text)), text);
const enter = () => k.keys("");

test("the find bar marks matching commits and steps through them", async () => {
  await k.click("#find-open");
  await k.type("#find-q", "moon");
  await k.until(() => /^1\/[2-9]/.test(document.getElementById("find-n").textContent));
  await enter();
  await k.until(() => document.getElementById("find-n").textContent.startsWith("2/"));
  await k.keys("");
  await k.until(() => document.getElementById("find").hidden);
});

test("a tag made on a commit is pushed to the remote, then deleted here", async () => {
  await k.menu("#graph .row", "chore: move to the 2024 edition");
  await k.click("#menu button", "Create tag here");
  await k.type("#menu input.ask", "v0.2.1");
  await enter();
  // its label is under main's on that row: the sidebar has it in sight
  await k.click('#sidebar details[data-key="tags"] > summary');
  const tag = '#sidebar [data-key="tags"] .item';
  await k.until((tag) => [...document.querySelectorAll(tag)].some((r) => r.textContent.includes("v0.2.1")), tag);
  await k.menu(tag, "v0.2.1");
  await k.click("#menu button", "Push to origin");
  await toast("Pushed tag v0.2.1 to origin");
  assert.match(git(dir, "ls-remote", "--tags", "origin.git"), /refs\/tags\/v0\.2\.1/);
  await k.menu(tag, "v0.2.1");
  await k.click("#menu button", "Delete local");
  await k.until((tag) => ![...document.querySelectorAll(tag)].some((r) => r.textContent.includes("v0.2.1")), tag);
});

test("a stash applies from the sidebar, then is dropped", async () => {
  await k.click('#sidebar details[data-key="stashes"] > summary');
  await k.menu('#sidebar [data-key="stashes"] .item', "station search");
  await k.click("#menu button", "Apply");
  await k.until(() => document.querySelector('#unstaged .file[data-path="src/search.rs"]'));
  await k.menu('#sidebar [data-key="stashes"] .item', "station search");
  await k.click("#menu button", "Drop");
  await k.click("#dialog button.primary");
  await k.until(() => document.querySelector('#sidebar [data-key="stashes"] .n').textContent === "0");
});

test("Discard hunk takes one change out of the working tree", async () => {
  await k.click('#unstaged .file[data-path="src/tide.rs"]');
  await k.until(() => document.querySelectorAll("#diff-editor .hunk-discard").length === 2);
  await k.click("#diff-editor .hunk-discard");
  const ask = await k.js(() => !document.getElementById("dialog").hidden);
  if (ask) await k.click("#dialog button.primary");
  await k.until(() => document.querySelectorAll("#diff-editor .hunk-discard").length === 1);
  await k.keys("");
});

test("Revert hunk on a commit puts the change back, unstaged", async () => {
  await k.click("#graph .row", "docs: chart Dover beside Brest");
  await k.click("#graph .row", "fix(tide): round heights to the centimetre");
  await k.click('#commit-files .file[data-path="src/tide.rs"]');
  await k.click("#diff-editor .hunk-revert");
  await toast("Reverted a hunk of tide.rs");
  assert.match(git(join(dir, "tidepool"), "diff", "--", "src/tide.rs"), /-.*\.round\(\)/);
  await k.keys("");
});

test("Undo takes a commit back to staged changes, Redo makes it again", async () => {
  await k.click("#graph .row", "// WIP");
  await k.click("#stage-all");
  await k.until(() => !document.querySelector("#unstaged .file"));
  await k.type("#summary", "feat: search stations");
  await k.click("#commit-btn");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("feat: search stations"));
  await k.click("#undo");
  await k.until(() => !document.querySelector("#graph .row.row-head")?.textContent.includes("feat: search stations") && document.querySelector("#staged .file"));
  await k.click("#redo");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("feat: search stations"));
});

test("Push sends main's commits; a colleague's commit comes back with Fetch and Pull", async () => {
  await k.click('[data-op="push"]');
  await k.until(() => !document.getElementById("ahead").textContent);
  const other = join(dir, "eve");
  git(dir, "clone", "-q", "origin.git", other);
  git(other, "commit", "-q", "--allow-empty", "-m", "chore: Eve was here");
  git(other, "push", "-q", "origin", "main");
  await k.click('[data-op="fetch"]');
  await k.until(() => document.getElementById("behind").textContent === "1");
  await k.click("#pull");
  await k.until(() => !document.getElementById("behind").textContent && document.querySelector("#graph .row.row-head")?.textContent.includes("chore: Eve was here"));
});
