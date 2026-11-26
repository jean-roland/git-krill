import assert from "node:assert/strict";
import { chmodSync, readFileSync } from "node:fs";
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
  const items = () => k.js(() => [...document.querySelectorAll("#menu button")].map((b) => b.textContent));
  // main's label, ahead too
  await k.menu('#sidebar [data-key="local"] .item', "main");
  const onMain = await items();
  assert.ok(onMain.includes("Fast-forward work to main") && !onMain.some((t) => t.startsWith("Merge into") || t.includes("onto this branch")), onMain.join(", "));
  await k.keys("\uE00C");
  await k.menu("#graph .row", "two");
  const onTwo = await items();
  assert.ok(onTwo.includes("Fast-forward work to this commit") && !onTwo.some((t) => t.includes("onto this commit")), onTwo.join(", "));
  await k.click("#menu button", "Fast-forward work to this commit");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("two"));
  // the edit was kept aside around it, then back
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "A\nb\nc\nd\nE\n");
  // and around its Undo too, which git alone refuses over a file the fast-forward changed
  await k.click("#undo");
  await k.until(() => document.querySelector("#graph .row.row-head")?.textContent.includes("one"));
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "a\nb\nc\nd\nE\n");
});

test("a commit or branch ahead offers no fast-forward or merge while a rebase is stopped", async () => {
  const dir = repo(({ git, commit, write }) => {
    for (const [n, text] of [["one", "a\nb\n"], ["two", "A\nb\n"], ["three", "A\nB\n"]]) {
      write("notes.md", text);
      git("add", ".");
      commit(n);
    }
    git("checkout", "-qb", "work", "HEAD~2");
    write("notes.md", "X\nb\n");
    git("add", ".");
    commit("mine");
    // stopped on a conflict over line one: HEAD is two, three is ahead of it
    try {
      git("rebase", "main~1");
    } catch {}
  });
  await k.quit();
  k = await launch(dir);
  const items = () => k.js(() => [...document.querySelectorAll("#menu button")].map((b) => b.textContent));
  await k.menu("#graph .row", "three");
  const onThree = await items();
  assert.ok(onThree.length && !onThree.some((t) => t.startsWith("Fast-forward")), onThree.join(", "));
  await k.keys("\uE00C");
  await k.menu('#sidebar [data-key="local"] .item', "main");
  const onMain = await items();
  assert.ok(onMain.length && !onMain.some((t) => t.startsWith("Fast-forward") || t.startsWith("Merge into")), onMain.join(", "));
});

test("an interactive rebase onto a branch drops the oldest commits it already holds, as after a squash merge: only the new one is replayed", async () => {
  const dir = repo(({ git, commit, write }) => {
    write("notes.md", "a\nb\nc\nd\ne\n");
    git("add", ".");
    commit("base");
    git("checkout", "-qb", "work");
    // a pull request in two steps, the second redoing the first's line, then new work on top
    for (const [n, f, text] of [["pr: X", "notes.md", "a\nX\nc\nd\ne\n"], ["pr: B", "notes.md", "a\nB\nc\nD\ne\n"], ["new: todo", "todo.md", "x\n"]]) {
      write(f, text);
      git("add", ".");
      commit(n);
    }
    git("checkout", "-q", "main");
    // the pull request squash-merged, main going on after it with the line between the two it changed
    for (const [n, text] of [["pr (#1)", "a\nB\nc\nD\ne\n"], ["main: C", "a\nB\nC\nD\ne\n"]]) {
      write("notes.md", text);
      git("add", ".");
      commit(n);
    }
    git("checkout", "-q", "work");
  });
  await k.quit();
  k = await launch(dir);
  await k.menu('#sidebar [data-key="local"] .item', "main");
  await k.click("#menu button", "Interactive rebase work onto this branch");
  await k.until(() => document.querySelectorAll("#rebase-rows .rb-row.drop").length === 2);
  const rows = await k.js(() => [...document.querySelectorAll("#rebase-rows .rb-row")].map((r) => [r.querySelector(".rb-subject").textContent, r.classList.contains("drop"), r.querySelector(".rb-already")?.textContent ?? ""]));
  assert.deepEqual(rows, [["new: todo", false, ""], ["pr: B", true, "already in main"], ["pr: X", true, "already in main"]]);
  await k.click("#rebase-start");
  // new: todo was the head already: the files tell when the rebase is through
  for (let i = 0; i < 50 && readFileSync(join(dir, "notes.md"), "utf8") !== "a\nB\nC\nD\ne\n"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "a\nB\nC\nD\ne\n");
  assert.equal(readFileSync(join(dir, "todo.md"), "utf8"), "x\n");
});

test("an interactive rebase keeps a whitespace fix, a partial revert, a deletion and a mode change made after a squash-merged pull request", async () => {
  const dir = repo(({ dir, git, commit, write }) => {
    write("f.c", "a\nb\nc\nd\ne\nf\n");
    git("add", ".");
    commit("base");
    git("checkout", "-qb", "work");
    for (const [n, text] of [["pr: B, with a debug line", "a\nB\nc\nd\ne\nf\nDEBUG\n"], ["indent B", "a\n  B\nc\nd\ne\nf\nDEBUG\n"], ["drop the debug line", "a\n  B\nc\nd\ne\nf\n"], ["delete d", "a\n  B\nc\ne\nf\n"]]) {
      write("f.c", text);
      git("add", ".");
      commit(n);
    }
    chmodSync(join(dir, "f.c"), 0o755);
    git("add", ".");
    commit("make it executable");
    git("checkout", "-q", "main");
    write("f.c", "a\nB\nc\nd\ne\nf\nDEBUG\n");
    git("add", ".");
    commit("pr (#1)");
    git("checkout", "-q", "work");
  });
  await k.quit();
  k = await launch(dir);
  await k.menu('#sidebar [data-key="local"] .item', "main");
  await k.click("#menu button", "Interactive rebase work onto this branch");
  // one answer flips every row it drops at once
  await k.until(() => document.querySelectorAll("#rebase-rows .rb-row.drop").length);
  const rows = await k.js(() => [...document.querySelectorAll("#rebase-rows .rb-row")].map((r) => [r.querySelector(".rb-subject").textContent, r.classList.contains("drop")]));
  assert.deepEqual(rows, [["make it executable", false], ["delete d", false], ["drop the debug line", false], ["indent B", false], ["pr: B, with a debug line", true]]);
  await k.click("#rebase-cancel");
});
