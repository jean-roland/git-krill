import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

test("the graph shows the history with its branches and tags", async () => {
  const rows = await k.until(() => document.querySelectorAll("#graph .row").length > 20 && document.querySelectorAll("#graph .row").length);
  assert.ok(rows >= 25, `${rows} rows`);
  const labels = await k.js(() => [...document.querySelectorAll("#graph .row .label, #graph .row .ref")].map((e) => e.textContent.trim()).join(" "));
  for (const l of ["main", "v0.1.0", "v0.2.0"]) assert.match(labels, new RegExp(l.replace(".", "\\.")));
  await k.shot("graph");
});

test("a text selection dragged out of a dialog's field keeps the dialog; a click beside it closes it", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Create worktree from this commit");
  const field = await k.until(() => document.querySelector("#dialog input"));
  await k.type("#dialog input", "a branch name to select");
  // pressed in the field, let go on the dimmed backdrop
  const drag = [{ type: "pointerMove", origin: field, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", origin: "viewport", x: 5, y: 500, duration: 200 }, { type: "pointerUp", button: 0 }];
  await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: drag }] });
  await k.cmd("DELETE", "actions");
  await k.settle();
  assert.equal(await k.js(() => document.getElementById("dialog").hidden), false);
  await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 5, y: 500 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  await k.cmd("DELETE", "actions");
  await k.until(() => document.getElementById("dialog").hidden);
});
