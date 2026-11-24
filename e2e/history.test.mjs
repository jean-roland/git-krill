import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

test("a file's history shows each version with its blame, then each commit's change", async () => {
  await k.click("#graph .row", "docs: --json in the README");
  await k.click('#commit-files .file[data-path="README.md"]');
  await k.click("#diff-history");
  // opened on the commit it came from
  await k.until(() => document.querySelector("#hist-list .hist-row.on")?.textContent.includes("--json in the README"));
  assert.ok((await k.js(() => document.querySelectorAll("#hist-list .hist-row").length)) >= 3);
  await k.click("#hist-blame");
  // each run of lines with its commit's subject in the gutter
  await k.until(() => document.getElementById("hist-file").textContent.includes("docs: add a README"));
  await k.shot("history-blame");
  await k.click("#hist-list .hist-row", "docs: add a README");
  // that version's text: the README before --json was added to it
  await k.until(() => {
    const text = document.getElementById("hist-file").textContent.replace(/\u00a0/g, " ");
    return text.includes("Tide tables in the terminal") && !text.includes("--json");
  });
  await k.click('[data-hview="diff"]');
  await k.until(() => !document.getElementById("diff-editor").hidden && document.querySelector("#diff-editor").textContent.replace(/\u00a0/g, " ").includes("Tide tables"));
  await k.shot("history-diff");
});

test("a history diff drawn as pages is idle once they load", async () => {
  await k.click('[data-svg="image"]');
  await k.until(() => document.querySelector("#diff-binary iframe") && !document.body.classList.contains("slow"));
  await k.click("#hist-list .hist-row", "--json in the README");
  await k.until(() => document.querySelectorAll("#diff-binary iframe").length === 2);
  // no hunks to wait for: idle once the pages load, not after Monaco's 5.5 s fallback
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(!(await k.js(() => document.body.classList.contains("slow"))));
  await k.click('[data-svg="text"]');
});
