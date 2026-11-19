import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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
  await k.until(() => [...document.querySelectorAll("#diff-binary img")].filter((i) => i.complete && i.naturalWidth).length === 2);
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

test("a worktree whose folder goes away under its tab steps back to its repository", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Create worktree from this commit");
  await k.type("#dialog input", "gone");
  await k.click("#dialog button.primary");
  await k.until(() => document.getElementById("branch").textContent === "gone");
  const gone = join(dir, "tidepool-gone");
  execFileSync("git", ["worktree", "remove", "--force", gone], { cwd: join(dir, "tidepool") });
  // as a refresh caught halfway through the removal says it
  await k.js((gone) => document.getElementById("toasts").insertAdjacentHTML("beforeend", `<div class="toast err"><b>Error</b><pre>${gone} no longer exists</pre></div>`), gone);
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until(() => document.getElementById("branch").textContent === "main" && document.querySelector("#tabs .tab.on .tab-name")?.textContent === "tidepool");
  // one notice: the step back's
  assert.deepEqual(await k.js(() => [...document.querySelectorAll("#toasts .toast.err, #toasts .toast:last-child")].map((t) => t.querySelector("b").textContent)), ["Back to tidepool"]);
});
