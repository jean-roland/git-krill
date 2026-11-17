import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

let k;
before(async () => {
  const dir = repo(({ git, commit, write }) => {
    write("README.md", "# Lanes\n");
    git("add", ".");
    commit("Start");
    // a branch a lane, none merged: wider than the graph column
    for (let i = 1; i <= 14; i++) {
      git("checkout", "-qb", `topic-${i}`, "main");
      write(`topic-${i}.md`, `${i}\n`);
      git("add", ".");
      commit(`Topic ${i}`);
    }
    git("checkout", "-q", "main");
  });
  k = await launch(dir);
});
after(() => k?.quit());

const gx = () => getComputedStyle(document.getElementById("graph")).getPropertyValue("--gx").trim();

test("lanes wider than the graph column scroll sideways, the messages stay", async () => {
  assert.equal(await k.js(() => document.querySelector("#cols .g-col").getBoundingClientRect().width), 230);
  assert.ok(await k.js(() => document.getElementById("graph").classList.contains("cut-right")));
  const msg = await k.js(() => document.querySelector("#graph .row .subject").getBoundingClientRect().left);
  await k.js(() => document.getElementById("graph").dispatchEvent(new WheelEvent("wheel", { deltaX: 40, cancelable: true })));
  assert.equal(await k.js(gx), "40px");
  assert.ok(await k.js(() => document.getElementById("graph").classList.contains("cut-left")));
  assert.equal(await k.js(() => document.querySelector("#graph .row .subject").getBoundingClientRect().left), msg);
  // their scrollbar under the column moves them too
  await k.js(() => (document.getElementById("lane-bar").scrollLeft = 80));
  await k.until(() => getComputedStyle(document.getElementById("graph")).getPropertyValue("--gx").trim() === "80px");
});

test("a commit picked off to the side scrolls its lane into view", async () => {
  await k.js(() => (document.getElementById("lane-bar").scrollLeft = 0));
  await k.until(() => getComputedStyle(document.getElementById("graph")).getPropertyValue("--gx").trim() === "0px");
  // the oldest branch, furthest right
  await k.click("#sidebar .item", "topic-1");
  await k.until(() => getComputedStyle(document.getElementById("graph")).getPropertyValue("--gx").trim() !== "0px");
});
