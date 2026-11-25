import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

const old = `class DescHandler {
  public:
    static void load_desc(QFile &file, QList<Command *> &cmdArray, QString &protocolName, QString &protocolId,
        QString &protocolVersion, QString &protocolDesc);
};
`;
// a parameter in mid-line, the rest pushed onto the next line; a line of its own added
const now = `class DescHandler {
  public:
    static void load_desc(QFile &file, QList<Command *> &cmdArray, QList<Attribute *> &structArray,
        QString &protocolName, QString &protocolId, QString &protocolVersion, QString &protocolDesc);
    static void clear_desc();
};
`;

let k;
before(async () => {
  const dir = repo(({ git, commit, write }) => {
    write("desc.h", old);
    git("add", ".");
    commit("Declare the loader");
    write("desc.h", now);
  });
  k = await launch(dir);
});
after(() => k?.quit());

test("a whole added line has a lighter text tint than a change running on from mid-line", async () => {
  await k.click("#unstaged .file", "desc.h");
  const whole = '#diff-editor .char-insert[style^="left:0px;width:100%"]', part = '#diff-editor .char-insert:not([style^="left:0"])[style*="width:100%"]';
  await k.until((whole, part) => document.querySelector(whole) && document.querySelector(part), whole, part);
  const [a, b] = await k.js((whole, part) => [whole, part].map((css) => getComputedStyle(document.querySelector(css)).backgroundColor), whole, part);
  const alpha = (c) => Number(c.match(/([\d.]+)\)$/)[1]);
  assert.ok(alpha(a) < alpha(b), `${a} vs ${b}`);
});
