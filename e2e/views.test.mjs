import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

test("a Markdown diff shows its preview, then its text again where it was", async () => {
  await k.click("#graph .row", "docs: --json in the README");
  await k.click("#commit-files .file", "README.md");
  await k.until(() => !document.getElementById("svg-view").hidden);
  await k.click('[data-svg="image"]');
  const h = await k.until(() => [...document.querySelectorAll("#diff-binary iframe")].pop()?.contentDocument?.querySelector("h1, h2")?.textContent);
  assert.match(h, /tidepool/i);
  await k.shot("markdown-preview");
  await k.click('[data-svg="text"]');
  // Monaco draws the rows a moment after the editor shows
  await k.until(() => !document.getElementById("diff-editor").hidden && document.querySelector("#diff-editor").textContent.includes("--json"));
});
