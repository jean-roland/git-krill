import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch, repo } from "./driver.mjs";

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

test("a commit ahead on the branch's own line is fast-forwarded to, not rebased onto, the changes kept", async () => {
  const dir = repo(({ git, commit, write }) => {
    for (const [n, text] of [["one", "a\nb\nc\nd\ne\n"], ["two", "A\nb\nc\nd\ne\n"], ["three", "A\nB\nc\nd\ne\n"]]) {
      write("notes.md", text);
      git("add", ".");
      commit(n);
    }
    git("checkout", "-qb", "work", "HEAD~2");
    // the fast-forward changes this file too: git alone refuses to move over the edit
    write("notes.md", "a\nb\nc\nd\nE\n");
  });
  // one app at a time: the demo one gives way
  await k.quit();
  k = await launch(dir);
  await k.menu("#graph .row", "two");
  const items = await k.js(() => [...document.querySelectorAll("#menu button")].map((b) => b.textContent));
  assert.ok(items.includes("Fast-forward work to this commit") && !items.some((t) => t.includes("onto this commit")), items.join(", "));
  await k.click("#menu button", "Fast-forward work to this commit");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("two"));
  // the edit was kept aside around it, then back
  await k.until(() => document.querySelector('#unstaged .file[data-path="notes.md"]'));
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "A\nb\nc\nd\nE\n");
});
