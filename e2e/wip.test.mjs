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
  // the sidebar folded to its icons, for the diff's width
  await k.until(() => document.querySelector("main").classList.contains("rail"));
  await k.shot("diff-hunk");
  await k.click('[data-mode="split"]');
  await k.until(() => !document.querySelector("#diff-editor .hunk-bar"));
  await k.shot("diff-split");
  // the File view picked: the next change opens in it too, the Diff view's buttons greyed, saying so
  await k.click('[data-dview="file"]');
  await k.click("#unstaged .file", "docs/logo.svg");
  await k.until(() => !document.getElementById("diff-file").hidden && document.querySelector('[data-dview="file"]').classList.contains("on"));
  assert.equal(await k.js(() => document.getElementById("next-change").title), "Next change (N) (Diff mode only)");
  await k.click('[data-dview="diff"]');
  // a new file shows alone first, its Diff view still there to pick its lines
  await k.click("#unstaged .file", "src/units.rs");
  await k.until(() => !document.getElementById("diff-file").hidden && !document.querySelector('[data-dview="diff"]').classList.contains("off"));
  // an unchanged file has nothing to compare: it shows alone, Diff greyed
  await k.click(".all-files");
  await k.click("#unstaged .file", "Cargo.toml");
  await k.until(() => !document.getElementById("diff-file").hidden && document.querySelector('[data-dview="diff"]').classList.contains("off"));
  assert.ok(await k.js(() => document.getElementById("diff-editor").hidden && document.querySelector('[data-dview="file"]').classList.contains("on")));
  await k.click(".all-files");
  await k.click("#unstaged .file", "src/tide.rs");
  await k.click('[data-mode="hunk"]');
});

test("Stage hunk moves the change to the staged list, then a commit takes it and closes the diff", async () => {
  await k.click("#diff-editor .hunk-bar button.hunk-stage");
  await k.until(() => document.querySelector('#staged .file[data-path="src/tide.rs"]'));
  // its other hunk stays unstaged
  assert.deepEqual(await listed("unstaged"), ["docs/logo.svg", "src/tide.rs", "src/units.rs"]);
  await k.type("#summary", "test: a commit from the e2e run");
  await k.click("#commit-btn");
  await k.until(() => [...document.querySelectorAll("#graph .row")].some((r) => r.textContent.includes("a commit from the e2e run")));
  assert.deepEqual(await listed("staged"), []);
  await k.until(() => document.getElementById("diff").hidden);
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
