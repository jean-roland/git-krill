import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/conflict/tidepool`)));
after(() => k?.quit());

test("a merge stopped on conflicts opens its file in the merge tool", async () => {
  await k.click("#unstaged .file");
  await k.until(() => !document.getElementById("merge").hidden && document.getElementById("m-count").textContent);
  assert.match(await k.js(() => document.getElementById("m-count").textContent), /\d/);
  await k.shot("merge");
});

test("the conflict resolved by a pick and saved, the merge commits", async () => {
  // all of the incoming side
  await k.click("#m-all-b");
  await k.click("#m-save");
  await k.until(() => document.getElementById("merge").hidden && !document.querySelector("#unstaged .file"));
  // a merge commits through its own button
  await k.click("#op-continue", "Commit and merge");
  await k.until(() => document.getElementById("opstate").hidden && document.querySelector("#graph .row.row-head")?.textContent.includes("Merge"));
});
