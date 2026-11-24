import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, dir;
before(async () => {
  dir = demo();
  // its submodule as a fresh clone has it: not checked out yet
  execFileSync("git", ["submodule", "deinit", "-q", "vendor/tidecalc"], { cwd: join(dir, "tidepool") });
  k = await launch(`${dir}/tidepool`);
});
after(() => k?.quit());

const section = (key) => k.click(`#sidebar details[data-key="${key}"] > summary`);
const count = (key) => k.js((key) => document.querySelector(`#sidebar [data-key="${key}"] .n`).textContent, key);

test("a picture stored with LFS shows its badge, and both versions side by side", async () => {
  await k.click("#graph .row", "docs: chart Dover beside Brest");
  await k.until(() => document.querySelector('#commit-files .file[data-path="docs/chart.png"] .lfs'));
  await k.click('#commit-files .file[data-path="docs/chart.png"]');
  // the File view first, its version alone; the Diff view adds the old one
  await k.until(() => [...document.querySelectorAll("#diff-binary img")].filter((i) => i.complete && i.naturalWidth).length === 1);
  await k.click('[data-dview="diff"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary img")].filter((i) => i.complete && i.naturalWidth).length === 2 && document.querySelector('[data-mode="split"]').classList.contains("on"));
  await k.keys("\uE00C");
});

test("a submodule not checked out yet is initialized, then opened and left", async () => {
  await section("submodules");
  await k.until(() => document.querySelector('#sidebar [data-key="submodules"] .sub-state.out'));
  await k.menu('#sidebar [data-key="submodules"] .item', "tidecalc");
  await k.click("#menu button", "Initialize");
  await k.until(() => document.querySelector('#sidebar [data-key="submodules"] .sub-state.ok'));
  await k.menu('#sidebar [data-key="submodules"] .item', "tidecalc");
  await k.click("#menu button", "Open");
  await k.until(() => document.getElementById("repo-name").textContent.includes("tidecalc"));
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("repo-name").textContent.includes("tidepool"));
});

test("a worktree made from a commit opens on its new branch, then is removed", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Create worktree from this commit");
  await k.type("#dialog input", "spike");
  await k.click("#dialog button.primary");
  await k.until(() => document.getElementById("branch").textContent === "spike");
  const path = join(dir, "tidepool-spike");
  assert.ok(existsSync(path));
  // back to the main checkout through its row, the new worktree listed
  await section("worktrees");
  await k.menu('#sidebar [data-key="worktrees"] .item', "main");
  await k.click("#menu button", "Open worktree");
  await k.until(() => document.getElementById("branch").textContent === "main");
  await k.until(() => document.querySelector('#sidebar [data-key="worktrees"] .n')?.textContent === "3");
  await k.menu('#sidebar [data-key="worktrees"] .item', "spike");
  await k.click("#menu button", "Remove worktree");
  await k.click("#dialog button.primary");
  await k.until(() => document.querySelector('#sidebar [data-key="worktrees"] .n').textContent === "2");
  assert.ok(!existsSync(path));
  assert.equal(await count("worktrees"), "2");
});

test("a remote branch double-clicked in a worktree opens the worktree its local branch is in, behind or not", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", ...args], { cwd: join(dir, "tidepool") }).toString().trim();
  // main a commit behind origin's, pushed there: the fetch on opening keeps it
  const was = git("rev-parse", "origin/main");
  git("push", "-q", "origin", `${git("commit-tree", "--no-gpg-sign", "main^{tree}", "-p", "main", "-m", "ahead")}:refs/heads/main`);
  git("fetch", "-q", "origin");
  await k.menu('#sidebar [data-key="worktrees"] .item', "feature/moon-phase");
  await k.click("#menu button", "Open worktree");
  await k.until(() => document.getElementById("repo-name").textContent.includes("moon"));
  await k.settle();
  await k.js(() => [...document.querySelectorAll("#graph .row")].find((r) => r.textContent.includes("ahead")).querySelector(".ref").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await k.until(() => !document.getElementById("repo-name").textContent.includes("moon") && document.getElementById("branch").textContent === "main");
  assert.match(git("worktree", "list", "--porcelain"), /tidepool-moon\nHEAD \w+\nbranch refs\/heads\/feature\/moon-phase/);
  git("push", "-qf", "origin", `${was}:refs/heads/main`);
  git("fetch", "-q", "origin");
});

test("a worktree whose folder goes away under its tab steps back to its repository", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Create worktree from this commit");
  await k.type("#dialog input", "gone");
  await k.click("#dialog button.primary");
  await k.until(() => document.getElementById("branch").textContent === "gone");
  const gone = join(dir, "tidepool-gone");
  rmSync(gone, { recursive: true, force: true });
  // as a refresh caught halfway through the removal says it
  await k.js((gone) => document.getElementById("toasts").insertAdjacentHTML("beforeend", `<div class="toast err"><b>Error</b><pre>${gone} no longer exists</pre></div>`), gone);
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until(() => document.getElementById("branch").textContent === "main" && document.querySelector("#tabs .tab.on .tab-name")?.textContent === "tidepool");
  // one notice: the step back's
  assert.deepEqual(await k.js(() => [...document.querySelectorAll("#toasts .toast.err, #toasts .toast:last-child")].map((t) => t.querySelector("b").textContent)), ["Back to tidepool"]);
  // out of the sidebar's list, not pruned: a folder on an unplugged drive comes back; git's gc prunes it in time
  await k.until(() => document.querySelector('#sidebar [data-key="worktrees"] .n')?.textContent === "2");
  assert.match(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: join(dir, "tidepool") }).toString(), /tidepool-gone\n(.+\n)*prunable/);
});

const worktrees = () => execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: join(dir, "tidepool") }).toString();

test("a branch another worktree has swaps with this one's, and back", async () => {
  await k.menu("#graph .ref", "feature/moon-phase");
  await k.click("#menu button", "Swap with worktree tidepool-moon");
  await k.until(() => document.getElementById("branch").textContent === "feature/moon-phase");
  assert.match(worktrees(), /tidepool-moon\nHEAD \w+\nbranch refs\/heads\/main\n/);
  await k.menu("#graph .ref", "main");
  await k.click("#menu button", "Swap with worktree tidepool-moon");
  await k.until(() => document.getElementById("branch").textContent === "main");
  assert.match(worktrees(), /tidepool-moon\nHEAD \w+\nbranch refs\/heads\/feature\/moon-phase\n/);
  // the next tests count the toasts naming tidepool-moon
  await k.js(() => document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()));
});

test("a swap the other worktree's changes block leaves both as they were", async () => {
  // src/main.rs differs between main and feature/moon-phase: git refuses to switch over its change
  const file = join(dir, "tidepool-moon", "src/main.rs"), was = readFileSync(file, "utf8");
  appendFileSync(file, "// wip\n");
  await k.menu("#graph .ref", "feature/moon-phase");
  await k.click("#menu button", "Swap with worktree tidepool-moon");
  await k.until(() => document.querySelector("#toasts .toast.err"));
  await k.until(() => document.getElementById("branch").textContent === "main");
  assert.match(worktrees(), /tidepool-moon\nHEAD \w+\nbranch refs\/heads\/feature\/moon-phase\n/);
  assert.equal(readFileSync(file, "utf8"), `${was}// wip\n`);
  execFileSync("git", ["checkout", "--", "src/main.rs"], { cwd: join(dir, "tidepool-moon") });
  await k.js(() => document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()));
});

test("a branch another worktree has deletes with that worktree, in one question", async () => {
  await k.menu("#graph .ref", "feature/moon-phase");
  await k.click("#menu button", "Delete local");
  await k.until(() => document.querySelector("#dialog .dlg-note")?.textContent.startsWith("feature/moon-phase is checked out there"));
  await k.click("#dialog button.primary");
  await k.until(() => document.querySelector('#sidebar [data-key="worktrees"] .n')?.textContent === "1");
  // one toast for the one action
  const toasts = () => k.js(() => [...document.querySelectorAll("#toasts .toast b")].map((b) => b.textContent).filter((t) => t.includes("tidepool-moon")));
  await k.until(() => [...document.querySelectorAll("#toasts .toast b")].some((b) => b.textContent.includes("deleted branch feature/moon-phase")));
  assert.deepEqual(await toasts(), ["Removed worktree tidepool-moon and deleted branch feature/moon-phase"]);
  assert.ok(!existsSync(join(dir, "tidepool-moon")));
  assert.equal(execFileSync("git", ["branch", "--list", "feature/moon-phase"], { cwd: join(dir, "tidepool") }).toString(), "");
});

test("a branch a gone worktree holds deletes after a prune, in one question", async () => {
  // tidepool-gone's folder went in an earlier test: its branch stays held
  await k.menu('#sidebar [data-key="local"] .item', "gone");
  await k.click("#menu button", "Delete local");
  await k.until(() => document.querySelector("#dialog .dlg-note")?.textContent.includes("tidepool-gone, whose folder is gone, is pruned first"));
  await k.click("#dialog button.primary");
  await k.until(() => ![...document.querySelectorAll('#sidebar [data-key="local"] .item')].some((r) => r.textContent.includes("gone")));
  const top = join(dir, "tidepool");
  assert.equal(execFileSync("git", ["branch", "--list", "gone"], { cwd: top }).toString(), "");
  assert.doesNotMatch(execFileSync("git", ["worktree", "list"], { cwd: top }).toString(), /tidepool-gone/);
});

test("branches deleted on their remote and merged are offered for deletion in one toast, once", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", ...args], { cwd: join(dir, "tidepool") }).toString().trim();
  // merged by ancestry; squash merged, as its pull request says; merged nowhere
  git("branch", "done", "main~1");
  const squashed = git("commit-tree", "--no-gpg-sign", "main^{tree}", "-p", "main", "-m", "squashed");
  git("branch", "squashed", squashed);
  git("branch", "abandoned", git("commit-tree", "--no-gpg-sign", "main^{tree}", "-p", "main", "-m", "abandoned"));
  writeFileSync(join(dir, "gh", "prs-merged.json"), JSON.stringify([{ headRefOid: squashed }]));
  git("push", "-q", "-u", "origin", "done", "squashed", "abandoned");
  git("push", "-q", "origin", "--delete", "done", "squashed", "abandoned");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until(() => [...document.querySelectorAll("#toasts .toast b")].some((b) => b.textContent === "2 branches were deleted on origin"));
  assert.match(await k.js(() => document.querySelector("#toasts .toast:last-child pre").textContent), /\ndone\nsquashed$/);
  await k.click("#toasts .toast .t-actions button", "Delete");
  await k.until(() => [...document.querySelectorAll("#toasts .toast b")].some((b) => b.textContent === "Deleted the branches done, squashed"));
  assert.equal(git("branch", "--list", "done", "squashed", "abandoned"), "abandoned");
  // asked once: a refresh offers nothing more
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.settle();
  assert.equal(await k.js(() => [...document.querySelectorAll("#toasts .toast")].filter((t) => t.textContent.includes("deleted on origin")).length), 0);
  git("branch", "-D", "abandoned");
});
