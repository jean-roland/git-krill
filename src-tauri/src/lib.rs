mod askpass;
mod pty;

use serde::Serialize;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;

#[derive(Serialize)]
struct Commit {
    hash: String,
    parents: Vec<String>,
    author: String,
    time: i64,
    refs: Vec<String>,
    subject: String,
    body: String,
}

#[derive(Serialize)]
struct Change {
    path: String,
    old: Option<String>,
    code: String,
    // an unmerged path's two-letter status: UU, AA, DU...
    #[serde(skip_serializing_if = "Option::is_none")]
    conflict: Option<String>,
    // git-lfs stores it
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    lfs: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpInfo {
    state: String,
    current: String,
    incoming: String,
    // short hashes of the two sides
    current_commit: String,
    incoming_commit: String,
    // "1/3" while rebasing
    step: String,
    // what Continue commits
    message: String,
}

#[derive(Serialize)]
struct Status {
    branch: String,
    state: String,
    ahead: Option<u32>,
    behind: Option<u32>,
    staged: Vec<Change>,
    unstaged: Vec<Change>,
}

#[derive(Serialize)]
struct CommitInfo {
    message: String,
    email: String,
    // git's %G?: G good, U good from an untrusted key, E no key here to check, B bad, X/Y expired, R revoked, N unsigned
    sign: String,
    files: Vec<Change>,
}

#[derive(Serialize)]
struct Ref {
    name: String,
    hash: String,
    upstream: String,
    track: String,
}

#[derive(Serialize)]
struct Stash {
    name: String,
    hash: String,
    parents: Vec<String>,
    subject: String,
}

#[derive(Serialize)]
struct Submodule {
    name: String,
    path: String,
    url: String,
    // the commit HEAD records, empty before the first commit that adds it
    recorded: String,
    // the commit checked out in it, empty when not initialized
    head: String,
    // changes to its tracked files, untracked files in it
    modified: bool,
    untracked: bool,
    // its checkout against the recorded commit, when it differs and both are known
    ahead: Option<u32>,
    behind: Option<u32>,
}

#[derive(Serialize)]
struct Worktree {
    path: String,
    head: String,
    // empty when detached
    branch: String,
    locked: bool,
    // its folder is gone: `git worktree prune` drops it
    prunable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Refs {
    refs: Vec<Ref>,
    stashes: Vec<Stash>,
    remotes: Vec<String>,
    // the main worktree first
    worktrees: Vec<Worktree>,
    submodules: Vec<Submodule>,
    // the repository this one is a submodule of, empty when none
    superproject: String,
    // the repo tool's top folder when this is one of its checkouts, else empty
    repo_top: String,
    // git-lfs has run here
    lfs: bool,
}

#[derive(Serialize)]
struct Blob {
    text: String,
    exists: bool,
    binary: bool,
    // too big to load unasked: its size in bytes
    large: Option<u64>,
    // a git-lfs pointer in git: "here" when its object was read instead, "missing" when it is not downloaded
    lfs: &'static str,
}

/// \brief A git command in `repo`; with `ask`, ssh and https prompts reach krill's dialog, without they fail at once and say so.
fn git_command(repo: &str, args: &[&str], ask: bool) -> Command {
    let mut git = Command::new("git");
    git.current_dir(repo)
        .args(args)
        // never block on an editor or a credential prompt: there is no tty
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        // paths from the UI are names, not globs: `f[12].c` must not also match f1.c
        .env("GIT_LITERAL_PATHSPECS", "1");
    askpass::env(&mut git, ask);
    // its own session, off the terminal krill may run from: ssh would wait there for a key passphrase
    unsafe { git.pre_exec(|| (libc::setsid() >= 0).then_some(()).ok_or_else(std::io::Error::last_os_error)) };
    git
}

/// \brief Run git, `input` on its stdin.
fn git_cmd(repo: &str, args: &[&str], input: Option<&[u8]>, ask: bool) -> Result<Output, String> {
    let mut git = git_command(repo, args, ask);
    git.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = git.spawn().map_err(|e| e.to_string())?;
    if let Some(data) = input {
        child.stdin.take().unwrap().write_all(data).map_err(|e| e.to_string())?;
    }
    // off the async pool while it waits: a fetch can hang for minutes on a dead network
    tokio::task::block_in_place(|| child.wait_with_output()).map_err(|e| e.to_string())
}

/// \brief All git said, stdout then stderr.
fn output_text(out: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string()
}

/// \brief All git said, as the error when it failed.
fn report(out: Output) -> Result<String, String> {
    if out.status.success() { Ok(output_text(&out)) } else { Err(output_text(&out)) }
}

/// \brief Git's stdout; all it said is the error.
fn git_bytes(repo: &str, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let out = git_cmd(repo, args, input, true)?;
    if out.status.success() { Ok(out.stdout) } else { Err(output_text(&out)) }
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    git_bytes(repo, args, None).map(|o| String::from_utf8_lossy(&o).into_owned())
}

/// \brief Like `git` but keeps stderr on success too: push and fetch report there.
fn git_with_stderr(repo: &str, args: &[&str]) -> Result<String, String> {
    report(git_cmd(repo, args, None, true)?)
}

/// \brief Let a launched app run on its own; reaped so it does not linger as a zombie.
fn reap(mut child: std::process::Child) {
    std::thread::spawn(move || child.wait());
}

/// \brief Repo-relative path, refusing anything that escapes the work tree.
fn work_path(repo: &str, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| c == Component::ParentDir) {
        return Err(format!("bad path {path}"));
    }
    Ok(Path::new(repo).join(p))
}

/// \brief `work_path` of a file that must be there.
fn existing_path(repo: &str, path: &str) -> Result<PathBuf, String> {
    let p = work_path(repo, path)?;
    if p.exists() { Ok(p) } else { Err(format!("{path} is not in the working tree")) }
}

/// \brief Refs, hashes, remote names and URLs from the UI, refusing option injection.
fn not_option(arg: &str) -> Result<&str, String> {
    if arg.is_empty() || arg.starts_with('-') {
        return Err(format!("bad rev {arg}"));
    }
    Ok(arg)
}

/// \brief The repository's git folder: a linked worktree's, or the repo tool's, is elsewhere.
fn git_dir(repo: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(repo, &["rev-parse", "--absolute-git-dir"])?.trim()))
}

fn current_branch(repo: &str) -> Result<String, String> {
    Ok(git(repo, &["branch", "--show-current"])?.trim().to_string())
}

/// \brief A commit from the log fields hash, parents, author and time; the caller fills the rest.
fn commit_of(f: &[&str]) -> Commit {
    Commit {
        hash: f[0].to_string(),
        parents: f[1].split_whitespace().map(String::from).collect(),
        author: f[2].to_string(),
        time: f[3].parse().unwrap_or(0),
        refs: Vec::new(),
        subject: String::new(),
        body: String::new(),
    }
}

fn op_state(repo: &str) -> Result<String, String> {
    let dir = git_dir(repo)?;
    let state = [
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .iter()
    .find(|(f, _)| dir.join(f).exists())
    .map_or("", |(_, s)| s);
    Ok(state.to_string())
}

#[tauri::command]
fn initial_repo() -> String {
    std::env::args().nth(1).unwrap_or_default()
}

#[tauri::command(async)]
fn init(path: String) -> Result<String, String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    git(&path, &["init"])
}

/// \brief Clone `url` into `parent`/`name`, creating `parent` if needed; returns the new work tree.
#[tauri::command(async)]
fn clone(parent: String, url: String, name: String) -> Result<String, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(format!("bad folder name {name}"));
    }
    let parent = parent.strip_prefix("~/").map_or(parent.clone(), |p| format!("{}/{p}", std::env::var("HOME").unwrap_or_default()));
    std::fs::create_dir_all(&parent).map_err(|e| format!("{parent}: {e}"))?;
    git(&parent, &["clone", "--", &url, &name])?;
    Ok(Path::new(&parent).join(&name).to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn refs(repo: String) -> Result<Refs, String> {
    let remotes: Vec<String> = git(&repo, &["remote"])?.lines().map(String::from).collect();
    // refs/remotes/<x>/ of no configured remote: the `repo` tool's m/<branch> pointer
    let stray = |name: &str| name.strip_prefix("refs/remotes/").is_some_and(|r| !remotes.iter().any(|m| r.starts_with(&format!("{m}/"))));
    let out = git(&repo, &["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(upstream:track)",
                           "refs/heads", "refs/remotes", "refs/tags"])?;
    let refs = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            // annotated tags point at the tag object, the commit is the peeled one
            (f.len() == 5 && !f[0].ends_with("/HEAD") && !stray(f[0])).then(|| Ref {
                name: f[0].to_string(),
                hash: if f[2].is_empty() { f[1] } else { f[2] }.to_string(),
                upstream: f[3].to_string(),
                track: f[4].to_string(),
            })
        })
        .collect();
    let out = git(&repo, &["stash", "list", "--format=%gd%x00%H%x00%P%x00%gs"])?;
    let stashes = out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            (f.len() == 4).then(|| Stash {
                name: f[0].to_string(),
                hash: f[1].to_string(),
                parents: f[2].split_whitespace().map(String::from).collect(),
                // the message alone: git prefixes "On <branch>: " (or "WIP on"), and a refname holds no ':'
                subject: f[3].split_once(": ").filter(|(on, _)| on.starts_with("On ") || on.starts_with("WIP on ")).map_or(f[3], |(_, msg)| msg).to_string(),
            })
        })
        .collect();
    let mut worktrees: Vec<Worktree> = git(&repo, &["worktree", "list", "--porcelain"])?
        .split("\n\n")
        .filter_map(|block| {
            let mut w = Worktree { path: String::new(), head: String::new(), branch: String::new(), locked: false, prunable: false };
            for l in block.lines() {
                let (key, value) = l.split_once(' ').unwrap_or((l, ""));
                match key {
                    "worktree" => w.path = value.into(),
                    "HEAD" => w.head = value.into(),
                    "branch" => w.branch = value.trim_start_matches("refs/heads/").into(),
                    "locked" => w.locked = true,
                    "prunable" => w.prunable = true,
                    _ => {}
                }
            }
            (!w.path.is_empty()).then_some(w)
        })
        .collect();
    let mut repo_top = String::new();
    if let Some(main) = worktrees.first_mut() {
        (main.path, repo_top) = main_folder(&main.path);
    }
    let superproject = git(&repo, &["rev-parse", "--show-superproject-working-tree"])?.trim().to_string();
    let lfs = lfs_dir(&repo).is_ok_and(|d| d.is_dir());
    Ok(Refs { refs, stashes, remotes, worktrees, submodules: submodules(&repo)?, superproject, repo_top, lfs })
}

/// \brief The main worktree's folder from what `git worktree list` names, and the repo tool's top folder when it is one of its checkouts.
fn main_folder(listed: &str) -> (String, String) {
    // the repo tool's checkouts name their git dir <top>/.repo/projects/<path>.git: their folder is <top>/<path>
    if let Some((top, rest)) = listed.split_once("/.repo/projects/") {
        let folder = format!("{top}/{}", rest.trim_end_matches(".git"));
        if Path::new(&folder).join(".git").exists() {
            return (folder, top.to_string());
        }
    }
    (listed.to_string(), String::new())
}

/// \brief The submodules `.gitmodules` lists, with their state; git is asked again only about the ones that changed.
fn submodules(repo: &str) -> Result<Vec<Submodule>, String> {
    if !Path::new(repo).join(".gitmodules").exists() {
        return Ok(Vec::new());
    }
    let mut subs: Vec<Submodule> = Vec::new();
    // submodule.<name>.path / .url, the name may hold dots
    for l in git(repo, &["config", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"])?.lines() {
        let Some((key, value)) = l.split_once(' ') else { continue };
        let Some((name, field)) = key.strip_prefix("submodule.").and_then(|k| k.rsplit_once('.')) else { continue };
        let i = subs.iter().position(|s| s.name == name).unwrap_or_else(|| {
            subs.push(Submodule { name: name.into(), path: String::new(), url: String::new(), recorded: String::new(), head: String::new(), modified: false, untracked: false, ahead: None, behind: None });
            subs.len() - 1
        });
        if field == "path" { subs[i].path = value.into() } else { subs[i].url = value.into() }
    }
    subs.retain(|s| !s.path.is_empty());
    let paths: Vec<String> = subs.iter().map(|s| s.path.clone()).collect();
    let mut args = vec!["ls-tree", "HEAD", "--"];
    args.extend(paths.iter().map(String::as_str));
    // "160000 commit <sha>\t<path>"; no HEAD yet: nothing recorded
    for l in git(repo, &args).unwrap_or_default().lines() {
        let Some((meta, path)) = l.split_once('\t') else { continue };
        if let Some(sub) = subs.iter_mut().find(|s| s.path == path) {
            sub.recorded = meta.rsplit(' ').next().unwrap_or("").into();
        }
    }
    let mut args = vec!["status", "--porcelain=v2", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    // "1 XY S<c><m><u> ..." for a changed submodule: c its commit moved, m tracked changes, u untracked files
    let status = git(repo, &args)?;
    for e in status.split('\0').filter(|e| e.starts_with("1 ") || e.starts_with("2 ")) {
        let f: Vec<&str> = e.splitn(9, ' ').collect();
        let Some(sub) = f.get(8).and_then(|p| subs.iter_mut().find(|s| s.path == *p)) else { continue };
        let (xy, flags) = (f[1], f[2].as_bytes());
        sub.modified = flags.get(2) == Some(&b'M');
        sub.untracked = flags.get(3) == Some(&b'U');
        // its checkout left the recorded commit: in the index (staged) or in its own folder
        if xy.starts_with('M') || flags.get(1) == Some(&b'C') {
            sub.head = "?".into();
        }
    }
    for sub in &mut subs {
        let dir = Path::new(repo).join(&sub.path);
        if !dir.join(".git").exists() {
            sub.head.clear();
            continue;
        }
        if sub.head != "?" {
            sub.head = sub.recorded.clone();
            continue;
        }
        let d = dir.to_string_lossy();
        sub.head = git(&d, &["rev-parse", "HEAD"])?.trim().into();
        let counts = git(&d, &["rev-list", "--left-right", "--count", &format!("{}...HEAD", sub.recorded)]).ok();
        let mut counts = counts.iter().flat_map(|c| c.split_whitespace()).filter_map(|n| n.parse().ok());
        (sub.behind, sub.ahead) = (counts.next(), counts.next());
    }
    Ok(subs)
}

#[tauri::command(async)]
fn repo_root(path: String) -> Result<String, String> {
    Ok(git(&path, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

#[tauri::command(async)]
fn log(repo: String, limit: u32, hide: Vec<String>, show: Vec<String>) -> Result<Vec<Commit>, String> {
    let n = format!("-n{limit}");
    // hidden remotes and branches (ref patterns) leave the graph, stash commits drag their index/untracked parents into it
    let mut hidden: Vec<String> = hide.iter().map(|r| format!("--exclude={r}")).collect();
    // --all brings the other worktrees' HEADs too: a hidden branch checked out in one leaves with its HEAD
    if hide.iter().any(|r| r.starts_with("refs/heads/")) {
        let common = git(&repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        for wt in std::fs::read_dir(Path::new(common.trim()).join("worktrees")).into_iter().flatten().flatten() {
            let head = std::fs::read_to_string(wt.path().join("HEAD")).unwrap_or_default();
            if head.strip_prefix("ref: ").is_some_and(|r| hide.iter().any(|h| h == r.trim())) {
                hidden.push(format!("--exclude=worktrees/{}/HEAD", wt.file_name().to_string_lossy()));
            }
        }
    }
    let mut args: Vec<&str> = vec!["log"];
    args.extend(hidden.iter().map(String::as_str));
    args.extend(["--exclude=refs/stash", "--all", "--topo-order", "--decorate=full", &n,
                 "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x00%b%x1e"]);
    // a stash base can be on no branch any more (rebased away): keep it so the stash has a row
    // a hidden remote's branches shown again: named outright, the patterns above only drop the ones --all brings
    for s in &show {
        args.push(not_option(s)?);
    }
    let bases = git(&repo, &["stash", "list", "--format=%P"])?;
    args.extend(bases.lines().filter_map(|l| l.split_whitespace().next()));
    let out = git(&repo, &args)?;
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(7, '\0').collect();
            (f.len() == 7).then(|| Commit {
                refs: f[4].split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
                subject: f[5].to_string(),
                body: f[6].trim().to_string(),
                ..commit_of(&f)
            })
        })
        .collect())
}

#[tauri::command(async)]
fn status(repo: String) -> Result<Status, String> {
    let out = git(&repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let (mut staged, mut unstaged) = (Vec::new(), Vec::new());
    let mut entries = out.split('\0').filter(|e| !e.is_empty());
    while let Some(e) = entries.next() {
        let (x, y, path) = (&e[0..1], &e[1..2], e[3..].to_string());
        let old = if x == "R" || x == "C" { entries.next().map(String::from) } else { None };
        if matches!(&e[0..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            unstaged.push(Change { path, old: None, code: "U".into(), conflict: Some(e[0..2].to_string()), lfs: false });
        } else if x == "?" {
            unstaged.push(Change { path, old: None, code: "?".into(), conflict: None, lfs: false });
        } else {
            if y != " " {
                unstaged.push(Change { path: path.clone(), old: None, code: y.into(), conflict: None, lfs: false });
            }
            if x != " " {
                staged.push(Change { path, old, code: x.into(), conflict: None, lfs: false });
            }
        }
    }
    mark_lfs(&repo, None, staged.iter_mut().chain(unstaged.iter_mut()));
    let counts = git(&repo, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).ok();
    let mut counts = counts.iter().flat_map(|c| c.split_whitespace()).filter_map(|n| n.parse().ok());
    Ok(Status {
        branch: current_branch(&repo)?,
        state: op_state(&repo)?,
        behind: counts.next(),
        ahead: counts.next(),
        staged,
        unstaged,
    })
}

/// \brief Who meets whom in the operation in progress, and the message Continue commits.
#[tauri::command(async)]
fn op_info(repo: String) -> Result<OpInfo, String> {
    let state = op_state(&repo)?;
    let dir = git_dir(&repo)?;
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap_or_default().trim().to_string();
    let short = |r: &str| git(&repo, &["rev-parse", "--short", r]).unwrap_or_default().trim().to_string();
    // the branch at that commit, else its short hash
    let name = |r: &str| {
        ["refs/heads/*", "refs/remotes/*"]
            .iter()
            .find_map(|refs| git(&repo, &["name-rev", "--name-only", "--no-undefined", &format!("--refs={refs}"), r]).ok())
            .map(|n| n.trim().trim_start_matches("remotes/").to_string())
            .filter(|n| !n.contains('~') && !n.contains('^'))
            .unwrap_or_else(|| short(r))
    };
    let merge_msg = || read("MERGE_MSG").lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string();
    let branch = current_branch(&repo)?;
    let incoming_commit = short(match state.as_str() {
        "rebase" => "REBASE_HEAD",
        "merge" => "MERGE_HEAD",
        "revert" => "REVERT_HEAD",
        _ => "CHERRY_PICK_HEAD",
    });
    let (current, incoming, step, message) = match state.as_str() {
        "rebase" => {
            let (d, n, end) = if dir.join("rebase-merge").exists() { ("rebase-merge", "msgnum", "end") } else { ("rebase-apply", "next", "last") };
            (
                name(&read(&format!("{d}/onto"))),
                read(&format!("{d}/head-name")).trim_start_matches("refs/heads/").to_string(),
                format!("{}/{}", read(&format!("{d}/{n}")), read(&format!("{d}/{end}"))),
                git(&repo, &["show", "-s", "--format=%B", "REBASE_HEAD"]).unwrap_or_default().trim().to_string(),
            )
        }
        "merge" => (branch, name("MERGE_HEAD"), String::new(), merge_msg()),
        "cherry-pick" => (branch, name("CHERRY_PICK_HEAD"), String::new(), merge_msg()),
        "revert" => (branch, name("REVERT_HEAD"), String::new(), merge_msg()),
        _ => (branch, String::new(), String::new(), String::new()),
    };
    Ok(OpInfo { current_commit: short("HEAD"), state, current, incoming, step, message, incoming_commit })
}

/// \brief The diff3 merge of a conflicted file's current, base and incoming versions; the work tree is left alone.
#[tauri::command(async)]
fn conflict_text(repo: String, path: String) -> Result<Blob, String> {
    let stages = git(&repo, &["ls-files", "-u", "-z", "--", &path])?;
    let oid = |stage: &str| {
        stages.split('\0').find_map(|e| {
            let f: Vec<&str> = e.split_once('\t')?.0.split(' ').collect();
            (f.get(2) == Some(&stage)).then(|| f[1].to_string())
        })
    };
    let (Some(cur), Some(inc)) = (oid("2"), oid("3")) else {
        return Err(format!("{path}: one side has no version of it"));
    };
    // two git-lfs pointers do not merge line by line: one side is taken whole
    if git(&repo, &["check-attr", "filter", "--", &path])?.trim_end().ends_with(": lfs") {
        return Ok(BINARY);
    }
    // added on both sides: merged against an empty base
    let base = match oid("1") {
        Some(b) => b,
        None => String::from_utf8_lossy(&git_bytes(&repo, &["hash-object", "-w", "--stdin"], Some(b""))?).trim().to_string(),
    };
    let out = git_cmd(&repo, &["merge-file", "-p", "--diff3", "--object-id", "-L", "current", "-L", "base", "-L", "incoming", &cur, &base, &inc], None, true)?;
    // the exit code counts the conflicts, past 127 it is an error
    if out.status.code().is_none_or(|c| c >= 128) {
        return Err(output_text(&out));
    }
    Ok(if out.stdout.len() > MAX_TEXT { BINARY } else { blob_of(out.stdout) })
}

#[tauri::command(async)]
fn commit_info(repo: String, hash: String, parent: String) -> Result<CommitInfo, String> {
    let shown = git(&repo, &["show", "-s", "--format=%ae%x00%G?%x00%B", not_option(&hash)?])?;
    let f: Vec<&str> = shown.splitn(3, '\0').collect();
    let [email, sign, message] = f[..] else { return Err(format!("{hash}: no commit")) };
    let out = if parent.is_empty() {
        // one commit: diff-tree prints its id first unless told not to
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--name-status", "--no-commit-id", "--root", not_option(&hash)?])?
    } else {
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--name-status", not_option(&parent)?, not_option(&hash)?])?
    };
    let mut files = Vec::new();
    let mut f = out.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = f.next() {
        let code = &code[0..1];
        let first = f.next().unwrap_or_default().to_string();
        if code == "R" || code == "C" {
            let path = f.next().unwrap_or_default().to_string();
            files.push(Change { path, old: Some(first), code: code.into(), conflict: None, lfs: false });
        } else {
            files.push(Change { path: first, old: None, code: code.into(), conflict: None, lfs: false });
        }
    }
    mark_lfs(&repo, Some(&hash), files.iter_mut());
    Ok(CommitInfo { message: message.trim_end().to_string(), email: email.to_string(), sign: sign.to_string(), files })
}

/// \brief Flag the changes git-lfs stores, by their filter attribute at commit `at`, else in the worktree.
fn mark_lfs<'a>(repo: &str, at: Option<&str>, changes: impl Iterator<Item = &'a mut Change>) {
    let mut changes: Vec<_> = changes.collect();
    if changes.is_empty() {
        return;
    }
    let paths = changes.iter().map(|c| c.path.as_str()).collect::<Vec<_>>().join("\0");
    let mut args = vec!["check-attr", "-z", "--stdin", "filter"];
    if let Some(at) = at {
        args.splice(1..1, ["--source", at]);
    }
    let Ok(out) = git_bytes(repo, &args, Some(paths.as_bytes())) else { return };
    // path, attribute, value, each NUL-ended
    let fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    let lfs: HashSet<&[u8]> = fields.chunks(3).filter(|f| f.len() == 3 && f[2] == b"lfs").map(|f| f[0]).collect();
    for c in &mut changes {
        c.lfs = lfs.contains(c.path.as_bytes());
    }
}

/// \brief The commits that touched `path` from `revs`, across renames, each with the file's name there.
#[tauri::command(async)]
fn file_log(repo: String, revs: Vec<String>, path: String) -> Result<Vec<(Commit, Change)>, String> {
    let mut args = vec!["log", "--follow", "-M", "--name-status", "-z", "--format=%x1e%H%x00%P%x00%an%x00%at%x00%s"];
    for r in &revs {
        args.push(not_option(r)?);
    }
    args.extend(["--", &path]);
    let out = git(&repo, &args)?;
    // a merge lists no file: it keeps the name of the newer commit
    let mut name = path.clone();
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.split('\0').collect();
            if f.len() < 5 {
                return None;
            }
            let code = f.get(5).map(|s| s.trim()).unwrap_or_default();
            let old = if code.starts_with('R') || code.starts_with('C') { f.get(6).map(|s| s.to_string()) } else { None };
            if let Some(p) = f.get(if old.is_some() { 7 } else { 6 }).filter(|p| !p.is_empty()) {
                name = p.to_string();
            }
            let commit = Commit { subject: f[4].to_string(), ..commit_of(&f) };
            let change = Change { path: name.clone(), old: old.clone(), code: code.get(0..1).unwrap_or("M").into(), conflict: None, lfs: false };
            // the name before a rename holds for the older commits
            if let Some(o) = old {
                name = o;
            }
            Some((commit, change))
        })
        .collect())
}

// the running blame's process group: a long history can keep git busy for minutes
static BLAME: Mutex<Option<u32>> = Mutex::new(None);

/// \brief `git blame --porcelain` of `path` at commit `at`, or of the working tree file; ends the one still running.
#[tauri::command(async)]
fn blame(repo: String, at: String, path: String) -> Result<String, String> {
    stop_blame();
    let mut args = vec!["blame", "--porcelain"];
    if at != "WORKTREE" {
        args.push(not_option(&at)?);
    }
    args.extend(["--", &path]);
    let mut git = git_command(&repo, &args, true);
    git.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = git.spawn().map_err(|e| e.to_string())?;
    let id = child.id();
    *BLAME.lock().unwrap() = Some(id);
    let out = tokio::task::block_in_place(|| child.wait_with_output()).map_err(|e| e.to_string());
    let mut running = BLAME.lock().unwrap();
    if *running == Some(id) {
        *running = None;
    }
    let out = out?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).into_owned()) } else { Err(output_text(&out)) }
}

/// \brief The tag names on each remote; one that cannot be reached, or wants a passphrase, is left out.
#[tauri::command(async)]
fn remote_tags(repo: String) -> Result<std::collections::HashMap<String, Vec<String>>, String> {
    let mut tags = std::collections::HashMap::new();
    for remote in git(&repo, &["remote"])?.lines() {
        let out = git_cmd(&repo, &["ls-remote", "--tags", "--refs", remote], None, false)?;
        if out.status.success() {
            let names = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.split_once("\trefs/tags/").map(|(_, t)| t.to_string())).collect();
            tags.insert(remote.to_string(), names);
        }
    }
    Ok(tags)
}

/// \brief What `host` says of commit `hash`'s signature in repo `slug` ("owner/name"), through gh: "true valid", "false unknown_key"...
#[tauri::command(async)]
fn gh_verified(host: String, slug: String, hash: String) -> Result<String, String> {
    let path = format!("repos/{}/commits/{}", not_option(&slug)?, not_option(&hash)?);
    let mut gh = Command::new("gh");
    gh.args(["api", "--hostname", not_option(&host)?, &path, "--jq", r#".commit.verification | "\(.verified) \(.reason)""#])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null());
    // off the async pool while the network answers
    let out = tokio::task::block_in_place(|| gh.output()).map_err(|e| e.to_string())?;
    if out.status.success() { Ok(String::from_utf8_lossy(&out.stdout).trim().to_string()) } else { Err(output_text(&out)) }
}

/// \brief End the running blame, if any.
#[tauri::command]
fn stop_blame() {
    // git runs in its own session: the group is git and whatever it started
    if let Some(id) = BLAME.lock().unwrap().take() {
        unsafe { libc::kill(-(id as i32), libc::SIGTERM) };
    }
}

// past this a file loads only when asked: each copy on its way to the editor costs as much
const MAX_TEXT: usize = 10 << 20;
// asked or not, past this it does not load: a bigger answer never reaches the window (it stalls past ~256 MB)
const MAX_ASKED: usize = 200 << 20;
const BINARY: Blob = Blob { text: String::new(), exists: true, binary: true, large: None, lfs: "" };
const MISSING: Blob = Blob { text: String::new(), exists: false, binary: false, large: None, lfs: "" };
const fn large(size: u64) -> Blob {
    Blob { text: String::new(), exists: true, binary: false, large: Some(size), lfs: "" }
}

/// \brief A file's bytes as text; non-UTF-8 counts as binary: a lossy round trip would corrupt it on save/stage.
fn blob_of(bytes: Vec<u8>) -> Blob {
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Blob { text, exists: true, binary: false, large: None, lfs: "" },
        _ => BINARY,
    }
}

/// \brief Blob `spec` (rev:path) read up to `max` bytes; past them, only its size.
fn git_blob(repo: &str, spec: &str, max: usize) -> Result<Blob, String> {
    let mut child = git_command(repo, &["cat-file", "blob", spec], true).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let mut out = child.stdout.take().unwrap().take(max as u64 + 1);
    tokio::task::block_in_place(|| out.read_to_end(&mut bytes)).map_err(|e| e.to_string())?;
    if bytes.len() > max {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(large(git(repo, &["cat-file", "-s", spec])?.trim().parse().unwrap_or(0)));
    }
    // no such file there: git says so and fails
    if !tokio::task::block_in_place(|| child.wait()).map_err(|e| e.to_string())?.success() {
        return Ok(MISSING);
    }
    match lfs_object(repo, &bytes) {
        Some((_, size)) if size > max as u64 => Ok(Blob { lfs: "here", ..large(size) }),
        Some((object, _)) => Ok(std::fs::read(object).map_or(Blob { lfs: "missing", ..BINARY }, |b| Blob { lfs: "here", ..blob_of(b) })),
        None => Ok(blob_of(bytes)),
    }
}

/// \brief The local object and size a git-lfs pointer stands for; None when `bytes` is no pointer.
fn lfs_object(repo: &str, bytes: &[u8]) -> Option<(PathBuf, u64)> {
    // the spec caps a pointer at 1024 bytes
    let text = std::str::from_utf8(bytes.get(..bytes.len().min(1024))?).ok()?.strip_prefix("version https://git-lfs.github.com/spec/v1\n")?;
    let oid = text.lines().find_map(|l| l.strip_prefix("oid sha256:")).filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let size = text.lines().find_map(|l| l.strip_prefix("size "))?.parse().ok()?;
    Some((lfs_dir(repo).ok()?.join("objects").join(&oid[..2]).join(&oid[2..4]).join(oid), size))
}

/// \brief git-lfs's folder, which every worktree of the repository shares.
fn lfs_dir(repo: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim()).join("lfs"))
}

/// \brief File content `at` a commit, "INDEX" or "WORKTREE"; past MAX_TEXT bytes only its size, unless `full`.
#[tauri::command(async)]
fn blob(repo: String, at: String, path: String, full: Option<bool>) -> Result<Blob, String> {
    let max = if full.unwrap_or(false) { MAX_ASKED } else { MAX_TEXT };
    let bytes = match at.as_str() {
        "WORKTREE" => {
            let p = work_path(&repo, &path)?;
            match std::fs::symlink_metadata(&p) {
                // git stores the link target, not what it points to
                Ok(m) if m.file_type().is_symlink() => std::fs::read_link(&p).ok().map(|t| t.to_string_lossy().into_owned().into_bytes()),
                Ok(m) if m.len() > max as u64 => return Ok(large(m.len())),
                Ok(_) => std::fs::read(&p).ok(),
                Err(_) => None,
            }
        }
        "INDEX" => return git_blob(&repo, &format!(":{path}"), max),
        r => return git_blob(&repo, &format!("{}:{path}", not_option(r)?), max),
    };
    Ok(bytes.map_or(MISSING, blob_of))
}

#[tauri::command(async)]
fn write_file(repo: String, path: String, text: String) -> Result<(), String> {
    std::fs::write(work_path(&repo, &path)?, text).map_err(|e| e.to_string())
}

/// \brief Replace the index entry of `path` with `text` (partial staging).
#[tauri::command(async)]
fn stage_text(repo: String, path: String, text: String) -> Result<(), String> {
    let ls = git(&repo, &["ls-files", "-s", "--", &path])?;
    let mode = ls.split(' ').next().filter(|m| !m.is_empty()).unwrap_or("100644");
    // --path runs the file's filters, as git add would: git-lfs stores the object and stages its pointer
    let sha = git_bytes(&repo, &["hash-object", "-w", "--stdin", "--path", &path], Some(text.as_bytes()))?;
    let sha = String::from_utf8_lossy(&sha).trim().to_string();
    git(&repo, &["update-index", "--add", "--cacheinfo", &format!("{mode},{sha},{path}")]).map(|_| ())
}

/// \brief Every file path in the tree of commit `at`.
#[tauri::command(async)]
fn tree_files(repo: String, at: String) -> Result<Vec<String>, String> {
    let out = git_bytes(&repo, &["ls-tree", "-r", "-z", "--name-only", not_option(&at)?], None)?;
    Ok(out.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
}

#[derive(Serialize)]
struct RemoteUrls {
    fetch: String,
    push: String,
}

/// \brief Fetch and push URLs of remote `name`.
#[tauri::command(async)]
fn remote_urls(repo: String, name: String) -> Result<RemoteUrls, String> {
    let name = not_option(&name)?;
    Ok(RemoteUrls {
        fetch: git(&repo, &["remote", "get-url", name])?.trim().to_string(),
        push: git(&repo, &["remote", "get-url", "--push", name])?.trim().to_string(),
    })
}

/// \brief Rename remote `name` and set its URLs, leaving unchanged values alone.
#[tauri::command(async)]
fn edit_remote(repo: String, name: String, new_name: String, fetch: String, push: String) -> Result<(), String> {
    let old = remote_urls(repo.clone(), name.clone())?;
    let mut cur = name.clone();
    if new_name != name {
        git(&repo, &["remote", "rename", not_option(&name)?, not_option(&new_name)?])?;
        cur = new_name;
    }
    // an untouched push URL keeps following the fetch one
    if fetch != old.fetch {
        git(&repo, &["remote", "set-url", &cur, not_option(&fetch)?])?;
    }
    if push != old.push {
        git(&repo, &["remote", "set-url", "--push", &cur, not_option(&push)?])?;
    }
    Ok(())
}

/// \brief Open `path` with the desktop's default app, or the folder holding it.
#[tauri::command(async)]
fn open_default(repo: String, path: String, folder: bool) -> Result<(), String> {
    let p = existing_path(&repo, &path)?;
    let target = if folder { p.parent().unwrap_or(&p).to_path_buf() } else { p };
    reap(Command::new("xdg-open").arg(target).spawn().map_err(|e| e.to_string())?);
    Ok(())
}

/// \brief Delete `path` from the work tree.
#[tauri::command(async)]
fn delete_file(repo: String, path: String) -> Result<(), String> {
    std::fs::remove_file(work_path(&repo, &path)?).map_err(|e| e.to_string())
}

/// \brief The main worktree's folder when `repo` is a linked worktree, else empty.
#[tauri::command(async)]
fn worktree_main(repo: String) -> String {
    // a submodule's .git is a file too, pointing into its parent's .git/modules
    if !std::fs::read_to_string(Path::new(&repo).join(".git")).is_ok_and(|g| g.contains("/worktrees/")) {
        return String::new();
    }
    let listed = git(&repo, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    listed.lines().next().and_then(|l| l.strip_prefix("worktree ")).map_or(String::new(), |p| main_folder(p).0)
}

/// \brief Whether `path` exists in the work tree.
#[tauri::command]
fn on_disk(repo: String, path: String) -> Result<bool, String> {
    Ok(work_path(&repo, &path)?.exists())
}

/// \brief Undo the hunk of `commit`'s change to `path` whose new side starts at `line`, in the working tree.
#[tauri::command(async)]
fn revert_hunk(repo: String, commit: String, parent: String, path: String, line: u32) -> Result<(), String> {
    // a root commit is a change from the empty tree
    let parent = if parent.is_empty() { "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string() } else { parent };
    // no context: the hunks match the diff view's, and apply still finds them if later commits moved them
    let diff = git(&repo, &["diff", "-U0", "--no-color", "--no-ext-diff", not_option(&parent)?, not_option(&commit)?, "--", &path])?;
    let at = diff.find("\n@@").ok_or("nothing to revert")? + 1;
    let (head, body) = diff.split_at(at);
    let mut hunks: Vec<String> = Vec::new();
    for l in body.split_inclusive('\n') {
        if l.starts_with("@@") {
            hunks.push(String::new());
        }
        hunks.last_mut().ok_or("bad diff")?.push_str(l);
    }
    // "@@ -a,b +c,d @@": c is where the new side starts, or the line before a pure deletion
    let start = |h: &str| h.split(" +").nth(1).and_then(|s| s.split([',', ' ']).next()).and_then(|n| n.parse::<u32>().ok());
    let hunk = hunks.iter().find(|h| start(h) == Some(line)).ok_or_else(|| format!("no hunk at line {line} of {path}"))?;
    git_bytes(&repo, &["apply", "-R", "--unidiff-zero", "-"], Some(format!("{head}{hunk}").as_bytes()))?;
    Ok(())
}

/// \brief Whether `git branch -d` takes `branch`: merged into its upstream, or into HEAD without one.
#[tauri::command(async)]
fn is_merged(repo: String, branch: String) -> Result<bool, String> {
    let into = git(&repo, &["rev-parse", "--abbrev-ref", &format!("{}@{{upstream}}", not_option(&branch)?)]).unwrap_or_else(|_| "HEAD".into());
    Ok(git_cmd(&repo, &["merge-base", "--is-ancestor", &format!("refs/heads/{branch}"), into.trim()], None, true)?.status.success())
}

/// \brief Open `path` in VS Code at `line`, else in the desktop's default app.
#[tauri::command(async)]
fn open_in_editor(repo: String, path: String, line: u32) -> Result<(), String> {
    let p = existing_path(&repo, &path)?;
    let child = Command::new("code")
        .arg("-g")
        .arg(format!("{}:{line}", p.display()))
        .spawn()
        .or_else(|_| Command::new("xdg-open").arg(&p).spawn())
        .map_err(|e| e.to_string())?;
    reap(child);
    Ok(())
}

/// \brief Reword stash `name`: git cannot, so store it again under `message`, then drop the old entry.
fn stash_message(repo: &str, name: &str, message: &str) -> Result<String, String> {
    let n: u32 = name.strip_prefix("stash@{").and_then(|s| s.strip_suffix('}')).and_then(|s| s.parse().ok()).ok_or_else(|| format!("{name} is not a stash"))?;
    let hash = git(repo, &["rev-parse", name])?;
    git(repo, &["stash", "store", "-m", message, hash.trim()])?;
    let old = format!("stash@{{{}}}", n + 1);
    if git(repo, &["rev-parse", &old])? != hash {
        return Err(format!("{old} moved, kept both entries"));
    }
    git_with_stderr(repo, &["stash", "drop", &old])
}

/// \brief Resolve conflicted `path` with one side's version: stage 1 the base, 2 current, 3 incoming.
fn take_side(repo: &str, stage: &str, path: &str) -> Result<String, String> {
    // a side without a version of the file deleted it
    let has = git(repo, &["ls-files", "-u", "--", path])?.lines().any(|l| l.split_whitespace().nth(2) == Some(stage));
    if !has {
        return git_with_stderr(repo, &["rm", "-q", "--", path]);
    }
    git(repo, &["checkout-index", "-f", &format!("--stage={stage}"), "--", path])?;
    git_with_stderr(repo, &["add", "--", path])
}

/// \brief Apply or pop stash `name` (the latest when empty), its staged changes staged again when they still fit the index.
fn stash_restore(repo: &str, verb: &str, name: &str) -> Result<String, String> {
    let mut args = vec!["stash", verb, "--index"];
    if !name.is_empty() {
        args.push(not_option(name)?);
    }
    match git_with_stderr(repo, &args) {
        // git refuses before touching anything: everything comes back unstaged instead
        Err(e) if e.contains("without --index") => {
            args.retain(|&a| a != "--index");
            git_with_stderr(repo, &args)
        }
        r => r,
    }
}

/// \brief Rename tag `old`: `to` is JSON [new name, remotes that have it...]. An annotated tag is made again with its message,
/// tagger and date (a signature is not kept); the remotes get the new name and lose the old, then the old goes here.
fn tag_rename(repo: &str, old: &str, to: &str) -> Result<String, String> {
    let to: Vec<String> = serde_json::from_str(to).map_err(|e| e.to_string())?;
    let (new, remotes) = to.split_first().ok_or("no tag name")?;
    let (old, new) = (not_option(old)?, not_option(new)?);
    let tag = format!("refs/tags/{old}");
    if git(repo, &["cat-file", "-t", &tag])?.trim() == "tag" {
        let info = git(repo, &["for-each-ref", "--format=%(taggername)%00%(taggeremail:trim)%00%(taggerdate:raw)%00%(contents:subject)%0a%0a%(contents:body)", &tag])?;
        let f: Vec<&str> = info.splitn(4, '\0').collect();
        let [name, email, date, msg] = f[..] else { return Err(format!("unreadable tag {old}")) };
        let out = git_command(repo, &["tag", "-a", new, "-F", "-", &format!("{tag}^{{}}")], true)
            .envs([("GIT_COMMITTER_NAME", name), ("GIT_COMMITTER_EMAIL", email), ("GIT_COMMITTER_DATE", date)])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                c.stdin.take().unwrap().write_all(msg.trim_end().as_bytes())?;
                tokio::task::block_in_place(|| c.wait_with_output())
            })
            .map_err(|e| e.to_string())?;
        report(out)?;
    } else {
        git(repo, &["tag", new, &tag])?;
    }
    for remote in remotes {
        git_with_stderr(repo, &["push", not_option(remote)?, &format!("refs/tags/{new}"), &format!(":{tag}")])?;
    }
    git(repo, &["tag", "-d", old])
}

/// \brief Drop what changed in submodule `path`: its files, its untracked ones, then back on the recorded commit.
fn submodule_discard(repo: &str, path: &str) -> Result<String, String> {
    let dir = work_path(repo, path)?;
    let d = dir.to_string_lossy();
    git(&d, &["reset", "-q", "--hard"])?;
    git(&d, &["clean", "-fdq"])?;
    git_with_stderr(repo, &["submodule", "update", "--", path])
}

/// \brief Remove submodule `path` (named `name` in .gitmodules): its entry and folder, staged to commit, and its clone in .git/modules.
fn submodule_delete(repo: &str, path: &str, name: &str) -> Result<String, String> {
    if name.is_empty() || Path::new(name).components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("bad submodule name {name}"));
    }
    let out = git_with_stderr(repo, &["rm", "-f", "--", not_option(path)?])?;
    let clone = git_dir(repo)?.join("modules").join(name);
    if clone.exists() {
        std::fs::remove_dir_all(&clone).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[derive(Serialize)]
struct SubCommit {
    hash: String,
    subject: String,
}

#[derive(Serialize)]
struct SubmoduleChange {
    old: Option<SubCommit>,
    new: Option<SubCommit>,
    // the commits from old to new, newest first; removed ones when new is behind
    added: Vec<SubCommit>,
    removed: Vec<SubCommit>,
    // files changed and untracked in its folder, when `to` is the working tree
    changed: u32,
    untracked: u32,
    initialized: bool,
}

/// \brief What submodule `path` went through from `from` to `to` (a commit, "INDEX" or "WORKTREE"; empty: none).
#[tauri::command(async)]
fn submodule_change(repo: String, path: String, from: String, to: String) -> Result<SubmoduleChange, String> {
    let dir = work_path(&repo, &path)?;
    let d = dir.to_string_lossy().into_owned();
    let initialized = dir.join(".git").exists();
    let at = |rev: &str| -> Option<String> {
        let sha = match rev {
            "" => return None,
            "WORKTREE" if initialized => git(&d, &["rev-parse", "HEAD"]).ok()?,
            "WORKTREE" => return None,
            "INDEX" => git(&repo, &["rev-parse", &format!(":{path}")]).ok()?,
            r => git(&repo, &["rev-parse", &format!("{}:{path}", not_option(r).ok()?)]).ok()?,
        };
        Some(sha.trim().to_string())
    };
    // its subject: only a clone that has the commit knows it; an empty folder would answer for the parent repo
    let commit = |hash: String| {
        let subject = if initialized { git(&d, &["log", "-1", "--format=%s", &hash]).unwrap_or_default().trim().to_string() } else { String::new() };
        SubCommit { hash, subject }
    };
    let range = |a: &str, b: &str| -> Vec<SubCommit> {
        if !initialized {
            return Vec::new();
        }
        git(&d, &["log", "-n200", "--format=%H%x00%s", &format!("{a}..{b}")])
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.split_once('\0').map(|(h, s)| SubCommit { hash: h.into(), subject: s.into() }))
            .collect()
    };
    let (old, new) = (at(&from), at(&to));
    let (added, removed) = match (&old, &new) {
        (Some(a), Some(b)) if a != b => (range(a, b), range(b, a)),
        _ => (Vec::new(), Vec::new()),
    };
    let (mut changed, mut untracked) = (0, 0);
    if to == "WORKTREE" && initialized {
        for l in git(&d, &["status", "--porcelain"]).unwrap_or_default().lines() {
            if l.starts_with("??") { untracked += 1 } else { changed += 1 }
        }
    }
    Ok(SubmoduleChange { old: old.map(commit), new: new.map(commit), added, removed, changed, untracked, initialized })
}

/// \brief A shell word: `s` in single quotes.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// \brief `git rebase -i` onto `base` following krill's plan: `steps` is JSON [verb, hash, message?] oldest first,
/// the verb pick, fixup or drop; a message rewrites the commit made by that step and the ones before it since the last pick.
fn rebase_interactive(repo: &str, base: &str, steps: &str) -> Result<String, String> {
    let steps: Vec<Vec<String>> = serde_json::from_str(steps).map_err(|e| e.to_string())?;
    // the messages are read as the rebase goes, after a conflict too: they stay until the next plan
    let dir = git_dir(repo)?.join("krill-rebase");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut todo = String::new();
    for (i, step) in steps.iter().enumerate() {
        let [verb, hash, msg @ ..] = &step[..] else { return Err("bad rebase step".into()) };
        if !matches!(verb.as_str(), "pick" | "fixup" | "drop") {
            return Err(format!("bad rebase step {verb}"));
        }
        todo += &format!("{verb} {}\n", not_option(hash)?);
        if let [msg] = msg {
            let file = dir.join(format!("{i}.msg"));
            std::fs::write(&file, msg).map_err(|e| e.to_string())?;
            todo += &format!("exec git commit --amend --only -q -F {}\n", sh_quote(&file.to_string_lossy()));
        }
    }
    let plan = dir.join("todo");
    std::fs::write(&plan, todo).map_err(|e| e.to_string())?;
    let mut git = git_command(repo, &["rebase", "-i", not_option(base)?], true);
    // git hands its own todo to this "editor": ours replaces it
    git.env("GIT_SEQUENCE_EDITOR", format!("cp {}", sh_quote(&plan.to_string_lossy())));
    git.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = git.spawn().map_err(|e| e.to_string())?;
    let out = report(tokio::task::block_in_place(|| child.wait_with_output()).map_err(|e| e.to_string())?);
    // done in one go: nothing will read the messages
    if out.is_ok() && !git_dir(repo)?.join("rebase-merge").exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    out
}

/// \brief Mark every conflicted file resolved, as the work tree has it.
fn resolve_all(repo: &str) -> Result<String, String> {
    let files = git(repo, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
    let mut args = vec!["add", "-A", "--"];
    args.extend(files.split('\0').filter(|p| !p.is_empty()));
    git_with_stderr(repo, &args)
}

// ops that need a clean tree: the local changes are kept aside around them
const AUTOSTASH_OPS: [&str; 4] = ["pull", "merge", "rebase", "rebase-interactive"];
const AUTOSTASH: &str = "krill autostash";

/// \brief Keep the tracked changes aside in a stash, its hash in .git/krill-autostash; git's own --autostash brings them back all unstaged.
fn autostash(repo: &str) -> Result<(), String> {
    if git(repo, &["status", "--porcelain", "--untracked-files=no"])?.trim().is_empty() {
        return Ok(());
    }
    let top = || git(repo, &["rev-parse", "-q", "--verify", "stash@{0}"]).unwrap_or_default();
    let before = top();
    git(repo, &["stash", "push", "-q", "-m", AUTOSTASH])?;
    // nothing git would stash (changes inside submodules only): the top stash is an older one, not ours
    let sha = top();
    if sha == before {
        return Ok(());
    }
    std::fs::write(git_dir(repo)?.join("krill-autostash"), sha.trim()).map_err(|e| e.to_string())
}

/// \brief Once nothing is in progress, pop the kept changes back, staged as they were; None when there is nothing to bring back yet.
fn restore_autostash(repo: &str) -> Option<Result<String, String>> {
    let marker = git_dir(repo).ok()?.join("krill-autostash");
    let sha = std::fs::read_to_string(&marker).ok()?;
    if !op_state(repo).ok()?.is_empty() {
        return None;
    }
    let _ = std::fs::remove_file(&marker);
    // popped by hand meanwhile: nothing left to do
    let i = git(repo, &["stash", "list", "--format=%H"]).ok()?.lines().position(|h| h == sha.trim())?;
    Some(stash_restore(repo, "pop", &format!("stash@{{{i}}}")).map_err(|e| format!("{e}\nYour changes are kept in the stash \"{AUTOSTASH}\".")))
}

#[tauri::command(async)]
fn git_op(repo: String, op: String, arg: String, arg2: Option<String>) -> Result<String, String> {
    if AUTOSTASH_OPS.contains(&op.as_str()) && op_state(&repo)?.is_empty() {
        autostash(&repo)?;
    }
    let out = run_op(repo.clone(), op, arg, arg2);
    // after this op or a later one (continue, abort): the changes come back when the tree is free again
    match (out, restore_autostash(&repo)) {
        (Ok(o), Some(Ok(back))) => Ok(format!("{o}\n{back}").trim().to_string()),
        (Ok(_), Some(Err(e))) => Err(e),
        (out, _) => out,
    }
}

fn run_op(repo: String, op: String, arg: String, arg2: Option<String>) -> Result<String, String> {
    let state = op_state(&repo)?;
    let arg2 = arg2.unwrap_or_default();
    let upstream = format!("HEAD:refs/heads/{arg2}");
    let tag = format!("refs/tags/{arg2}");
    match op.as_str() {
        "stash-message" => return stash_message(&repo, &arg, &arg2),
        "take-base" => return take_side(&repo, "1", &arg),
        "take-current" => return take_side(&repo, "2", &arg),
        "take-incoming" => return take_side(&repo, "3", &arg),
        "resolve-all" => return resolve_all(&repo),
        "rebase-interactive" => return rebase_interactive(&repo, &arg, &arg2),
        "tag-rename" => return tag_rename(&repo, &arg, &arg2),
        "submodule-discard" => return submodule_discard(&repo, &arg),
        // arg2: JSON [new branch, commit it starts from]
        "worktree-add-new" => {
            let [branch, from]: [String; 2] = serde_json::from_str(&arg2).map_err(|e| e.to_string())?;
            return git_with_stderr(&repo, &["worktree", "add", "-b", not_option(&branch)?, not_option(&arg)?, not_option(&from)?]);
        }
        "submodule-delete" => return submodule_delete(&repo, &arg, &arg2),
        "stash-apply" => return stash_restore(&repo, "apply", &arg),
        "stash-pop" => return stash_restore(&repo, "pop", &arg),
        // in the background: a key that needs its passphrase fails quietly instead of asking
        "auto-fetch" => return report(git_cmd(&repo, &["fetch", "--all", "--prune"], None, false)?),
        "discard-all" => {
            git(&repo, &["reset", "-q", "--hard"])?;
            return git_with_stderr(&repo, &["clean", "-fd"]);
        }
        // a reworded step: commit it here, the sequence then moves on from it
        "continue" if state != "merge" && !arg.is_empty() && git(&repo, &["diff", "--cached", "--quiet"]).is_err() => {
            git(&repo, &["commit", "-q", "-m", &arg])?;
            // a lone cherry-pick or revert ends with its commit
            if state != "rebase" && !git_dir(&repo)?.join("sequencer").exists() {
                return Ok(String::new());
            }
        }
        _ => {}
    }
    let args: Vec<&str> = match op.as_str() {
        "fetch" => vec!["fetch", "--all", "--prune"],
        "pull" => match arg.as_str() {
            "ff-only" => vec!["pull", "--ff-only"],
            "rebase" => vec!["pull", "--rebase"],
            // fast-forward when possible, else a merge commit
            _ => vec!["pull", "--no-rebase"],
        },
        "push" => vec!["push"],
        // git-lfs globs its own pathspecs: under literal ones it fetches nothing, and still succeeds
        "lfs-pull" => vec!["--no-literal-pathspecs", "lfs", "pull"],
        "stash-push" => vec!["stash", "push", "-u"],
        "stage" => vec!["add", "-A", "--", &arg],
        "unstage" => vec!["reset", "-q", "--", &arg],
        "discard" => vec!["checkout", "--", &arg],
        "clean" => vec!["clean", "-f", "--", &arg],
        "stage-all" => vec!["add", "-A"],
        "unstage-all" => vec!["reset", "-q"],
        "commit" => vec!["commit", "-m", &arg],
        "amend" => vec!["commit", "--amend", "-m", &arg],
        // --only with no paths rewrites the message and leaves staged changes out
        "reword" => vec!["commit", "--amend", "--only", "-m", &arg],
        "reset-soft" => vec!["reset", "--soft", not_option(&arg)?],
        "reset-keep" => vec!["reset", "--keep", not_option(&arg)?],
        "reset-mixed" => vec!["reset", "-q", "--mixed", not_option(&arg)?],
        "reset-hard" => vec!["reset", "-q", "--hard", not_option(&arg)?],
        "revert" => vec!["revert", "--no-edit", not_option(&arg)?],
        // the branch moves to the commit, then is checked out
        "checkout-reset" => vec!["checkout", "-B", not_option(&arg)?, not_option(&arg2)?],
        // arg is the new name, arg2 where it starts
        "branch-create" => vec!["checkout", "-b", not_option(&arg)?, not_option(&arg2)?],
        "branch-rename" => vec!["branch", "-m", not_option(&arg)?, not_option(&arg2)?],
        // annotated, the name as message: tag.gpgSign makes git refuse a tag without one
        "tag-create" => vec!["tag", "-m", &arg, not_option(&arg)?, not_option(&arg2)?],
        "tag-delete" => vec!["tag", "-d", not_option(&arg)?],
        // arg is the remote, arg2 the tag
        "tag-push" => vec!["push", not_option(&arg)?, not_option(&arg2).map(|_| tag.as_str())?],
        // arg is the remote, arg2 the branch (or refs/tags/<tag>) on it
        "push-delete" => vec!["push", not_option(&arg)?, "--delete", not_option(&arg2)?],
        "fetch-remote" => vec!["fetch", "--prune", not_option(&arg)?],
        // first push of a branch: arg is the remote, arg2 the branch name there
        "push-upstream" => vec!["push", "-u", not_option(&arg)?, not_option(&arg2).map(|_| upstream.as_str())?],
        // worktree only: the restored file shows up unstaged, for review
        "restore-file" => vec!["restore", "--source", not_option(&arg)?, "--", &arg2],
        "checkout" => vec!["checkout", not_option(&arg)?],
        "merge" => vec!["merge", not_option(&arg)?],
        "rebase" => vec!["rebase", not_option(&arg)?],
        "cherry-pick" => vec!["cherry-pick", not_option(&arg)?],
        "branch-delete" => vec!["branch", "-d", not_option(&arg)?],
        "branch-force-delete" => vec!["branch", "-D", not_option(&arg)?],
        "worktree-remove" => vec!["worktree", "remove", not_option(&arg)?],
        "worktree-force-remove" => vec!["worktree", "remove", "--force", not_option(&arg)?],
        "worktree-prune" => vec!["worktree", "prune"],
        // a branch only on a remote gets its local tracking one
        "worktree-add" => vec!["worktree", "add", not_option(&arg)?, not_option(&arg2)?],
        "submodule-update" => vec!["submodule", "update", "--init", "--", not_option(&arg)?],
        "submodule-set-url" => vec!["submodule", "set-url", "--", not_option(&arg)?, not_option(&arg2)?],
        "stash-drop" => vec!["stash", "drop", not_option(&arg)?],
        "continue" if state == "merge" && !arg.is_empty() => vec!["commit", "-m", &arg],
        "continue" if state == "merge" => vec!["commit", "--no-edit"],
        "skip" if state != "merge" && !state.is_empty() => vec![state.as_str(), "--skip"],
        "continue" if !state.is_empty() => vec![state.as_str(), "--continue"],
        "abort" if !state.is_empty() => vec![state.as_str(), "--abort"],
        _ => return Err(format!("{op}: nothing to do")),
    };
    git_with_stderr(&repo, &args)
}

/// \brief Open an http(s) link in the browser.
#[tauri::command(async)]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("not a web link: {url}"));
    }
    reap(Command::new("xdg-open").arg(&url).spawn().map_err(|e| e.to_string())?);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    askpass::helper();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(pty::Ptys::default())
        .manage(askpass::Askpass::default())
        .setup(|app| {
            if let Err(e) = askpass::start(app.handle()) {
                eprintln!("no passphrase prompts: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_repo, init, clone, repo_root, log, status, refs, op_info, conflict_text, commit_info, blob, file_log, blame, stop_blame, gh_verified, remote_tags, submodule_change, write_file, stage_text, git_op, tree_files, open_in_editor, on_disk, worktree_main,
            is_merged, revert_hunk, open_default, delete_file, open_url, remote_urls, edit_remote,
            pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill, askpass::askpass_reply
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, event| {
            if let tauri::RunEvent::Exit = event {
                askpass::stop();
            }
        });
}
