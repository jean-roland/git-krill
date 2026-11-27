import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, repository;
before(async () => (k = await launch((repository = `${demo()}/tidepool`))));
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

test("a text selection dragged out of a menu's name box keeps the box; a click beside it closes it", async () => {
  await k.menu("#graph .row", "chore: release 0.2.0");
  await k.click("#menu button", "Create tag here");
  const box = await k.until(() => document.querySelector("#menu input.ask"));
  // the status bar: a click there does nothing else
  const [x, y] = await k.js(() => {
    const r = document.getElementById("status").getBoundingClientRect();
    return [Math.round(r.left + 5), Math.round(r.top + r.height / 2)];
  });
  // pressed in the box, let go outside the menu
  const drag = [{ type: "pointerMove", origin: box, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerMove", origin: "viewport", x, y, duration: 200 }, { type: "pointerUp", button: 0 }];
  await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: drag }] });
  await k.cmd("DELETE", "actions");
  await k.settle();
  assert.equal(await k.js(() => document.getElementById("menu").hidden), false);
  await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
  await k.cmd("DELETE", "actions");
  await k.until(() => document.getElementById("menu").hidden);
});

test("the Branch / Tag column widens by its grip up to its longest label, the messages kept in view; a double-click resets it", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", ...args], { cwd: repository });
  const refsWidth = () => k.js(() => document.querySelector("#graph .row .refs").getBoundingClientRect().width);
  // the graph's width past the Branch / Tag and Graph columns
  const subjectWidth = () => k.js(() => document.getElementById("graph").clientWidth - [...document.querySelectorAll("#cols .refs, #cols .g-col")].reduce((w, c) => w + c.getBoundingClientRect().width, 0));
  const was = await refsWidth();
  // the grip dragged to the window's right edge
  const dragRight = async () => {
    const [x, y, right] = await k.js(() => {
      const r = document.getElementById("refs-grip").getBoundingClientRect();
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), innerWidth - 5];
    });
    const drag = [{ type: "pointerMove", origin: "viewport", x, y }, { type: "pointerDown", button: 0 }, { type: "pointerMove", origin: "viewport", x: right, y, duration: 200 }, { type: "pointerUp", button: 0 }];
    await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: drag }] });
    await k.cmd("DELETE", "actions");
  };
  const refresh = () => k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  // a label longer than the window: the messages stop it
  git("branch", `feature/${"a-very-long-branch-name-".repeat(8)}end`, "HEAD~2");
  await refresh();
  await k.until(() => [...document.querySelectorAll("#graph .ref-name")].some((n) => n.textContent.endsWith("-end")));
  await dragRight();
  assert.ok((await subjectWidth()) >= 199, `${await subjectWidth()}`);
  git("branch", "-D", `feature/${"a-very-long-branch-name-".repeat(8)}end`);
  await refresh();
  await k.until(() => ![...document.querySelectorAll("#graph .ref-name")].some((n) => n.textContent.endsWith("-end")));
  // the demo's labels: the longest one whole, no wider
  await dragRight();
  const fit = await refsWidth();
  // the widest label, its insets and 2 px of subpixel spare
  const widest = await k.js(() => Math.max(...[...document.querySelectorAll("#graph .row .refs-in")].map((c) => [...c.children].reduce((w, e) => w + e.getBoundingClientRect().width, 0))));
  assert.ok(fit <= Math.ceil(widest) + 16, `${fit} for ${widest}`);
  assert.ok(await k.js(() => [...document.querySelectorAll("#graph .row .refs-in .ref:first-child .ref-name")].every((n) => n.scrollWidth <= n.clientWidth)));
  await k.js(() => document.getElementById("refs-grip").dispatchEvent(new MouseEvent("dblclick")));
  assert.equal(await refsWidth(), was);
});
