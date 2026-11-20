import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { launch, repo } from "./driver.mjs";

let k, gh;
before(async () => {
  const dir = repo(({ dir, git, commit, write }) => {
    write("tide.rs", "fn tide() -> u32 {\n    12\n}\n");
    git("add", ".");
    commit("Start the tide table");
    git("checkout", "-qb", "feature/moon");
    write("tide.rs", "fn tide() -> u32 {\n    // a lunar day\n    12 * 2 + 1\n}\n");
    write("moon.md", "# Moon\n\nPulls the tide.\n");
    git("add", ".");
    commit("Follow the moon");
    git("checkout", "-qb", "docs/tides", "main");
    write("README.md", "# Tides\n");
    git("add", ".");
    commit("Document the tides");
    git("checkout", "-qb", "fix/typo", "main");
    write("tide.rs", "fn tide() -> u32 {\n    12 // hours\n}\n");
    git("add", ".");
    commit("Say what the tide counts");
    git("checkout", "-q", "main");
    git("worktree", "add", "-q", join(dir, "..", "moon"), "feature/moon");
    // the remote as a fetch left it: no network, its server where nothing answers
    git("remote", "add", "origin", "https://github.invalid/krill/tides.git");
    for (const b of ["main", "feature/moon", "docs/tides", "fix/typo"]) git("update-ref", `refs/remotes/origin/${b}`, b);
    git("config", "branch.fix/typo.remote", "origin");
    git("config", "branch.fix/typo.merge", "refs/heads/fix/typo");
    const sha = (b) => git("rev-parse", b).trim();
    gh = join(dir, "..", "gh");
    mkdirSync(gh);
    const at = (day, h) => `2026-01-0${day}T${String(h).padStart(2, "0")}:00:00Z`;
    const pr = (number, branch, title, more) => ({
      number, title, body: "", author: { login: "octo" }, createdAt: at(2, 9), url: `https://github.invalid/krill/tides/pull/${number}`,
      isDraft: false, isCrossRepository: false, headRefName: branch, headRefOid: sha(branch), baseRefName: "main", statusCheckRollup: [], ...more,
    });
    const run = (name, conclusion) => ({ __typename: "CheckRun", name, workflowName: "CI", status: "COMPLETED", conclusion, detailsUrl: "https://github.invalid/krill/tides/actions/1" });
    writeFileSync(join(gh, "prs.json"), JSON.stringify([
      pr(7, "feature/moon", "Follow the moon", { body: "The tide **follows** the moon:\n\n- a lunar day\n- `12 * 2 + 1`", statusCheckRollup: [run("build", "SUCCESS"), run("test", "FAILURE")] }),
      pr(8, "docs/tides", "Document the tides", { isDraft: true, statusCheckRollup: [{ __typename: "CheckRun", name: "build", workflowName: "CI", status: "IN_PROGRESS", conclusion: "" }] }),
      // a fork's main: not this clone's main
      pr(6, "main", "From a fork", { isCrossRepository: true, headRefOid: sha("fix/typo") }),
    ]));
    const user = (login) => ({ login });
    writeFileSync(join(gh, "issues-7-comments.json"), JSON.stringify([{ id: 1, user: user("reef"), body: "Does it hold at neap tide?", created_at: at(3, 10) }]));
    writeFileSync(join(gh, "pulls-7-reviews.json"), JSON.stringify([
      { id: 20, user: user("reef"), body: "", state: "COMMENTED", submitted_at: at(3, 11) },
      { id: 21, user: user("octo"), body: "", state: "COMMENTED", submitted_at: at(3, 12) },
      { id: 22, user: user("reef"), body: "Ship it.", state: "APPROVED", submitted_at: at(4, 9) },
      // one's own draft: no date yet
      { id: 23, user: user("tester"), body: "", state: "PENDING" },
    ]));
    const hunk = "@@ -1,3 +1,4 @@\n fn tide() -> u32 {\n-    12\n+    // a lunar day\n+    12 * 2 + 1";
    writeFileSync(join(gh, "pulls-7-comments.json"), JSON.stringify([
      { id: 30, pull_request_review_id: 20, user: user("reef"), path: "tide.rs", line: 3, original_line: 3, diff_hunk: hunk, body: "Why plus one?", created_at: at(3, 11) },
      { id: 31, in_reply_to_id: 30, pull_request_review_id: 21, user: user("octo"), path: "tide.rs", line: 3, original_line: 3, diff_hunk: hunk, body: "The moon rises later each day.", created_at: at(3, 12) },
    ]));
  });
  k = await launch(dir);
});
after(() => k?.quit());

test("the open pull requests are listed, their numbers on their branches", async () => {
  await k.until(() => document.querySelectorAll('#sidebar [data-key="pulls"] .item').length === 3);
  assert.match(await k.js(() => document.querySelector('#sidebar [data-key="pulls"] .item.draft').textContent), /Document the tides#8/);
  assert.equal(await k.js(() => document.querySelector('#graph .ref[title*="feature/moon"] .pr-n')?.textContent), "#7");
});

test("a pull request shows its checks, description, review thread and files", async () => {
  await k.click('#sidebar [data-key="pulls"] .item', "Follow the moon");
  await k.until(() => !!document.querySelector("#pr-page .thread .reply + .reply"));
  await k.until(() => document.querySelectorAll("#commit-files .file").length === 2);
  const text = await k.js(() => document.getElementById("pr-page").textContent);
  for (const t of ["1 of 2 checks failed", "The tide follows the moon", "Does it hold at neap tide?", "Why plus one?", "The moon rises later each day.", "approved", "started a review, not submitted yet"]) assert.ok(text.includes(t), t);
  assert.ok(!text.includes("NaN"));
  // undated, it comes last in any locale
  assert.match(await k.js(() => [...document.querySelectorAll("#pr-page .card")].pop().textContent), /started a review/);
  await k.shot("pull-request");
});

test("a thread's file opens in the diff, without reverting; Esc steps back out", async () => {
  await k.click("#pr-page .thread a", "tide.rs:3");
  await k.until(() => !document.getElementById("diff").hidden && document.getElementById("diff-path").textContent.includes("tide.rs"));
  await k.until(() => !!document.querySelector("#diff-editor .hunk-bar"));
  assert.equal(await k.js(() => document.querySelector("#diff-editor .hunk-revert")), null);
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("diff").hidden && !document.getElementById("pr").hidden);
  await k.keys("\uE00C");
  await k.until(() => document.getElementById("pr").hidden && !document.getElementById("commit-head").textContent.includes("pull request"));
});

test("a fork's pull request from a branch named like one here still checks out", async () => {
  await k.menu('#sidebar [data-key="pulls"] .item', "From a fork");
  assert.equal(await k.js(() => [...document.querySelectorAll("#menu button")].find((b) => b.textContent === "Checkout branch").classList.contains("off")), false);
  await k.keys("\uE00C");
});

test("a pull request's last commit shows in the graph", async () => {
  await k.click('#sidebar [data-key="pulls"] .item', "Follow the moon");
  await k.click("#pr-graph");
  await k.until(() => document.getElementById("pr").hidden && document.querySelector("#graph .row.sel")?.textContent.includes("Follow the moon"));
});

test("a draft pull request comes from a branch's menu, its title from the last commit", async () => {
  await k.menu("#graph .ref", "fix/typo");
  await k.click("#menu button", "Create pull request");
  assert.equal(await k.js(() => document.querySelector("#dialog input").value), "Say what the tide counts");
  await k.type("#dialog textarea", "Hours, not tides.");
  await k.click("#dialog button", "Create draft");
  await k.until(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Created pull request #9")));
  const args = JSON.parse(readFileSync(join(gh, "created"), "utf8"));
  for (const a of ["--head=fix/typo", "--title=Say what the tide counts", "--body=Hours, not tides.", "--draft"]) assert.ok(args.includes(a), a);
});

test("a pull request checks out from its page, its button then greyed with why", async () => {
  await k.click('#sidebar [data-key="pulls"] .item', "Document the tides");
  await k.click("#pr-checkout");
  await k.until(() => document.getElementById("branch").textContent === "docs/tides");
  await k.until(() => document.getElementById("pr-checkout").disabled && document.getElementById("pr-checkout").title === "docs/tides is checked out already");
});

test("a running check's page asks again on its own, its card redrawn unfolded as it was", async () => {
  await k.click("#pr-page details.checks summary");
  const prs = JSON.parse(readFileSync(join(gh, "prs.json"), "utf8"));
  Object.assign(prs.find((p) => p.number === 8).statusCheckRollup[0], { status: "COMPLETED", conclusion: "SUCCESS" });
  writeFileSync(join(gh, "prs.json"), JSON.stringify(prs));
  // asked every 30 s
  await new Promise((r) => setTimeout(r, 20_000));
  await k.until(() => document.querySelector("#pr-page details.checks summary.pass")?.parentElement.open);
});

test("Refresh asks the page again: a new comment shows", async () => {
  writeFileSync(join(gh, "issues-8-comments.json"), JSON.stringify([{ id: 9, user: { login: "reef" }, body: "It holds at neap tide.", created_at: "2026-01-05T10:00:00Z" }]));
  await k.click("#pr-refresh");
  await k.until(() => document.getElementById("pr-page").textContent.includes("It holds at neap tide."));
});

test("a pull request whose branch another worktree has opens that worktree, its page still open", async () => {
  await k.click('#sidebar [data-key="pulls"] .item', "Follow the moon");
  await k.until(() => !!document.querySelector("#pr-page .thread"));
  await k.menu('#sidebar [data-key="pulls"] .item', "Follow the moon");
  const lists = () => readFileSync(join(gh, "calls"), "utf8").split("\n").filter((l) => l.startsWith("pr list")).length;
  const asked = lists();
  assert.match(await k.js(() => [...document.querySelectorAll("#menu button")].find((b) => b.textContent === "Checkout branch").title), /checked out in the worktree .*moon: this opens it/);
  await k.click("#menu button", "Checkout branch");
  await k.until(() => document.getElementById("branch").textContent === "feature/moon");
  await k.until(() => !document.getElementById("pr").hidden && document.getElementById("pr-checkout").disabled && document.querySelector("#pr-page h1")?.textContent.includes("#7"));
  // checked out here, in a worktree: its icon stays
  assert.ok(await k.js(() => !!document.querySelector("#pr-checkout .ico")));
  // the worktree's list is the repository's, asked a moment ago
  await k.settle();
  assert.equal(lists(), asked);
});

test("signed out, the section says to sign in; signed in again, the next look lists the pull requests", async () => {
  writeFileSync(join(gh, "signed-out"), "");
  await k.click("#pr-refresh");
  await k.until(() => document.querySelector('#sidebar [data-key="pulls"] .item.off')?.textContent.includes("gh auth login"));
  rmSync(join(gh, "signed-out"));
  // back to the window: gh is asked again at once, not a minute later
  await k.js(() => dispatchEvent(new Event("focus")));
  await k.until(() => document.querySelectorAll('#sidebar [data-key="pulls"] .item:not(.off)').length === 3);
});
