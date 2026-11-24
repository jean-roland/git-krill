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
