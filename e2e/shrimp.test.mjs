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
  });
  k = await launch(dir);
});
after(() => k?.quit());

test("a clean WIP list gets a shrimp after a while; it darts off as a change arrives", async () => {
  await k.click("#graph .row", "// WIP");
  // in from the right edge, past the first wait
  await k.until(() => document.querySelector("#wip .shrimp-sea"));
  writeFileSync(join(dir, "tide.txt"), "low\n");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until(() => document.querySelector('#unstaged .file[data-path="tide.txt"]') && !document.querySelector("#wip .shrimp-sea"));
  assert.equal(await k.js(() => document.querySelectorAll("#wip .shrimp-sea").length), 0);
});
