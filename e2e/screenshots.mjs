// The README's screenshots in docs/screenshots, from the demo repositories: node e2e/screenshots.mjs
// Needs what the e2e tests need: a display, tauri-driver, the debug build.
import { writeFileSync } from "node:fs";
import { demo, groupWorkspace, launch } from "./driver.mjs";

const out = new URL("../docs/screenshots/", import.meta.url).pathname, dir = demo("workspace");

async function shot(k, name) {
  await k.js(() => document.activeElement?.blur());
  await k.settle();
  writeFileSync(`${out}${name}.png`, Buffer.from(await k.cmd("GET", "screenshot"), "base64"));
  console.log(`${name}.png`);
}

let k = await launch(`${dir}/tidepool`);
try {
  await groupWorkspace(k);
  // the overview: every section of the sidebar open, a commit with its picture stored in LFS
  for (const key of ["worktrees", "submodules"]) await k.click(`#sidebar details[data-key="${key}"] > summary`);
  await k.click("#graph .row", "docs: chart Dover beside Brest");
  await k.until(() => document.querySelector('#commit-files .file[data-path="docs/chart.png"]'));
  await shot(k, "graph");

  await k.click('#sidebar [data-key="pulls"] .item', "Mark spring tides");
  await k.until(() => document.querySelector("#pr-page .thread .reply + .reply") && document.querySelectorAll("#commit-files .file").length);
  await shot(k, "pull-request");
  await k.keys("");

  // a Markdown file's two versions side by side, their diagrams drawn
  await k.click("#graph .row", "docs: the moon in the design note");
  await k.click('#commit-files .file[data-path="docs/design.md"]');
  await k.until(() => !document.getElementById("svg-view").hidden);
  await k.click('[data-mode="split"]');
  await k.click('[data-svg="image"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary iframe")].filter((f) => f.contentDocument?.querySelector(".mermaid-drawn svg")).length === 2);
  // both from their title: the new side opens at its change
  await k.js(() => document.querySelectorAll("#diff-binary iframe").forEach((f) => f.contentWindow.scrollTo(0, 0)));
  await shot(k, "preview");
  await k.click('[data-svg="text"]');
  await k.keys("\uE00C");

  // a file's history, blame on
  await k.click("#graph .row", "fix(tide): round heights to the centimetre");
  await k.click('#commit-files .file[data-path="src/tide.rs"]');
  await k.click("#diff-history");
  await k.until(() => document.querySelector("#hist-list .hist-row.on"));
  await k.click("#hist-blame");
  await k.until(() => document.getElementById("hist-file").textContent.includes("fix(tide): round"));
  await shot(k, "history");
} finally {
  await k.quit();
}

k = await launch(`${dir}/conflict/tidepool`);
try {
  await k.click("#unstaged .file", "main.rs");
  await k.until(() => !document.getElementById("merge").hidden && document.getElementById("m-count").textContent);
  await shot(k, "merge");
} finally {
  await k.quit();
}
