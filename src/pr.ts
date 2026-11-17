// Pull requests through gh: the sidebar's list, their numbers on branch labels, a pull request's page with its files, and new ones.
import { invoke } from "@tauri-apps/api/core";
import { openDiff } from "./diff";
import { jumpTo, openWorktree, webUrl, worktreeOf } from "./graph";
import { renderPanel } from "./panel";
import { Change, commits, fakeCommit, findRef, gitOp, redraw, refs, repo, run, runFixed, selection, status } from "./repo";
import { $, ICONS, MenuItem, copy, dateTimeText, dialog, esc, h, ico, label, popup, say, svg, toast } from "./ui";

type Check = { name?: string; context?: string; workflowName?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string };
export type Pr = {
  number: number; title: string; body: string; author: User; createdAt: string; url: string; isDraft: boolean; isCrossRepository: boolean;
  headRefName: string; headRefOid: string; baseRefName: string; statusCheckRollup: Check[];
};
type User = { login: string } | null;
// the REST answers: their ids tie review comments to their review
type Review = { id: number; user: User; body: string; state: string; submitted_at: string };
type Note = { id: number; user: User; body: string; created_at: string };
type Inline = Note & { in_reply_to_id?: number; pull_request_review_id: number; path: string; line: number | null; original_line: number | null; diff_hunk: string };

const FIELDS = "number,title,body,author,createdAt,url,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,statusCheckRollup";
const HELP: Record<string, string> = {
  "gh-missing": "Install the GitHub CLI (gh) for pull requests",
  "gh-auth": "Sign in to the GitHub CLI (gh auth login) for pull requests",
  "no-remote": "No remote to ask for pull requests",
  "no-github": "Pull requests come from GitHub remotes",
  loading: "Asking gh for pull requests",
};

// per repository: the remote pull requests go to, as host/owner/name for gh, its open ones, or why gh could not list them
type Pulls = { remote: string; slug: string; list: Pr[]; why: string };
const pulls = new Map<string, Pulls>();
export const pullsHere = () => pulls.get(repo);
// gh's answer for each GitHub repository and when: worktrees and tabs of one share it for a minute
const asked = new Map<string, { at: number; got: Pr[] | string }>();

/** The open pull requests of upstream in a fork, else origin, else the first remote: gh's last answer for it, unless `fresh` or a minute old; the sidebar and labels repaint when they changed. */
export async function loadPrs(fresh = false) {
  const r = repo, remote = ["upstream", "origin"].find((x) => refs.remotes.includes(x)) ?? refs.remotes[0] ?? "";
  const m = remote ? (await webUrl(remote).catch(() => "")).match(/^https:\/\/([^/]+)\/(.+)$/) : null;
  if (r !== repo) return;
  const slug = m ? `${m[1]}/${m[2]}` : "";
  const hit = asked.get(slug);
  const got = !m
    ? remote ? "no-github" : "no-remote"
    : !fresh && hit && Date.now() - hit.at < 60_000
      ? hit.got
      : await run<string>("gh", { args: ["pr", "list", "-R", slug, "--limit", "100", "--json", FIELDS] }, true).then((out) => JSON.parse(out) as Pr[], (e) => String(e));
  if (m && got !== hit?.got) asked.set(slug, { at: Date.now(), got });
  const was = pulls.get(r);
  // offline: the last list stays; a server that is no GitHub says so plainly
  if (r !== repo || (typeof got === "string" && !HELP[got] && was?.list.length)) return;
  const why = typeof got !== "string" ? "" : HELP[got] ? got : /github|ghe\./i.test(slug) ? got.split("\n")[0] : "no-github";
  const now: Pulls = { remote, slug, list: typeof got === "string" ? [] : got, why };
  if (JSON.stringify(now) === JSON.stringify(was)) return;
  pulls.set(r, now);
  redraw();
}

const FAILED = /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED|STARTUP_FAILURE/;
/** A check's outcome: a status's state, else a run's conclusion once it completed. */
const outcome = (c: Check) => c.state ?? (c.status === "COMPLETED" ? (c.conclusion ?? "") : "PENDING");
const outcomeClass = (o: string) => (FAILED.test(o) ? "fail" : /PENDING|EXPECTED/.test(o) ? "wait" : o === "SUCCESS" ? "pass" : "skip");

/** The checks of `pr` in one word, icon and line: any failed, else any running, else passed. */
function checksSum(pr: Pr): [string, string, string] {
  const all = pr.statusCheckRollup ?? [], out = all.map(outcome);
  const failed = out.filter((o) => FAILED.test(o)).length, waiting = out.filter((o) => /PENDING|EXPECTED/.test(o)).length;
  if (!all.length) return ["", "", "No checks"];
  if (failed) return ["fail", ICONS.close, `${failed} of ${all.length} checks failed`];
  if (waiting) return ["wait", ICONS.dot, `${waiting} of ${all.length} checks running`];
  return ["pass", ICONS.check, `${all.length} checks passed`];
}

/** The sidebar's pull requests, or why there are none. */
export function prRows() {
  const p = pulls.get(repo);
  if (!p) return [];
  if (p.why) return [h("div", { className: "item off", title: HELP[p.why] ?? p.why }, ico(ICONS.info), h("span", { className: "label", textContent: HELP[p.why] ?? p.why }))];
  return p.list.map((pr) => {
    const [cls, icon, checks] = checksSum(pr);
    return h(
      "div",
      {
        className: `item${pr.isDraft ? " draft" : ""}`,
        title: `#${pr.number} ${pr.title}${pr.isDraft ? " (draft)" : ""}\n${pr.author?.login}: ${pr.headRefName} → ${pr.baseRefName}\n${checks}`,
        onclick: () => openPr(pr),
        ondblclick: () => checkoutPr(pr),
        oncontextmenu: (e: MouseEvent) => popup(e, prMenu(pr)),
      },
      ...(cls ? [h("span", { className: `ico checks ${cls}`, innerHTML: svg(icon) })] : []),
      ico(ICONS.pr),
      h("span", { className: "label", textContent: pr.title }),
      h("small", { textContent: `#${pr.number}` }),
    );
  });
}

const openUrl = (url: string) => invoke("open_url", { url }).catch((e) => say(String(e), true));
// git checks a branch out in one worktree only: the one that has it opens instead
async function checkoutPr(pr: Pr) {
  const wt = worktreeOf(pr.headRefName), p = pulls.get(repo);
  if (!wt) return pr.headRefName === status?.branch || gitOp("pr-checkout", [String(pr.number), p!.slug]);
  // the page stays, as over a checkout here: the worktree shares the remotes, so their list too until its own comes
  if (p && !pulls.has(wt.path)) pulls.set(wt.path, p);
  carried = true;
  try {
    await openWorktree(wt.path);
  } finally {
    carried = false;
  }
}
// a checkout moving the page to another worktree's tab: the tab switch leaves it open
let carried = false;
/** Why `pr`'s checkout is greyed, or where it goes: its branch checked out here, in another worktree, or not yet. */
function checkoutWhy(pr: Pr): [boolean, string, string | undefined] {
  const wt = worktreeOf(pr.headRefName);
  if (pr.headRefName === status?.branch) return [true, `${pr.headRefName} is checked out already`, undefined];
  return wt ? [false, `${pr.headRefName} is checked out in the worktree ${wt.path}: this opens it`, ICONS.worktree] : [false, `Check out ${pr.headRefName}`, undefined];
}

function prMenu(pr: Pr): MenuItem[] {
  const [here, why, icon] = checkoutWhy(pr);
  return [
    { title: `#${pr.number} ${pr.title}`, icon: ICONS.pr },
    ["Open", () => openPr(pr)],
    ["Checkout branch", here ? null : () => checkoutPr(pr), why, icon],
    ["Open in browser", () => openUrl(pr.url)],
    null,
    ["Copy link", () => copy(pr.url)],
    ["Copy branch name", () => copy(pr.headRefName)],
  ];
}

/** The open pull request from branch `name` at commit `hash`: a fork's only on its own commit, its branch name being anyone's. */
export const prOf = (name: string, hash: string) => pulls.get(repo)?.list.find((p) => p.headRefName === name && (!p.isCrossRepository || p.headRefOid === hash));

export const prChip = (pr: Pr) =>
  h("span", {
    className: "pr-n",
    textContent: `#${pr.number}`,
    title: `Pull request #${pr.number}: ${pr.title}`,
    onclick: (e: MouseEvent) => (e.stopPropagation(), openPr(pr)),
    ondblclick: (e: MouseEvent) => e.stopPropagation(),
  });

/** A branch menu's pull request item: its open one, else a new one from a local branch, greyed with the reason it cannot be. */
export function prItems(name: string, remote: boolean, hash: string): MenuItem[] {
  const p = pulls.get(repo), pr = prOf(remote ? name.slice(name.indexOf("/") + 1) : name, hash);
  if (pr) return [[`Open pull request #${pr.number}`, () => openPr(pr)]];
  if (remote) return [];
  // the current branch is pushed on the way: another one would need its own checkout
  const why = !p ? HELP.loading : p.why ? (HELP[p.why] ?? p.why) : pushed(name) || name === status?.branch ? "" : "Check it out and push it first";
  return [["Create pull request…", why ? null : () => createPr(name), why]];
}

/** The section's +: a pull request from the checked out branch, its open one if any, else why not. */
export function newPr() {
  const b = status?.branch, item = b ? prItems(b, false, findRef(`refs/heads/${b}`)?.hash ?? "")[0] : null;
  if (Array.isArray(item) && typeof item[1] === "function") return item[1]();
  toast("No pull request to create", Array.isArray(item) ? (item[2] ?? "") : "Check out a branch first.", "info");
}

/** Whether local `branch` is on its upstream, all of it. */
const pushed = (branch: string) => {
  const r = findRef(`refs/heads/${branch}`);
  return !!r?.upstream && !/ahead|gone/.test(r.track);
};

/** `gh pr create` from local `branch`, pushed first when the server lacks it; title and description from its last commit. */
function createPr(branch: string) {
  const p = pulls.get(repo)!, tip = commits.find((c) => c.hash === findRef(`refs/heads/${branch}`)?.hash);
  const make = async ([title, body, base]: string[], draft: boolean) => {
    if (!title) return;
    if (!pushed(branch)) {
      const r = findRef(`refs/heads/${branch}`);
      const ok = r?.upstream && r.track !== "[gone]" ? await gitOp("push") : await gitOp("push-upstream", [refs.remotes.includes("origin") ? "origin" : p.remote, branch]);
      if (!ok) return;
    }
    const up = findRef(`refs/heads/${branch}`)?.upstream ?? "", slash = up.indexOf("/"), remote = up.slice(0, slash);
    try {
      // from a fork: its owner names the branch
      const owner = remote === p.remote ? "" : `${(await webUrl(remote)).split("/").slice(-2)[0]}:`;
      const args = ["pr", "create", "-R", p.slug, `--head=${owner}${up.slice(slash + 1)}`, `--title=${title}`, `--body=${body}`, ...(base ? [`--base=${base}`] : []), ...(draft ? ["--draft"] : [])];
      const url = (await run<string>("gh", { args })).trim();
      toast(`Created pull request #${url.match(/\/pull\/(\d+)/)?.[1] ?? ""}`, url, "info");
      loadPrs(true);
    } catch (e) {
      toast("Create pull request failed", HELP[String(e)] ?? String(e), "err");
    }
  };
  dialog(
    `Create a pull request from ${branch}`,
    [["Title", tip?.subject ?? branch], ["Description", tip?.body ?? "", "textarea"], ["Base branch (empty: the default branch)", ""]],
    "Create",
    (v) => make(v, false),
    [["Create draft", (v) => make(v, true)]],
  );
}

// the pull request on show
let onShow: Pr | null = null;

/** A pull request's page in the middle, its changed files in the panel: from where it left its base branch to its head. */
export async function openPr(pr: Pr) {
  const p = pulls.get(repo), r = repo;
  if (!p || (onShow?.number === pr.number && !$("pr").hidden)) return;
  onShow = pr;
  $("pr").hidden = false;
  $("pr-title").replaceChildren(ico(ICONS.pr), `Pull request #${pr.number}`);
  $("pr-checkout").onclick = () => checkoutPr(pr);
  $("pr-web").onclick = () => openUrl(pr.url);
  $("pr-graph").onclick = () => jumpTo(pr.headRefOid);
  paintPrBar();
  showPage(pr, `<p class="dim">Loading…</p>`);
  run<string>("pr_base", { remote: p.remote, number: pr.number, head: pr.headRefOid, base: pr.baseRefName }).then(
    (base) => {
      if (onShow?.number !== pr.number || r !== repo) return;
      selection.pr = { number: pr.number, hash: pr.headRefOid, base, title: pr.title };
      renderPanel();
    },
    (e) => toast(`Files of #${pr.number} not found`, String(e), "err"),
  );
  const slash = p.slug.indexOf("/");
  const api = <T>(path: string) => run<string>("gh", { args: ["api", "--hostname", p.slug.slice(0, slash), `repos/${p.slug.slice(slash + 1)}/${path}?per_page=100`] }, true).then((o) => JSON.parse(o) as T);
  try {
    // ponytail: the first 100 of each, --paginate's pages would need --slurp, newer than some distributions' gh
    const [reviews, notes, inline] = await Promise.all([api<Review[]>(`pulls/${pr.number}/reviews`), api<Note[]>(`issues/${pr.number}/comments`), api<Inline[]>(`pulls/${pr.number}/comments`)]);
    if (onShow?.number === pr.number && r === repo) showPage(pr, await pageOf(pr, reviews, notes, inline));
  } catch (e) {
    if (onShow?.number === pr.number && r === repo) showPage(pr, `<p>${esc(HELP[String(e)] ?? String(e))}</p>`);
  }
}

/** The page's buttons as the checkout stands: after any refresh, a checkout's own among them. */
export function paintPrBar() {
  const pr = onShow;
  if (!pr || $("pr").hidden) return;
  const [here, why, icon] = checkoutWhy(pr), b = $("pr-checkout") as HTMLButtonElement;
  label(b, ICONS.check, "Checkout");
  if (icon) b.append(ico(icon));
  Object.assign(b, { disabled: here, title: why });
  // a fork's head may be in no loaded branch
  const shown = commits.some((c) => c.hash === pr.headRefOid);
  Object.assign($("pr-graph"), { disabled: !shown, title: shown ? "Show its last commit in the graph" : "Its last commit is in no branch here: check it out first" });
}

/** Back to the graph; `paint` the panel's own pick again. */
export function closePr(paint = true) {
  if ($("pr").hidden || carried) return;
  $("pr").hidden = true;
  onShow = null;
  selection.pr = null;
  if (paint) renderPanel();
}

const VERBS: Record<string, [string, string]> = { APPROVED: ["approved", "good"], CHANGES_REQUESTED: ["requested changes", "bad"], DISMISSED: ["reviewed (dismissed)", ""] };
const MARKS: Record<string, string> = { pass: "✓", fail: "✗", wait: "●", skip: "–" };

/** The page of `pr`: its checks, description, then its comments and reviews by time, each review with its threads on the code. */
async function pageOf(pr: Pr, reviews: Review[], notes: Note[], inline: Inline[]) {
  const { lexer, parser } = await import("monaco-editor/esm/vs/base/common/marked/marked.js");
  // a line break is one, as on the server
  // cleaned alone, closed: a stray end tag cannot leave its box
  const md = (text: string) => `<div class="md">${clean(parser(lexer(text ?? "", { gfm: true, breaks: true }), { gfm: true, breaks: true }), pr.url, false).innerHTML}</div>`;
  const when = (iso: string) => dateTimeText(Date.parse(iso) / 1000);
  const who = (u: User) => `<b>${esc(u?.login ?? "ghost")}</b>`;
  const roots = inline.filter((c) => !c.in_reply_to_id);
  const thread = (c: Inline) => {
    // the lines above the comment, as the server shows them
    const hunk = c.diff_hunk.split("\n").slice(-4).map((l) => `<span class="${l[0] === "+" ? "add" : l[0] === "-" ? "del" : ""}">${esc(l)}</span>`).join("\n");
    const line = c.line ?? c.original_line, replies = [c, ...inline.filter((x) => x.in_reply_to_id === c.id)];
    return `<div class="thread"><div class="where"><a data-file="${esc(c.path)}">${esc(c.path)}${line ? `:${line}` : ""}</a>${c.line === null ? ' <span class="dim">outdated</span>' : ""}</div><pre class="hunk">${hunk}</pre>${replies.map((x) => `<div class="reply"><div class="who">${who(x.user)} · ${when(x.created_at)}</div>${md(x.body)}</div>`).join("")}</div>`;
  };
  const items: [string, string][] = [
    ...notes.map((n): [string, string] => [n.created_at, `<div class="card"><div class="who">${who(n.user)} commented · ${when(n.created_at)}</div>${md(n.body)}</div>`]),
    ...reviews.flatMap((rv): [string, string][] => {
      const threads = roots.filter((c) => c.pull_request_review_id === rv.id);
      // a reply's own review: the reply shows in its thread
      if (!rv.body && !threads.length && rv.state === "COMMENTED") return [];
      const [verb, cls] = VERBS[rv.state] ?? ["reviewed", ""];
      return [[rv.submitted_at, `<div class="card"><div class="who">${who(rv.user)} <span class="${cls}">${verb}</span> · ${when(rv.submitted_at)}</div>${rv.body ? md(rv.body) : ""}${threads.map(thread).join("")}</div>`]];
    }),
    // threads whose review is not listed
    ...roots.filter((c) => !reviews.some((rv) => rv.id === c.pull_request_review_id)).map((c): [string, string] => [c.created_at, `<div class="card">${thread(c)}</div>`]),
  ];
  items.sort(([a], [b]) => a.localeCompare(b));
  const [cls, , sum] = checksSum(pr);
  const checks = (pr.statusCheckRollup ?? []).map((c) => {
    const o = outcome(c), name = esc([c.workflowName, c.name ?? c.context].filter(Boolean).join(" / ")), url = c.detailsUrl ?? c.targetUrl;
    return `<li class="${outcomeClass(o)}"><span class="mark">${MARKS[outcomeClass(o)]}</span>${url ? `<a href="${esc(url)}">${name}</a>` : name} <span class="dim">${esc(o.toLowerCase().replace(/_/g, " "))}</span></li>`;
  });
  return [
    `<h1>${esc(pr.title)} <span class="dim">#${pr.number}</span></h1>`,
    `<p><span class="state${pr.isDraft ? " draft" : ""}">${pr.isDraft ? "Draft" : "Open"}</span> ${who(pr.author)} wants to merge into <code>${esc(pr.baseRefName)}</code> from <code>${esc(pr.headRefName)}</code></p>`,
    checks.length ? `<details class="card checks"${cls === "fail" ? " open" : ""}><summary class="who ${cls}">${sum}</summary><ul>${checks.join("")}</ul></details>` : "",
    `<div class="card"><div class="who">${who(pr.author)} opened · ${when(pr.createdAt)}</div>${md(pr.body || "*No description provided.*")}</div>`,
    ...items.map(([, x]) => x),
  ].join("");
}

// the tags a comment may use, as on the server: another one leaves its text, those in GONE leave nothing
const TAGS = new Set("a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img input ins kbd li ol p pre q s samp small span strike strong sub summary sup table tbody td tfoot th thead tr tt ul".split(" "));
const GONE = new Set("script style template iframe frame frameset object embed noscript svg math textarea select button form title".split(" "));
// the attributes each keeps: no id, event, style or source of its own; class only in the page's own markup
const ATTRS: Record<string, string[]> = { a: ["href", "data-file"], img: ["src", "alt", "width", "height"], td: ["align", "colspan", "rowspan"], th: ["align", "colspan", "rowspan"], ol: ["start"], details: ["open"], input: ["type", "checked"] };

/** `html` down to formatting, its links made absolute from `base`: comments are anyone's, so no script, style, form, id or remote load gets through. */
function clean(html: string, base: string, classes: boolean) {
  const body = new DOMParser().parseFromString(html, "text/html").body;
  // innermost first: a tag unwrapped keeps children already cleaned
  for (const el of [...body.querySelectorAll("*")].reverse()) {
    const tag = el.localName;
    if (GONE.has(tag)) el.remove();
    else if (!TAGS.has(tag)) el.replaceWith(...el.childNodes);
    else for (const a of [...el.attributes]) if (!(classes && a.name === "class") && !ATTRS[tag]?.includes(a.name)) el.removeAttribute(a.name);
  }
  // only pictures carried in the text: a remote one would tell its server who reads
  body.querySelectorAll("img").forEach((i) => /^data:image\//.test(i.getAttribute("src") ?? "") || i.removeAttribute("src"));
  body.querySelectorAll("input").forEach((i) => (i.getAttribute("type") === "checkbox" ? i.setAttribute("disabled", "") : i.remove()));
  body.querySelectorAll("a[href]").forEach((a) => {
    let url = "";
    try {
      url = new URL(a.getAttribute("href")!, `${base}/`).href;
    } catch {}
    if (/^https?:/.test(url)) a.setAttribute("href", url);
    else a.removeAttribute("href");
  });
  return body;
}

/** `html`, the page's own markup around comments cleaned on their own, on the page. */
function showPage(pr: Pr, html: string) {
  $("pr-page").replaceChildren(h("div", { className: "pr-in" }, ...clean(html, pr.url, true).childNodes));
}

/** A click on the page: a link opens in the browser, never in the window; a thread's file in the diff. */
export function followPrLink(e: MouseEvent) {
  const a = (e.target as Element).closest("a");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.file) openPrFile(a.dataset.file);
  else if (a.href && e.type === "click") openUrl(a.href);
}

/** The diff of `path` as the pull request changes it. */
async function openPrFile(path: string) {
  const s = selection.pr;
  if (!s) return say("The pull request's files are still loading", true);
  const info = await runFixed<{ files: Change[] }>("commit_info", { hash: s.hash, parent: s.base });
  const f = info.files.find((x) => x.path === path);
  if (f) openDiff("commit", f, fakeCommit(s.hash, [s.base], s.title));
  else say(`${path} is no longer changed by the pull request`, true);
}
