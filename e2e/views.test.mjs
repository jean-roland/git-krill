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

test("Ctrl+= and Ctrl+wheel zoom a diff's text a step each, Reset back to its size", async () => {
  // the Markdown diff still open, its text shown
  const size = () => document.querySelector("#diff-editor .view-lines").style.fontSize;
  await k.keys("\uE009", "=");
  // the level in the bubble a moment, and on the button while off 100%
  await k.until(() => document.getElementById("zoom").title === "Text zoom 110%" && !document.getElementById("zoom-pop").hidden);
  assert.equal(await k.js(size), "14.3px");
  assert.equal(await k.js(() => document.getElementById("zoom-n").textContent), "110%");
  await k.js(() => document.querySelector("#diff-editor .view-lines").dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true })));
  await k.until(() => document.getElementById("zoom").title === "Text zoom 125%");
  // Reset closes the bubble it is in
  await k.click("#zoom");
  await k.click("#zoom-reset");
  await k.until(() => document.getElementById("zoom").title === "Text zoom 100%" && document.getElementById("zoom-pop").hidden);
  assert.equal(await k.js(size), "13px");
  assert.equal(await k.js(() => document.getElementById("zoom-n").textContent), "");
  // the window itself never zooms, and the button goes with the diff
  assert.equal(await k.js(() => devicePixelRatio), 1);
  await k.keys("\uE00C");
  await k.until(() => !document.getElementById("zoom").offsetParent);
});
