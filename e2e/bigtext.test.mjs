import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

let k;
before(async () => {
  const lines = Array.from({ length: 400_000 }, (_, i) => `line ${String(i + 1).padStart(8, "0")} the quick brown fox jumps over the lazy dog`);
  const dir = repo(({ git, commit, write }) => {
    write("big.txt", lines.join("\n") + "\n");
    git("add", ".");
    commit("Add a big file");
    // three lines in near the top: past them every line sits three lower
    lines.splice(10, 0, "new 1", "new 2", "new 3");
    lines[300_002] = "line 00300000 CHANGED";
    write("big.txt", lines.join("\n") + "\n");
    git("add", ".");
    commit("Change it far down");
  });
  k = await launch(dir);
});
after(() => k?.quit());

const bar = () => k.js(() => document.querySelector(".more-bar")?.textContent ?? "");
const line = () => k.js(() => document.querySelector("#diff-editor .editor.modified .line-numbers.active-line-number")?.textContent.trim());

test("a file over 10 MB shows its first part alone, Load more the next; in the Diff view N loads up to a change further down", async () => {
  await k.click("#graph .row", "Change it far down");
  await k.click('#commit-files .file[data-path="big.txt"]');
  // its diff would take seconds: the File view, whatever was picked last
  await k.until(() => document.querySelector("#diff-file .more-bar"));
  assert.match(await bar(), /^10\.0 MB of 2\d\.\d MB shown/);
  // at the end of the text: Ctrl+End there
  await k.click("#diff-file .view-lines");
  await k.keys("\uE009", "\uE010");
  await k.click("#diff-file .more-bar");
  await k.until(() => /^20\.0 MB of/.test(document.querySelector("#diff-file .more-bar")?.textContent ?? ""));
  await k.click('[data-dview="diff"]');
  await k.until(() => document.querySelector("#diff-editor .more-bar"));
  await k.click("#next-change");
  await k.until(async () => document.querySelector("#diff-editor .editor.modified .line-numbers.active-line-number")?.textContent.trim() === "11");
  await k.click("#next-change");
  await k.until(() => document.querySelector("#diff-editor .editor.modified .line-numbers.active-line-number")?.textContent.trim() === "300003");
  assert.match(await bar(), /MB shown/);
  assert.equal(await line(), "300003");
});
