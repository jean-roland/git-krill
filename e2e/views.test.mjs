import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
const repository = `${demo()}/tidepool`;
before(async () => (k = await launch(repository)));
after(() => k?.quit());

function pdfFixture(label) {
  const content = `BT /F1 24 Tf 72 720 Td (${label}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(`${pdf}\0`, "binary");
}

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
  // the level on the button while off 100%, no bubble
  await k.until(() => document.getElementById("zoom").title === "Text zoom 110%");
  assert.ok(await k.js(() => document.getElementById("zoom-pop").hidden));
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

test("a PDF shows in the window's own viewer, alone in the File view, beside its old version in the Diff view", async () => {
  const path = join(repository, "docs", "preview.pdf");
  writeFileSync(path, pdfFixture("Initial PDF"));
  execFileSync("git", ["add", "--", "docs/preview.pdf"], { cwd: repository });
  writeFileSync(path, pdfFixture("Updated PDF"));
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "// WIP");
  await k.click('#unstaged .file[data-path="docs/preview.pdf"]');
  const shown = () => [...document.querySelectorAll("#diff-binary .img-side")].filter((s) => s.offsetParent).map((s) => s.textContent.split(" · ")[0]);
  await k.until(() => document.querySelectorAll("#diff-binary iframe").length === 2);
  assert.deepEqual(await k.js(shown), ["Working tree"]);
  await k.click('[data-dview="diff"]');
  const sides = await k.until(() => {
    const all = [...document.querySelectorAll("#diff-binary .img-side")];
    return all.length === 2 && all.every((s) => s.offsetParent && s.querySelector("iframe").src.startsWith("blob:") && / · \d+ B$/.test(s.textContent)) && all.map((s) => s.textContent.split(" · ")[0]);
  });
  assert.deepEqual(sides, ["Staged", "Working tree"]);
});
