import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  // the File view loads its version alone
  await k.until(() => document.querySelectorAll("#diff-binary iframe").length === 1);
  assert.deepEqual(await k.js(shown), ["Working tree"]);
  // no text to zoom
  assert.ok(await k.js(() => document.getElementById("zoom").classList.contains("off")));
  // the version on screen is not loaded again by a view switch
  await k.js(() => (document.querySelector("#diff-binary iframe").dataset.kept = "1"));
  await k.click('[data-dview="diff"]');
  const sides = await k.until(() => {
    const all = [...document.querySelectorAll("#diff-binary .img-side")];
    return all.length === 2 && all.every((s) => s.offsetParent && s.querySelector("iframe").src.startsWith("blob:") && / · \d+ B$/.test(s.textContent)) && all.map((s) => s.textContent.split(" · ")[0]);
  });
  assert.deepEqual(sides, ["Staged", "Working tree"]);
  assert.equal(await k.js(() => [...document.querySelectorAll("#diff-binary iframe")].map((f) => f.dataset.kept ?? "").join()), ",1");
  // the view it is in, asked again: the same two
  await k.click('[data-dview="diff"]');
  await k.settle();
  assert.equal(await k.js(() => document.querySelectorAll("#diff-binary .img-side").length), 2);
  await k.click('[data-dview="file"]');
  await k.until(() => document.querySelectorAll("#diff-binary iframe").length === 1);
  assert.equal(await k.js(() => document.querySelector("#diff-binary iframe").dataset.kept), "1");
  // staged, it is a new file: nothing to compare
  await k.click('#staged .file[data-path="docs/preview.pdf"]');
  await k.until(() => document.querySelector('[data-dview="diff"]').classList.contains("off") && document.querySelector('[data-dview="file"]').classList.contains("on"));
  // deleted from the working tree: its staged version is all it shows, File asked again included
  rmSync(path);
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click('#unstaged .file[data-path="docs/preview.pdf"]');
  await k.until(() => document.querySelectorAll("#diff-binary .img-side.del iframe").length === 1);
  await k.click('[data-dview="file"]');
  await k.settle();
  assert.equal(await k.js(() => document.querySelectorAll("#diff-binary .img-side").length), 1);
  execFileSync("git", ["reset", "-q", "--", "docs/preview.pdf"], { cwd: repository });
});

test("a preview gives way to the next file's text with no copy of its pages over it", async () => {
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("diff").hidden);
  await k.click("#graph .row", "docs: a tide chart for Brest");
  await k.click('#commit-files .file[data-path="README.md"]');
  await k.click('[data-svg="image"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary iframe")].pop()?.contentDocument?.body?.childElementCount);
  // each frame until the text is drawn: a copied frame would load again, blank then at its top
  await k.js(() => {
    window.framed = [];
    const t0 = performance.now();
    const tick = () => {
      window.framed.push([...document.querySelectorAll(".still iframe")].some((f) => getComputedStyle(f).visibility !== "hidden"));
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
    };
    tick();
  });
  await k.click('#commit-files .file[data-path=".gitattributes"]');
  await k.until(() => document.querySelector("#diff-editor:not([hidden]), #diff-file:not([hidden])")?.textContent.includes("filter=lfs"));
  await k.until(() => window.framed.length > 30);
  assert.ok(!(await k.js(() => window.framed.some(Boolean))));
  await k.click('#commit-files .file[data-path="README.md"]');
  await k.click('[data-svg="text"]');
});

test("a deleted image shows its last version in the File view", async () => {
  rmSync(join(repository, "docs", "logo.svg"));
  await k.keys("\uE00C");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "// WIP");
  await k.click('#unstaged .file[data-path="docs/logo.svg"]');
  await k.click('[data-svg="image"]');
  await k.until(() => document.querySelector("#diff-binary .img-side.del img"));
  assert.ok(await k.js(() => !!document.querySelector("#diff-binary .img-side.del").offsetParent));
  await k.click('[data-svg="text"]');
  execFileSync("git", ["checkout", "--", "docs/logo.svg"], { cwd: repository });
});

test("a page side taken off the page before it loads does not hold the busy pointer", async () => {
  await k.keys("\uE00C");
  await k.click("#graph .row", "docs: --json in the README");
  await k.click('#commit-files .file[data-path="README.md"]');
  await k.click('[data-svg="image"]');
  await k.click('[data-dview="file"]');
  await k.until(() => document.querySelector("#diff-binary iframe")?.contentDocument?.body?.childElementCount);
  // as a click on File landing just after the old side got its page: off the page before its load
  await k.js(() => {
    window.cut = false;
    const watch = new MutationObserver((changes) => {
      const frame = changes.map((c) => c.target).find((t) => t.matches?.(".img-side.del iframe") && t.hasAttribute("srcdoc"));
      if (frame) (frame.closest(".img-side").remove(), (window.cut = true), watch.disconnect());
    });
    watch.observe(document.getElementById("diff-binary"), { attributes: true, attributeFilter: ["srcdoc"], subtree: true });
  });
  await k.click('[data-dview="diff"]');
  await k.until(() => window.cut);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!(await k.js(() => document.body.classList.contains("slow"))));
  await k.click('[data-dview="file"]');
  await k.click('[data-svg="text"]');
});

test("both sides of a Markdown page with many diagrams draw in seconds", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repository });
  const page = (label) => Array.from({ length: 20 }, (_, i) => `## Part ${i}\n\n\`\`\`mermaid\nflowchart LR\n  A${i}[${label} ${i}] --> B${i}[Next] --> C${i}[Last]\n\`\`\`\n`).join("\n");
  writeFileSync(join(repository, "DIAGRAMS.md"), page("Start"));
  git("add", "DIAGRAMS.md");
  git("commit", "-q", "-m", "docs: diagrams");
  writeFileSync(join(repository, "DIAGRAMS.md"), page("Begin"));
  git("commit", "-q", "-a", "-m", "docs: begin the diagrams");
  await k.keys("\uE00C");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "docs: begin the diagrams");
  await k.click('#commit-files .file[data-path="DIAGRAMS.md"]');
  await k.click('[data-svg="image"]');
  // a mermaid frame out of view is slowed to 2 s a diagram: 40 of them took over a minute
  const t0 = Date.now();
  await k.click('[data-dview="diff"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary iframe")].filter((f) => f.contentDocument?.querySelectorAll(".mermaid-drawn svg").length === 20).length === 2);
  assert.ok(Date.now() - t0 < 12000, `${Date.now() - t0} ms`);
  await k.click('[data-svg="text"]');
  await k.keys("\uE00C");
  git("reset", "-q", "--hard", "HEAD~2");
});

test("a page read in the File view stays put when its old version lands beside it in the Diff view", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repository });
  const page = (word) => Array.from({ length: 60 }, (_, i) => `## Part ${i}\n\n${`The ${i % 7 ? "tide" : word} turns at the slack of the moon. `.repeat(12)}\n`).join("\n");
  writeFileSync(join(repository, "LONG.md"), page("tide"));
  git("add", "LONG.md");
  git("commit", "-q", "-m", "docs: a long page");
  writeFileSync(join(repository, "LONG.md"), page("flood"));
  git("commit", "-q", "-a", "-m", "docs: flood every seventh part");
  await k.keys("\uE00C");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "docs: flood every seventh part");
  await k.click('#commit-files .file[data-path="LONG.md"]');
  await k.click('[data-svg="image"]');
  await k.click('[data-dview="file"]');
  await k.until(() => document.querySelector("#diff-binary .img-side.add iframe")?.contentDocument?.scrollingElement?.scrollHeight > 5000);
  // halfway down, within a paragraph
  await k.js(() => (document.querySelector("#diff-binary .img-side.add iframe").contentDocument.scrollingElement.scrollTop = 2537));
  await k.settle();
  const was = await k.js(() => document.querySelector("#diff-binary .img-side.add iframe").contentDocument.scrollingElement.scrollTop);
  await k.click('[data-dview="diff"]');
  await k.until(() => document.querySelector("#diff-binary .img-side.del iframe")?.contentDocument?.body?.childElementCount);
  await k.settle();
  assert.equal(await k.js(() => document.querySelector("#diff-binary .img-side.add iframe").contentDocument.scrollingElement.scrollTop), was);
  await k.click('[data-svg="text"]');
  await k.keys("\uE00C");
  git("reset", "-q", "--hard", "HEAD~2");
});

test("two versions of a page scroll together from a rule at the top, as from text", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repository });
  const page = (word) => Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\n${`The ${i < 39 ? "tide" : word} turns at the slack of the moon. `.repeat(12)}\n\n---\n`).join("\n");
  writeFileSync(join(repository, "RULED.md"), page("tide"));
  git("add", "RULED.md");
  git("commit", "-q", "-m", "docs: a ruled page");
  writeFileSync(join(repository, "RULED.md"), page("flood"));
  git("commit", "-q", "-a", "-m", "docs: flood the last part");
  await k.keys("");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "docs: flood the last part");
  await k.click('#commit-files .file[data-path="RULED.md"]');
  await k.click('[data-svg="image"]');
  await k.click('[data-dview="diff"]');
  await k.until(() => [...document.querySelectorAll("#diff-binary iframe")].filter((f) => f.contentDocument?.scrollingElement?.scrollHeight > 5000).length === 2);
  await k.settle();
  // the 20th rule at the very top of the new version
  await k.js(() => {
    const page = document.querySelector("#diff-binary .img-side.add iframe").contentDocument.scrollingElement;
    page.scrollTop += page.querySelectorAll("hr")[20].getBoundingClientRect().top;
  });
  await k.settle();
  const tops = await k.js(() => [...document.querySelectorAll("#diff-binary iframe")].map((f) => f.contentDocument.scrollingElement.scrollTop));
  assert.ok(tops[1] > 2000 && Math.abs(tops[0] - tops[1]) < 2, String(tops));
  // the 25th paragraph, the same text as 38 others, at the top
  await k.js(() => {
    const page = document.querySelector("#diff-binary .img-side.add iframe").contentDocument.scrollingElement;
    page.scrollTop += page.querySelectorAll("p")[25].getBoundingClientRect().top;
  });
  await k.settle();
  const again = await k.js(() => [...document.querySelectorAll("#diff-binary iframe")].map((f) => f.contentDocument.scrollingElement.scrollTop));
  assert.ok(again[1] > 2000 && Math.abs(again[0] - again[1]) < 2, String(again));
  await k.click('[data-svg="text"]');
  await k.keys("");
  git("reset", "-q", "--hard", "HEAD~2");
});

test("a commit of thousands of files draws 2000 rows and counts the rest, which the filter finds", async () => {
  const git = (...args) => execFileSync("git", ["-c", "user.name=Krill Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repository });
  mkdirSync(join(repository, "bulk"));
  for (let i = 0; i < 2100; i++) writeFileSync(join(repository, "bulk", `f${i}.txt`), `${i}\n`);
  git("add", "bulk");
  git("commit", "-q", "-m", "chore: bulk import");
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "chore: bulk import");
  assert.equal(await k.until(() => document.querySelector("#commit-files .files-more")?.textContent), "100 more files: filter to find one");
  assert.match(await k.js(() => document.querySelector("#commit-files .files-more").title), /Tree view/);
  assert.equal(await k.js(() => document.querySelectorAll("#commit-files .file").length), 2000);
  // unfolded, the tree's folder row takes one of them
  await k.click('[data-files="tree"]');
  await k.click("#commit-files .folder", "bulk");
  assert.equal(await k.until(() => document.querySelector("#commit-files .files-more")?.textContent), "101 more files: filter to find one");
  await k.click('[data-files="path"]');
  const filter = (text) => k.js((text) => {
    const box = [...document.querySelectorAll(".file-filter")].find((f) => f.offsetParent);
    box.value = text;
    box.dispatchEvent(new Event("input"));
  }, text);
  await filter("f2099.");
  await k.until(() => document.querySelector('#commit-files .file[data-path="bulk/f2099.txt"]'));
  assert.ok(!(await k.js(() => document.querySelector("#commit-files .files-more"))));
  await filter("");
  git("reset", "-q", "--hard", "HEAD~1");
});

test("Ctrl+F with a diff open finds in its text, not in the commits behind it", async () => {
  await k.click("#graph .row", "fix(tide): round heights to the centimetre");
  await k.click('#commit-files .file[data-path="src/tide.rs"]');
  await k.until(() => document.querySelector("#diff-editor .editor.modified .view-line"));
  await k.keys("\uE009", "f");
  await k.until(() => document.querySelector("#diff-editor .editor.modified .find-widget.visible"));
  assert.ok(await k.js(() => document.getElementById("find").hidden));
  // the first Escape is the find box's
  await k.keys("\uE00C");
  await k.until(() => !document.querySelector("#diff-editor .find-widget.visible"));
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("diff").hidden);
});

test("the rail's peek opens though the pointer left through the window's left edge, and closes over the diff", async () => {
  await k.click('#commit-files .file[data-path="src/tide.rs"]');
  await k.until(() => document.querySelector("main.rail"));
  // a maximized window's frame holds the screen's last column: the pointer leaves the page there
  await k.js(() => {
    const s = document.getElementById("sidebar");
    s.dispatchEvent(new MouseEvent("mouseenter"));
    s.dispatchEvent(new MouseEvent("mouseleave", { clientX: -1, clientY: 300 }));
  });
  await k.until(() => document.getElementById("sidebar").classList.contains("open"));
  await k.js(() => document.getElementById("diff").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await k.until(() => !document.getElementById("sidebar").classList.contains("open"));
  await k.keys("\uE00C");
});

test("Back closes the file view and Forward opens it again, from the arrows, the mouse's side buttons or Alt+arrows", async () => {
  await k.click("#graph .row", "docs: chart Dover beside Brest");
  await k.click("#commit-files .file");
  await k.until(() => !document.getElementById("diff").hidden);
  const path = await k.js(() => document.getElementById("diff-path").textContent);
  const shown = () => k.js(() => !document.getElementById("diff").hidden);
  await k.click("#nav-back");
  await k.until(() => document.getElementById("diff").hidden && !document.getElementById("nav-forward").classList.contains("off"));
  await k.click("#nav-forward");
  await k.until((path) => !document.getElementById("diff").hidden && document.getElementById("diff-path").textContent === path, path);
  await k.js(() => document.dispatchEvent(new MouseEvent("mouseup", { button: 3, bubbles: true })));
  await k.until(() => document.getElementById("diff").hidden);
  await k.js(() => document.dispatchEvent(new MouseEvent("mouseup", { button: 4, bubbles: true })));
  await k.until(() => !document.getElementById("diff").hidden);
  await k.keys("", "");
  await k.until(() => document.getElementById("diff").hidden);
  assert.equal(await shown(), false);
  // nothing left to go back to: Back is greyed
  assert.ok(await k.js(() => document.getElementById("nav-back").classList.contains("off")));
  // another tab and back: Forward still leads to the file
  await k.keys("", "t");
  await k.click("#tablist .tab", "tidepool");
  await k.until(() => !document.getElementById("nav-forward").classList.contains("off"));
  // its × shows on hover only
  await k.js(() => document.querySelector("#tablist .tab:not(.on) .x").click());
  await k.until(() => document.querySelectorAll("#tablist .tab").length === 1);
});

test("Open in editor, with no editor command set, opens the working tree file in krill: the WIP's File view, editable", async () => {
  // changed: its diff would open as changes
  const tide = join(repository, "src", "tide.rs");
  writeFileSync(tide, `// tides\n${execFileSync("git", ["show", "HEAD:src/tide.rs"], { cwd: repository })}`);
  await k.js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F5", bubbles: true })));
  await k.click("#graph .row", "// WIP");
  await k.until(() => document.querySelector('#unstaged .file[data-path="src/tide.rs"]'));
  await k.click("#graph .row", "fix(tide): round heights to the centimetre");
  await k.menu('#commit-files .file[data-path="src/tide.rs"]');
  await k.click("#menu button", "Open in editor");
  await k.until(() => !document.getElementById("diff-file").hidden && document.getElementById("diff-path").textContent.includes("src/tide.rs"));
  assert.ok(await k.js(() => document.querySelector("#graph .row.sel")?.textContent.includes("// WIP")));
  assert.ok(await k.js(() => document.querySelector('[data-dview="file"]').classList.contains("on") && !document.querySelector("#diff-file textarea").hasAttribute("readonly")));
  // its diff already open from the WIP list: switched to its File view, not closed as a second click would
  await k.keys("\uE00C");
  await k.click('#unstaged .file[data-path="src/tide.rs"]');
  await k.until(() => !document.getElementById("diff").hidden && document.querySelector('[data-dview="diff"]').classList.contains("on"));
  await k.menu('#unstaged .file[data-path="src/tide.rs"]');
  await k.click("#menu button", "Open in editor");
  await k.until(() => document.querySelector('[data-dview="file"]').classList.contains("on"));
  await k.settle();
  assert.ok(await k.js(() => !document.getElementById("diff").hidden && !document.getElementById("diff-file").hidden));
  // a file deleted since: said, nothing opened
  await k.keys("\uE00C");
  await k.click("#graph .row", "chore: cargo init");
  await k.menu('#commit-files .file[data-path="Cargo.toml"]');
  rmSync(join(repository, "Cargo.toml"));
  await k.click("#menu button", "Open in editor");
  await k.until(() => [...document.querySelectorAll("#toasts .toast.err")].some((t) => t.textContent.includes("Cargo.toml is not in the working tree")));
  execFileSync("git", ["checkout", "--", "Cargo.toml", "src/tide.rs"], { cwd: repository });
  // this file only: the next diffs open as they did
  assert.notEqual(await k.js(() => localStorage.getItem("diff-view")), "file");
  await k.keys("");
});
