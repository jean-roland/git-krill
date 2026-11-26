import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, home;
before(async () => ((k = await launch(`${demo()}/tidepool`)), (home = k.home)));
after(() => k?.quit());

const tabs = () => k.js(() => [...document.querySelectorAll("#tablist .tab .tab-name")].map((t) => t.textContent));

test("Settings open in a tab: the identity typed there lands in the global git config", async () => {
  await k.click("#settings-btn");
  await k.until(() => !document.getElementById("settings").hidden && document.querySelector("#settings-box input"));
  // the field after its label: a change saves it
  await k.js(() => {
    const name = [...document.querySelectorAll("#settings-box *")].find((e) => !e.childElementCount && e.textContent === "Name").parentElement.querySelector("input");
    name.value = "Krill Tester";
    name.dispatchEvent(new Event("change"));
  });
  for (let i = 0; i < 50 && !/name = Krill Tester/.test(readFileSync(join(home, "gitconfig"), "utf8")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(readFileSync(join(home, "gitconfig"), "utf8"), /name = Krill Tester/);
  // the background fetch turned off, from its own row
  await k.js(() => [...document.querySelectorAll("#settings-box label")].find((l) => l.textContent.includes("in the background")).querySelector("input").click());
});

test("a tab opens with Ctrl+T; a repository's tab closed with Ctrl+W comes back with Ctrl+Shift+T", async () => {
  const before = (await tabs()).length;
  await k.keys("\uE009", "t");
  await k.until((n) => document.querySelectorAll("#tablist .tab").length === n + 1, before);
  await k.keys("\uE009", "w");
  await k.until((n) => document.querySelectorAll("#tablist .tab").length === n, before);
  // an empty tab is not kept to reopen: the repository's is
  await k.click("#tablist .tab", "tidepool");
  await k.keys("\uE009", "w");
  await k.until((n) => document.querySelectorAll("#tablist .tab").length === n - 1, before);
  await k.keys("\uE009", "\uE008", "t");
  await k.until((n) => document.querySelectorAll("#tablist .tab").length === n && [...document.querySelectorAll("#tablist .tab")].some((t) => t.textContent.includes("tidepool")), before);
});

test("after a restart the tabs and settings come back as they were", async () => {
  const was = await tabs();
  // the repository's tab in front: the app comes back on it
  await k.click("#tablist .tab", "tidepool");
  await k.until(() => document.querySelector("#graph .row"));
  await k.quit(true);
  k = await launch(undefined, {}, home);
  assert.deepEqual(await tabs(), was);
  await k.click("#settings-btn");
  await k.until(() => document.querySelector("#settings-box label"));
  assert.equal(await k.js(() => [...document.querySelectorAll("#settings-box label")].find((l) => l.textContent.includes("in the background")).querySelector("input").checked), false);
});

test("with no name or email in the global git config, Settings open at startup and mark both", async () => {
  await k.quit(true);
  const none = join(home, "no-identity");
  writeFileSync(none, "");
  k = await launch(`${demo()}/tidepool`, { GIT_CONFIG_GLOBAL: none });
  await k.until(() => !document.getElementById("settings").hidden && document.querySelectorAll("#settings-box input:invalid").length === 2);
  const notice = () => [...document.querySelectorAll("#toasts .toast.err:not(.out) b")].some((b) => b.textContent === "Git identity missing");
  assert.ok(await k.js(notice));
  // both saved, the notice goes
  await k.js(() =>
    document.querySelectorAll("#settings-box input:invalid").forEach((f, i) => {
      f.value = ["Krill Tester", "tester@example.com"][i];
      f.dispatchEvent(new Event("change"));
    }),
  );
  await k.until(() => ![...document.querySelectorAll("#toasts .toast.err:not(.out) b")].some((b) => b.textContent === "Git identity missing"));
  for (let i = 0; i < 50 && !/email = tester@example.com/.test(readFileSync(none, "utf8")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(readFileSync(none, "utf8"), /name = Krill Tester[\s\S]*email = tester@example.com/);
});

test("an identity the repository's own config gives opens no Settings at startup", async () => {
  await k.quit(true);
  const none = join(home, "no-identity-here");
  writeFileSync(none, "");
  const top = `${demo()}/tidepool`;
  execFileSync("git", ["config", "user.name", "Local Tester"], { cwd: top });
  execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: top });
  k = await launch(top, { GIT_CONFIG_GLOBAL: none });
  await k.until(() => document.querySelector("#graph .row"));
  // the startup check runs once the tab is restored
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(await k.js(() => document.getElementById("settings").hidden));
  assert.ok(!(await k.js(() => [...document.querySelectorAll("#toasts .toast.err b")].some((b) => b.textContent === "Git identity missing"))));
});

test("tabs gather under a group's chip, which folds them out of view and out of Ctrl+Tab, and comes back after a restart", async () => {
  await k.click("#tablist .tab", "tidepool");
  await k.menu("#tablist .tab", "tidepool");
  await k.click("#menu button", "Add tab to new group");
  // a new group's name is typed in its chip
  await k.type("#tablist .tab-group input", "work");
  await k.keys("");
  await k.until(() => document.querySelector("#tablist .tab-group")?.textContent === "work");
  // a worktree opened in a grouped tab, and the step back, stay in the group
  const onGrouped = (name) => document.querySelector("#tablist .tab.on .tab-name")?.textContent.includes(name) && document.querySelector("#tablist .tab.on").classList.contains("grouped");
  await k.click('#sidebar details[data-key="worktrees"] > summary');
  await k.until(() => [...document.querySelectorAll('#sidebar [data-key="worktrees"] .item')].find((e) => e.textContent.includes("feature/moon-phase"))?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await k.until(onGrouped, "›");
  await k.keys("\uE00A", "\uE012");
  await k.until(onGrouped, "tidepool");
  assert.equal(await k.js(() => document.querySelectorAll("#tablist .tab-group").length), 1);
  await k.menu("#tablist .tab-group");
  await k.click("#menu button", "New tab in group");
  // a tab dropped between two of the group's tabs joins it
  await k.keys("", "t");
  // a drag from tab `i` through the window's `xs`, each reached twice: a pointer moving on lands on the layout its last move made
  const drag = async (i, ...xs) => {
    const el = await k.until((i) => document.querySelectorAll("#tablist .tab")[i], i);
    const y = await k.js((el) => Math.round(el.getBoundingClientRect().top + 10), el);
    const moves = xs.flatMap((x) => [x, x + 1].map((x) => ({ type: "pointerMove", origin: "viewport", x: Math.round(x), y })));
    const actions = [{ type: "pointerMove", origin: el, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, ...moves, { type: "pointerUp", button: 0 }];
    await k.cmd("POST", "actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
    await k.cmd("DELETE", "actions");
  };
  const tideEnd = () => k.js(() => [...document.querySelectorAll("#tablist .tab")].find((e) => e.textContent.includes("tidepool")).getBoundingClientRect().right);
  await drag((await tabs()).length - 1, await tideEnd());
  const grouped = () => k.js(() => [...document.querySelectorAll("#tablist .tab")].flatMap((e, i) => (e.classList.contains("grouped") ? [i] : [])));
  const [first, ...more] = await grouped();
  assert.deepEqual(more, [first + 1, first + 2]);
  // folded, the open tab hands over to one in view, and Ctrl+Tab passes the folded ones by
  await k.click("#tablist .tab-group");
  await k.until(() => [...document.querySelectorAll("#tablist .tab.grouped")].every((e) => e.hidden) && !document.querySelector("#tablist .tab.on.grouped"));
  for (const _ of await grouped()) {
    await k.keys("", "");
    assert.ok(await k.js(() => !document.querySelector("#tablist .tab.on.grouped")));
  }
  // a restart lands on a repository or Settings
  await k.click("#settings-btn:not([hidden]), #settings-home");
  const was = k.home;
  await k.quit(true);
  k = await launch(undefined, {}, was);
  await k.until(() => document.querySelector("#tablist .tab-group")?.textContent === "work" && [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => e.hidden).length === 3);
  await k.click("#tablist .tab-group");
  await k.until(() => [...document.querySelectorAll("#tablist .tab.grouped")].every((e) => !e.hidden));
  // a tab leaving the middle of its group goes past its end
  await k.menu("#tablist .tab.grouped + .tab.grouped");
  await k.click("#menu button", "Remove from group");
  await k.until((first) => !document.querySelectorAll("#tablist .tab")[first + 2].classList.contains("grouped"), first);
  assert.deepEqual(await grouped(), [first, first + 1]);
  // a tab in the group leaves it on the left past its chip's middle, the group leftmost
  assert.equal(first, 0);
  await drag(2, await tideEnd(), await k.js(() => document.getElementById("tablist").getBoundingClientRect().left + 1));
  assert.deepEqual(await grouped(), [1, 2]);
});

test("a repository's tab takes the color picked in its menu; Automatic gives its own back", async () => {
  const badge = () => k.js(() => [...document.querySelectorAll("#tablist .tab")].find((e) => e.textContent.includes("tidepool")).querySelector(".tab-badge").style.getPropertyValue("--c").trim());
  const own = await badge();
  for (const [pick, color] of [["Red", "#e0524f"], ["Automatic", own]]) {
    await k.menu("#tablist .tab", "tidepool");
    await k.click("#menu button", "Color");
    await k.click("#submenu button", pick);
    await k.until((color) => [...document.querySelectorAll("#tablist .tab")].find((e) => e.textContent.includes("tidepool")).querySelector(".tab-badge").style.getPropertyValue("--c").trim() === color, color);
  }
  assert.equal(await badge(), own);
});

test("one group open at a time, turned on in Settings: a folded group's chip opens it on the tab last shown in it", async () => {
  // flipped on the Settings tab, opened if another tab is in front
  const oneGroup = async () => {
    if (await k.js(() => document.getElementById("settings").hidden)) await k.click("#settings-btn:not([hidden]), #settings-home");
    await k.js(() => [...document.querySelectorAll("#settings-box label")].find((l) => l.textContent.includes("One group open at a time")).querySelector("input").click());
  };
  // work holds tidepool, then a Home tab: its second one is shown last, then Settings opened from it keep work open
  await k.click("#tablist .tab.grouped", "Home");
  await oneGroup();
  await k.keys("", "t");
  await k.menu("#tablist .tab.on");
  await k.click("#menu button", "Add tab to group");
  await k.click("#submenu button", "New group");
  await k.type("#tablist .tab-group input", "other");
  await k.keys("");
  const open = () => k.js(() => [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => !e.hidden).length);
  const on = () => k.js(() => document.querySelector("#tablist .tab.on.grouped .tab-name")?.textContent ?? "");
  // the open tab put in other: work folds
  assert.equal(await open(), 1);
  await k.click("#tablist .tab-group", "work");
  await k.until(() => document.querySelector("#tablist .tab.on.grouped .tab-name")?.textContent === "Home" && [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => !e.hidden).length === 2);
  assert.equal(await on(), "Home");
  assert.equal(await open(), 2);
  await k.click("#tablist .tab-group", "other");
  await k.until(() => [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => !e.hidden).length === 1);
  assert.equal(await on(), "Home");  // turned off in Settings, a group opens beside the others
  await oneGroup();
  await k.click("#tablist .tab-group", "work");
  await k.until(() => [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => !e.hidden).length === 3);
  // turned back on from a tab outside the groups, the leftmost open group stays open: work's two tabs
  await k.click("#tablist .tab:not(.grouped)", "Home");
  await oneGroup();
  await k.until(() => [...document.querySelectorAll("#tablist .tab.grouped")].filter((e) => !e.hidden).length === 2);
  await oneGroup();
});

test("tabs Ctrl+clicked go into a new group with the open one, from their menu", async () => {
  for (let i = 0; i < 3; i++) await k.keys("\uE009", "t");
  const n = (await tabs()).length;
  // the two before the open one
  await k.js((n) => [n - 3, n - 2].forEach((i) => document.querySelectorAll("#tablist .tab")[i].dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }))), n);
  assert.equal(await k.js(() => document.querySelectorAll("#tablist .tab.picked").length), 2);
  await k.menu("#tablist .tab.picked");
  await k.click("#menu button", "Add 3 tabs to group");
  await k.click("#submenu button", "New group");
  await k.type("#tablist .tab-group input", "trio");
  await k.keys("\uE007");
  await k.until(() => [...document.querySelectorAll("#tablist .tab-group")].some((c) => c.textContent === "trio"));
  const after = await k.js(() => {
    const els = [...document.querySelectorAll("#tablist > *")], at = els.findIndex((c) => c.classList.contains("tab-group") && c.textContent === "trio");
    return els.slice(at + 1).map((e) => e.classList.contains("grouped"));
  });
  assert.deepEqual(after, [true, true, true]);
  assert.equal(await k.js(() => document.querySelectorAll("#tablist .tab.picked").length), 0);
});

test("Shift+click picks the tabs in view from the open one to the one clicked; a plain click drops them", async () => {
  for (let i = 0; i < 3; i++) await k.keys("\uE009", "t");
  const n = (await tabs()).length;
  await k.js((n) => document.querySelectorAll("#tablist .tab")[n - 3].dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true })), n);
  const picked = () => k.js(() => [...document.querySelectorAll("#tablist .tab")].flatMap((e, i) => (e.classList.contains("picked") ? [i] : [])));
  assert.deepEqual(await picked(), [n - 3, n - 2]);
  await k.click("#tablist .tab.on");
  assert.deepEqual(await picked(), []);
});
