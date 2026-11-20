import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

let k, dir;
before(async () => {
  dir = repo(({ git, commit, write }) => {
    write("tide.txt", "high\n");
    git("add", ".");
    commit("Add the tide");
    write("tide.txt", "low\n");
    write("moon.txt", "full\n");
  });
  k = await launch(dir);
});
after(() => k?.quit());

const stashes = () => k.js(() => +document.querySelector('#sidebar [data-key="stashes"] .n')?.textContent || 0);
const onWip = () => k.js(() => !!document.querySelector("#graph .row.sel")?.textContent.includes("// WIP"));

test("stashing everything stays on the work in progress, WIP row clicked or not", async () => {
  assert.ok(await onWip());
  await k.click('[data-op="stash-push"]');
  await k.until(() => +document.querySelector('#sidebar [data-key="stashes"] .n')?.textContent === 1);
  await k.settle();
  assert.ok(await onWip());
});

test("a single file stashes from its own menu", async () => {
  writeFileSync(join(dir, "tide.txt"), "ebb\n");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.menu("#unstaged .file", "tide.txt");
  await k.click("#menu button", "Stash file");
  await k.until(() => +document.querySelector('#sidebar [data-key="stashes"] .n')?.textContent === 2 && !document.querySelector('#unstaged .file[data-path="tide.txt"]'));
  assert.equal(await stashes(), 2);
});
