import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { demo, launch } from "./driver.mjs";

let k;
before(async () => (k = await launch(`${demo()}/tidepool`)));
after(() => k?.quit());

test("the graph shows the history with its branches and tags", async () => {
  const rows = await k.until(() => document.querySelectorAll("#graph .row").length > 20 && document.querySelectorAll("#graph .row").length);
  assert.ok(rows >= 25, `${rows} rows`);
  const labels = await k.js(() => [...document.querySelectorAll("#graph .row .label, #graph .row .ref")].map((e) => e.textContent.trim()).join(" "));
  for (const l of ["main", "v0.1.0", "v0.2.0"]) assert.match(labels, new RegExp(l.replace(".", "\\.")));
  await k.shot("graph");
});
