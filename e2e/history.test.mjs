import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k, top;
before(async () => (k = await launch((top = `${demo()}/tidepool`))));
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

test("leaving a history opened from a diff goes back to that diff", async () => {
  // opened from the --json commit's diff, left on another commit
  const from = await k.js(() => [...document.querySelectorAll("#hist-list .hist-row")].find((r) => r.textContent.includes("--json in the README")).querySelector("code").textContent);
  await k.click("#hist-list .hist-row", "docs: add a README");
  // left from a preview: a copy's frames would load again, blank then at their top
  await k.click('[data-svg="image"]');
  await k.until(() => document.querySelector("#diff-binary iframe")?.contentDocument?.body?.childElementCount);
  // each frame until it is drawn: the history, a still copy of it, or the diff; never the graph
  await k.js(() => {
    window.framed = [];
    window.shown = [];
    const d = document.getElementById("diff"), t0 = performance.now();
    const tick = () => {
      window.shown.push(document.body.classList.contains("history") || !!document.querySelector(".still") || (!d.hidden && !d.classList.contains("blank")));
      window.framed.push([...document.querySelectorAll(".still iframe")].some((f) => getComputedStyle(f).visibility !== "hidden"));
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    tick();
  });
  await k.click("#hist-close");
  const path = await k.until(() => !document.body.classList.contains("history") && !document.getElementById("diff").hidden && document.getElementById("diff-path").textContent.includes("..") && document.getElementById("diff-path").textContent);
  assert.match(path, new RegExp(`^README\\.md .*\\.\\.${from}$`));
  await k.until(() => window.shown.length > 30);
  assert.ok(await k.js(() => window.shown.every(Boolean)), "the graph showed between the history and the diff");
  assert.ok(!(await k.js(() => window.framed.some(Boolean))), "a copied frame showed");
  await k.click('[data-svg="text"]');
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("diff").hidden);
});

test("leaving a history opened from a working tree diff whose file was staged since goes back to the graph", async () => {
  const readme = join(top, "README.md");
  appendFileSync(readme, "\nA line not committed.\n");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "// WIP");
  await k.click('#unstaged .file[data-path="README.md"]');
  await k.click("#diff-history");
  await k.until(() => document.body.classList.contains("history"));
  execFileSync("git", ["add", "README.md"], { cwd: top });
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.until(() => document.querySelector('#staged .file[data-path="README.md"]'));
  await k.click("#hist-close");
  await k.until(() => !document.body.classList.contains("history"));
  await k.settle();
  assert.ok(await k.js(() => document.getElementById("diff").hidden));
  execFileSync("git", ["reset", "-q", "--", "README.md"], { cwd: top });
  execFileSync("git", ["checkout", "--", "README.md"], { cwd: top });
});
