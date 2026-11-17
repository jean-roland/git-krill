import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, origin;
before(async () => {
  const d = demo();
  origin = join(d, "origin.git");
  k = await launch(`${d}/tidepool`);
});
after(() => k?.quit());

test("Ctrl+N clones a repository into a new tab", async () => {
  await k.keys("", "n");
  await k.until(() => !document.getElementById("dialog").hidden && document.querySelector("#dialog .clone-dlg"));
  await k.type("#dialog .dlg-row input", mkdtempSync(join(tmpdir(), "krill-e2e-clone-")));
  await k.type('#dialog input[placeholder^="git@"]', origin);
  await k.click("#dialog .dlg-actions button.primary", "Clone");
  await k.until(() => document.querySelectorAll("#tablist .tab").length === 2);
  await k.until(() => document.getElementById("repo-name").textContent.trim() === "origin");
  assert.ok(await k.js(() => document.querySelector("#graph .row")));
});
