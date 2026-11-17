import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

test("an interactive rebase squashes a commit, the changes kept aside and back", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Interactive rebase");
  await k.until(() => !document.getElementById("rebase").hidden && document.querySelectorAll("#rebase-rows .rb-row, #rebase-rows > *").length);
  await k.keys("s");
  await k.shot("rebase");
  await k.click("#rebase-start");
  await k.until(() => document.getElementById("rebase").hidden);
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("chore: move to the 2024 edition"));
  // the uncommitted changes went into a stash for the rebase and came back
  await k.until(() => [...document.querySelectorAll("#graph .row.wip")].some((r) => /\d/.test(r.textContent)));
});
