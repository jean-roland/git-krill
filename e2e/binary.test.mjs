import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

let k;
before(async () => {
  const dir = repo(({ dir, git, commit, write }) => {
    // the host's compiler: an ELF on Linux
    const build = (more) => {
      write("tool.c", `#include <stdio.h>\nint shout(const char *s) { return printf("%s!\\n", s); }\n${more}\nint main(void) { return shout("hi") < 0; }\n`);
      execFileSync("cc", ["-O1", "-o", join(dir, "tool"), join(dir, "tool.c")]);
      git("add", ".");
    };
    build("");
    commit("Add the tool");
    build('int whisper(const char *s) { return printf("(%s)\\n", s); }');
    commit("Add whisper()");
  });
  k = await launch(dir);
});
after(() => k?.quit());

test("an executable shows its sections and symbols, then its bytes in hex", async () => {
  await k.click("#graph .row", "Add whisper()");
  await k.click('#commit-files .file[data-path="tool"]');
  const symbols = await k.until(() => document.querySelector('[data-svg="image"]')?.classList.contains("on") && document.querySelector("#diff-editor .view-line") && document.querySelector("#diff-editor").textContent.replace(/\u00a0/g, " "));
  assert.match(symbols, /Elf 64-bit/);
  assert.match(symbols, /Section.*Symbol/s);
  await k.shot("symbols");
  await k.click('[data-svg="text"]');
  await k.until(() => document.querySelector("#diff-editor").textContent.replace(/\u00a0/g, " ").includes("7f 45 4c 46"));
  assert.equal(await k.js(() => document.querySelector("#diff-editor .editor.modified .line-numbers").textContent.trim()), "00000000");
  await k.shot("hex");
});
