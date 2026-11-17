import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

const listed = (list) => k.js((list) => [...document.querySelectorAll(`#${list} .file`)].map((f) => f.dataset.path), list);

test("a change opens in Hunk view, then Split", async () => {
  await k.click("#unstaged .file", "src/tide.rs");
  await k.until(() => document.querySelector("#diff-editor .hunk-bar button.hunk-stage"));
  assert.equal(await k.js(() => document.querySelector("[data-mode].on").dataset.mode), "hunk");
  await k.shot("diff-hunk");
  await k.click('[data-mode="split"]');
  await k.until(() => !document.querySelector("#diff-editor .hunk-bar"));
  await k.shot("diff-split");
  await k.click('[data-mode="hunk"]');
});

test("Stage hunk moves the change to the staged list, then a commit takes it", async () => {
  await k.click("#diff-editor .hunk-bar button.hunk-stage");
  await k.until(() => document.querySelector('#staged .file[data-path="src/tide.rs"]'));
  // its other hunk stays unstaged
  assert.deepEqual(await listed("unstaged"), ["src/tide.rs", "src/units.rs"]);
  await k.type("#summary", "test: a commit from the e2e run");
  await k.click("#commit-btn");
  await k.until(() => [...document.querySelectorAll("#graph .row")].some((r) => r.textContent.includes("a commit from the e2e run")));
  assert.deepEqual(await listed("staged"), []);
});

test("Stash puts the rest away, Pop brings it back", async () => {
  // the sidebar's count
  const stashes = () => k.js(() => +[...document.querySelectorAll("#sidebar summary")].find((s) => s.textContent.includes("Stashes")).querySelector(".n").textContent);
  const before = await stashes();
  await k.click('[data-op="stash-push"]');
  await k.until((n) => +[...document.querySelectorAll("#sidebar summary")].find((s) => s.textContent.includes("Stashes")).querySelector(".n").textContent > n, before);
  await k.click('[data-op="stash-pop"]');
  await k.until(() => document.querySelector('#unstaged .file[data-path="src/units.rs"]')?.getClientRects().length);
  assert.equal(await stashes(), before);
});
