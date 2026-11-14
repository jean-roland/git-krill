mod askpass;
mod pty;

use serde::Serialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::DirBuilderExt;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
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
    // a commit's own say on a submodule, from the modes it recorded; the work tree asks today's list
    #[serde(skip_serializing_if = "Option::is_none")]
    sub: Option<bool>,
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
    // it stores files with git-lfs
    lfs: bool,
    // why git-lfs cannot serve it: "missing" (not installed, told for any repository: no Track), "unset" (no `git lfs install`), else empty
    lfs_problem: &'static str,
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
/// \brief A program krill runs: on Windows without the console window it would flash up.
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    // CREATE_NO_WINDOW
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut c, 0x0800_0000);
    c
}

/// \brief The desktop's own opener: the default app for a file, the file manager for a folder, the browser for a link.
const fn opener() -> &'static str {
    if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" }
}

/// \brief The user's home folder, empty when unknown.
fn home() -> PathBuf {
    std::env::home_dir().unwrap_or_default()
}

fn git_command(repo: &str, args: &[&str], ask: bool) -> Command {
    let mut git = command("git");
    git.current_dir(repo);
    // git-lfs set up but gone: its filter would fail every command, without it LFS files read as their pointers
    if !lfs_installed() {
        git.args(["-c", "filter.lfs.process=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.clean=", "-c", "filter.lfs.required=false"]);
    }
    git.args(args)
        // never block on an editor or a credential prompt: there is no tty
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        // paths from the UI are names, not globs: `f[12].c` must not also match f1.c
        .env("GIT_LITERAL_PATHSPECS", "1")
        // its messages are read here: in English whatever the user's language
        .env_remove("LC_ALL")
        .env("LC_MESSAGES", "C");
    askpass::env(&mut git, ask);
    // its own session, off the terminal krill may run from: ssh would wait there for a key passphrase
    #[cfg(unix)]
    unsafe { git.pre_exec(|| (libc::setsid() >= 0).then_some(()).ok_or_else(std::io::Error::last_os_error)) };
    git
}

/// \brief Whether git-lfs runs here, asked once a run: an install while krill runs shows after a restart.
fn lfs_installed() -> bool {
    static INSTALLED: OnceLock<bool> = OnceLock::new();
    *INSTALLED.get_or_init(|| command("git").args(["lfs", "version"]).stdin(Stdio::null()).output().is_ok_and(|o| o.status.success()))
}

/// \brief Run git, `input` on its stdin.
fn git_cmd(repo: &str, args: &[&str], input: Option<&[u8]>, ask: bool) -> Result<Output, String> {
    let mut git = git_command(repo, args, ask);
    git.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = git.spawn().map_err(|e| e.to_string())?;
    if let Some(data) = input {
        // fed from aside: git answers as it reads, and with its output unread it would stop reading
        let (mut stdin, data) = (child.stdin.take().unwrap(), data.to_vec());
        std::thread::spawn(move || stdin.write_all(&data));
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

/// \brief `p` with a leading `~/` meaning the home folder, as in a shell.
fn home_path(p: &str) -> String {
    p.strip_prefix("~/").map_or(p.to_string(), |r| home().join(r).to_string_lossy().into_owned())
}

/// \brief Clone `url` into `parent`/`name`, creating `parent` if needed; returns the new work tree.
#[tauri::command(async)]
fn clone(parent: String, url: String, name: String) -> Result<String, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(format!("bad folder name {name}"));
    }
    let parent = home_path(&parent);
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
    // a clone made without git-lfs has no lfs folder yet, only the attributes
    let lfs = lfs_dir(&repo).is_ok_and(|d| d.is_dir()) || std::fs::read_to_string(Path::new(&repo).join(".gitattributes")).is_ok_and(|a| a.contains("filter=lfs"));
    let lfs_problem = if lfs || !lfs_installed() { lfs_problem(&repo) } else { "" };
    Ok(Refs { refs, stashes, remotes, worktrees, submodules: submodules(&repo)?, superproject, repo_top, lfs, lfs_problem })
}

/// \brief Why git-lfs cannot serve `repo`: "missing", "unset" or "" when it can.
fn lfs_problem(repo: &str) -> &'static str {
    if !lfs_installed() {
        return "missing";
    }
    // `git lfs install` sets its filter, for the user or this repository
    if git(repo, &["config", "--get-regexp", r"^filter\.lfs\."]).is_err() { "unset" } else { "" }
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
    // "submodule.<name>.path\n<value>", the name may hold dots and spaces; none at all fails
    for l in git(repo, &["config", "-z", "-f", ".gitmodules", "--get-regexp", r"^submodule\..*\.(path|url)$"]).unwrap_or_default().split('\0') {
        let Some((key, value)) = l.split_once('\n') else { continue };
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
        // a rename has its score before the path
        let n = if e.starts_with("2 ") { 10 } else { 9 };
        let f: Vec<&str> = e.splitn(n, ' ').collect();
        let Some(sub) = f.get(n - 1).and_then(|p| subs.iter_mut().find(|s| s.path == *p)) else { continue };
        let (xy, flags) = (f[1], f[2].as_bytes());
        sub.modified = flags.get(2) == Some(&b'M');
        sub.untracked = flags.get(3) == Some(&b'U');
        // its checkout left the recorded commit: in the index (staged, or newly added) or in its own folder
        if xy.starts_with(['M', 'A']) || flags.get(1) == Some(&b'C') {
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
            unstaged.push(Change { path, old: None, code: "U".into(), conflict: Some(e[0..2].to_string()), lfs: false, sub: None });
        } else if x == "?" {
            unstaged.push(Change { path, old: None, code: "?".into(), conflict: None, lfs: false, sub: None });
        } else {
            if y != " " {
                unstaged.push(Change { path: path.clone(), old: None, code: y.into(), conflict: None, lfs: false, sub: None });
            }
            if x != " " {
                staged.push(Change { path, old, code: x.into(), conflict: None, lfs: false, sub: None });
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
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--raw", "--no-commit-id", "--root", not_option(&hash)?])?
    } else {
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--raw", not_option(&parent)?, not_option(&hash)?])?
    };
    let mut files = Vec::new();
    let mut f = out.split('\0').filter(|s| !s.is_empty());
    while let Some(raw) = f.next() {
        let (code, sub) = raw_status(raw);
        let first = f.next().unwrap_or_default().to_string();
        if code == "R" || code == "C" {
            let path = f.next().unwrap_or_default().to_string();
            files.push(Change { path, old: Some(first), code: code.into(), conflict: None, lfs: false, sub });
        } else {
            files.push(Change { path: first, old: None, code: code.into(), conflict: None, lfs: false, sub });
        }
    }
    mark_lfs(&repo, Some(&hash), files.iter_mut());
    Ok(CommitInfo { message: message.trim_end().to_string(), email: email.to_string(), sign: sign.to_string(), files })
}

/// \brief The status letter of a `--raw` line, ":100644 160000 <sha> <sha> M", and whether either side is a submodule; a merge has none.
fn raw_status(raw: &str) -> (&str, Option<bool>) {
    let f: Vec<&str> = raw.split_whitespace().collect();
    let code = f.last().and_then(|c| c.get(0..1)).unwrap_or("M");
    (code, (!f.is_empty()).then(|| f.iter().take(2).any(|m| m.trim_start_matches(':') == "160000")))
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
    let mut args = vec!["log", "--follow", "-M", "--raw", "-z", "--format=%x1e%H%x00%P%x00%an%x00%at%x00%s"];
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
            let (code, sub) = raw_status(f.get(5).copied().unwrap_or_default());
            let old = if code.starts_with('R') || code.starts_with('C') { f.get(6).map(|s| s.to_string()) } else { None };
            if let Some(p) = f.get(if old.is_some() { 7 } else { 6 }).filter(|p| !p.is_empty()) {
                name = p.to_string();
            }
            let commit = Commit { subject: f[4].to_string(), ..commit_of(&f) };
            let change = Change { path: name.clone(), old: old.clone(), code: code.into(), conflict: None, lfs: false, sub };
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
    let mut args = vec!["blame", "--porcelain"];
    if at != "WORKTREE" {
        args.push(not_option(&at)?);
    }
    args.extend(["--", &path]);
    let mut git = git_command(&repo, &args, true);
    git.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // one at a time: the one before stops under the same lock this one starts
    let (child, id) = {
        let mut running = BLAME.lock().unwrap();
        kill_group(running.take());
        let child = git.spawn().map_err(|e| e.to_string())?;
        *running = Some(child.id());
        (child, *running)
    };
    let id = id.unwrap();
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
    let mut gh = command("gh");
    gh.args(["api", "--hostname", not_option(&host)?, &path, "--jq", r#".commit.verification | "\(.verified) \(.reason)""#])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .stdin(Stdio::null());
    // off the async pool while the network answers; gh missing or signed out is told apart, for the badge to say what to do
    let out = tokio::task::block_in_place(|| gh.output()).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "gh-missing".to_string() } else { e.to_string() })?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    let err = output_text(&out);
    Err(if err.contains("gh auth login") { "gh-auth".into() } else { err })
}

/// \brief End the running blame, if any.
#[tauri::command]
fn stop_blame() {
    kill_group(BLAME.lock().unwrap().take());
}

/// \brief Stop process `id` and what it started: git runs in its own session, the group is git's.
fn kill_group(id: Option<u32>) {
    let Some(id) = id else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(id as i32), libc::SIGTERM)
    };
    // no process groups: the tree from its root
    #[cfg(windows)]
    let _ = command("taskkill").args(["/T", "/F", "/PID", &id.to_string()]).status();
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

/// \brief Whether a file's first bytes say binary, as git judges it: a NUL early on, or text that is not UTF-8.
fn looks_binary(head: &[u8]) -> bool {
    let head = &head[..head.len().min(8000)];
    // a character cut at the end of the head is no proof
    head.contains(&0) || std::str::from_utf8(head).is_err_and(|e| e.error_len().is_some())
}

/// \brief The first bytes of the file at `p`, empty when it cannot be read.
fn file_head(p: &Path) -> Vec<u8> {
    let mut head = Vec::new();
    let _ = std::fs::File::open(p).map(|f| f.take(8000).read_to_end(&mut head));
    head
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
        return Ok(Blob { binary: looks_binary(&bytes), ..large(git(repo, &["cat-file", "-s", spec])?.trim().parse().unwrap_or(0)) });
    }
    // no such file there: git says so and fails
    if !tokio::task::block_in_place(|| child.wait()).map_err(|e| e.to_string())?.success() {
        return Ok(MISSING);
    }
    match lfs_object(repo, &bytes) {
        Some((object, _)) if !object.exists() => Ok(Blob { lfs: "missing", ..BINARY }),
        Some((object, size)) if size > max as u64 => Ok(Blob { lfs: "here", binary: looks_binary(&file_head(&object)), ..large(size) }),
        Some((object, _)) => Ok(std::fs::read(object).map_or(Blob { lfs: "missing", ..BINARY }, |b| Blob { lfs: "here", ..blob_of(b) })),
        None => Ok(blob_of(bytes)),
    }
}

/// \brief The local object and size a git-lfs pointer stands for; None when `bytes` is no pointer.
fn lfs_object(repo: &str, bytes: &[u8]) -> Option<(PathBuf, u64)> {
    // the spec keeps a pointer under 1024 bytes
    let text = std::str::from_utf8((bytes.len() < 1024).then_some(bytes)?).ok()?.strip_prefix("version https://git-lfs.github.com/spec/v1\n")?;
    let oid = text.lines().find_map(|l| l.strip_prefix("oid sha256:")).filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_hexdigit()))?;
    let size = text.lines().find_map(|l| l.strip_prefix("size "))?.parse().ok()?;
    Some((lfs_dir(repo).ok()?.join("objects").join(&oid[..2]).join(&oid[2..4]).join(oid), size))
}

/// \brief git-lfs's folder, which every worktree of the repository shares.
fn lfs_dir(repo: &str) -> Result<PathBuf, String> {
    Ok(PathBuf::from(git(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim()).join("lfs"))
}

/// \brief The patterns of a .gitattributes that store files with git-lfs, each with its line.
fn lfs_rules(attributes: &str) -> Vec<(usize, &str)> {
    let rules = attributes.split_inclusive('\n').enumerate().filter_map(|(i, line)| {
        let mut words = line.split_whitespace();
        let pattern = words.next().filter(|p| !p.starts_with('#') && !p.starts_with("[attr]"))?;
        words.any(|w| w == "filter=lfs").then_some((i, pattern))
    });
    rules.collect()
}

/// \brief The LFS patterns of the top .gitattributes that match `path`, as written there: what untracking it takes.
#[tauri::command(async)]
fn lfs_patterns(repo: String, path: String) -> Result<Vec<String>, String> {
    let attributes = std::fs::read_to_string(Path::new(&repo).join(".gitattributes")).unwrap_or_default();
    let rules = lfs_rules(&attributes);
    // git matches them itself: each pattern sets an attribute of its own in a probe file
    // one file per call: two quick ones would delete each other's
    static PROBES: AtomicUsize = AtomicUsize::new(0);
    let probe = git_dir(&repo)?.join(format!("krill-attributes-{}", PROBES.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&probe, rules.iter().map(|(i, p)| format!("{p} krill-lfs-{i}\n")).collect::<String>()).map_err(|e| e.to_string())?;
    let out = git_bytes(&repo, &["-c", &format!("core.attributesFile={}", probe.display()), "check-attr", "-z", "-a", "--", &path], None);
    let _ = std::fs::remove_file(&probe);
    let out = out?;
    // path, attribute, value, each NUL-ended
    let fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    let hits: HashSet<String> = fields.chunks(3).filter(|f| f.len() == 3 && f[2] == b"set").map(|f| String::from_utf8_lossy(f[1]).into_owned()).collect();
    Ok(rules.into_iter().filter(|(i, _)| hits.contains(&format!("krill-lfs-{i}"))).map(|(_, p)| p.to_string()).collect())
}

/// \brief Drop `patterns`, one a line, from the top .gitattributes; the files they stored show as changed.
fn lfs_untrack(repo: &str, patterns: &str) -> Result<String, String> {
    let file = Path::new(repo).join(".gitattributes");
    let attributes = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    // `git lfs untrack` misses the patterns it escaped itself: `--filename` ones
    let gone: Vec<usize> = lfs_rules(&attributes).into_iter().filter(|(_, p)| patterns.lines().any(|q| q == *p)).map(|(i, _)| i).collect();
    let kept: String = attributes.split_inclusive('\n').enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, l)| l).collect();
    std::fs::write(&file, kept).map_err(|e| e.to_string())?;
    // the index keeps their pointers and git trusts the file times: newer ones make it read the files again
    let pointers = git(repo, &["lfs", "ls-files", "-n"])?.lines().collect::<Vec<_>>().join("\0");
    let out = git_bytes(repo, &["check-attr", "-z", "--stdin", "filter"], Some(pointers.as_bytes()))?;
    let fields: Vec<&[u8]> = out.split(|&b| b == 0).collect();
    let now = std::time::SystemTime::now();
    for f in fields.chunks(3).filter(|f| f.len() == 3 && f[2] != b"lfs") {
        if let Ok(file) = std::fs::File::options().write(true).open(Path::new(repo).join(String::from_utf8_lossy(f[0]).as_ref())) {
            let _ = file.set_modified(now);
        }
    }
    Ok(format!("Untracked {}", patterns.lines().collect::<Vec<_>>().join(", ")))
}

/// \brief What tells each version (`at`, `path`) apart, far cheaper than reading it: size and time on disk, else git's object id; empty when there is none.
#[tauri::command(async)]
fn version_ids(repo: String, sides: Vec<(String, String)>) -> Vec<String> {
    let id = |at: &str, path: &str| -> Result<String, String> {
        match at {
            "" => Ok(String::new()),
            "WORKTREE" => std::fs::symlink_metadata(work_path(&repo, path)?).map(|m| format!("{} {:?}", m.len(), m.modified().ok())).map_err(|e| e.to_string()),
            "INDEX" => git(&repo, &["rev-parse", "-q", "--verify", &format!(":{path}")]),
            r => git(&repo, &["rev-parse", "-q", "--verify", &format!("{}:{path}", not_option(r)?)]),
        }
    };
    sides.iter().map(|(at, path)| id(at, path).unwrap_or_default()).collect()
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
                Ok(m) if m.len() > max as u64 => return Ok(Blob { binary: looks_binary(&file_head(&p)), ..large(m.len()) }),
                Ok(_) => std::fs::read(&p).ok(),
                Err(_) => None,
            }
        }
        "INDEX" => return git_blob(&repo, &format!(":{path}"), max),
        r => return git_blob(&repo, &format!("{}:{path}", not_option(r)?), max),
    };
    Ok(bytes.map_or(MISSING, blob_of))
}

/// \brief The bytes of `path` `at` a commit, "INDEX" or "WORKTREE", a git-lfs pointer swapped for its object.
fn version_bytes(repo: &str, at: &str, path: &str) -> Result<Vec<u8>, String> {
    let bytes = match at {
        "WORKTREE" => return std::fs::read(work_path(repo, path)?).map_err(|e| e.to_string()),
        "INDEX" => git_bytes(repo, &["cat-file", "blob", &format!(":{path}")], None)?,
        r => git_bytes(repo, &["cat-file", "blob", &format!("{}:{path}", not_option(r)?)], None)?,
    };
    match lfs_object(repo, &bytes) {
        Some((object, _)) => std::fs::read(object).map_err(|_| format!("{path} is stored with Git LFS and this version is not downloaded")),
        None => Ok(bytes),
    }
}

/// \brief A version of a file as raw bytes, for the window to show an image.
#[tauri::command(async)]
fn file_bytes(repo: String, at: String, path: String) -> Result<tauri::ipc::Response, String> {
    version_bytes(&repo, &at, &path).map(tauri::ipc::Response::new)
}

/// \brief Open a version of `path` with the desktop's default app: the working tree file, else a copy in a temporary folder.
#[tauri::command(async)]
fn open_version(repo: String, at: String, path: String) -> Result<(), String> {
    if at == "WORKTREE" {
        return open_default(repo, path, false);
    }
    let spec = if at == "INDEX" { format!(":{path}") } else { format!("{}:{path}", not_option(&at)?) };
    // the user's own folder, not everyone's /tmp; one per repository and version, the file under its own name for the app picked by its extension
    let mut key = std::hash::DefaultHasher::new();
    std::hash::Hash::hash(&repo, &mut key);
    let version: String = at.chars().filter(char::is_ascii_alphanumeric).take(12).collect();
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("git-krill").join(format!("{:x}", std::hash::Hasher::finish(&key))).join(version);
    let file = work_path(&dir.to_string_lossy(), &path)?;
    let mut dirs = std::fs::DirBuilder::new();
    dirs.recursive(true);
    #[cfg(unix)]
    dirs.mode(0o700);
    dirs.create(file.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
    let copy = || -> Result<(), String> {
        // streamed to disk, not read whole: a video can be gigabytes
        let out = std::fs::File::create(&file).map_err(|e| e.to_string())?;
        let mut git = git_command(&repo, &["cat-file", "blob", &spec], false);
        if !tokio::task::block_in_place(|| git.stdin(Stdio::null()).stdout(out).stderr(Stdio::null()).status()).map_err(|e| e.to_string())?.success() {
            return Err(format!("{path} is not in {at}"));
        }
        // a git-lfs pointer is small: the object it stands for goes in its place
        if std::fs::metadata(&file).map_or(0, |m| m.len()) < 1024 {
            if let Some((object, _)) = lfs_object(&repo, &std::fs::read(&file).unwrap_or_default()) {
                tokio::task::block_in_place(|| std::fs::copy(object, &file)).map_err(|_| format!("{path} is stored with Git LFS and this version is not downloaded"))?;
            }
        }
        Ok(())
    };
    // no half copy left behind under the real name
    copy().inspect_err(|_| drop(std::fs::remove_file(&file)))?;
    desktop_open(&file)
}

/// \brief Hand `target` to the desktop's default app, saying so when none takes its type.
fn desktop_open(target: &Path) -> Result<(), String> {
    // git's paths use /, which explorer misreads
    let target: PathBuf = target.components().collect();
    let mut child = command(opener()).arg(&target).spawn().map_err(|e| e.to_string())?;
    // explorer exits 1 whatever happens, and its own dialog says when no app takes the type
    if cfg!(windows) {
        reap(child);
        return Ok(());
    }
    // a type with no app fails at once; the opener may also wait on the app it started, so a second of quiet means it runs
    for _ in 0..20 {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let name = target.file_name().unwrap_or_default().to_string_lossy();
            return if status.success() { Ok(()) } else { Err(format!("No app opens {name}: the desktop has none set for its type")) };
        }
        tokio::task::block_in_place(|| std::thread::sleep(std::time::Duration::from_millis(50)));
    }
    reap(child);
    Ok(())
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
    desktop_open(if folder { p.parent().unwrap_or(&p) } else { &p })
}

/// \brief Delete `path` from the work tree.
#[tauri::command(async)]
fn delete_file(repo: String, path: String) -> Result<(), String> {
    std::fs::remove_file(work_path(&repo, &path)?).map_err(|e| e.to_string())
}

/// \brief The main worktree's folder when `repo` is a linked worktree, else empty.
#[tauri::command(async)]
fn worktree_main(repo: String) -> String {
    // a linked worktree's git dir sits in the shared one; a submodule's is its own
    let dirs = git(&repo, &["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).unwrap_or_default();
    let mut dirs = dirs.lines();
    if dirs.next() == dirs.next() {
        return String::new();
    }
    let listed = git(&repo, &["worktree", "list", "--porcelain"]).unwrap_or_default();
    let mut main = listed.split("\n\n").next().unwrap_or("").lines();
    let path = main.next().and_then(|l| l.strip_prefix("worktree ")).unwrap_or("");
    // a bare repository has no checkout to go back to
    if main.any(|l| l == "bare") { String::new() } else { main_folder(path).0 }
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

/// \brief Open `path` at `line` with `editor`, a command whose {file} and {line} are filled in, else in the desktop's default app.
#[tauri::command(async)]
fn open_in_editor(repo: String, path: String, line: u32, editor: String) -> Result<(), String> {
    let p = existing_path(&repo, &path)?;
    let file = p.to_string_lossy();
    // split before filling in: a path with spaces stays one argument
    let mut words = editor.split_whitespace().map(|w| w.replace("{file}", &file).replace("{line}", &line.to_string()));
    let child = match words.next() {
        Some(cmd) => {
            let args: Vec<String> = words.collect();
            command(&cmd)
                .args(&args)
                .spawn()
                // a script on Windows, as VS Code's `code` is: only .exe names are found bare
                .or_else(|e| if cfg!(windows) { command(format!("{cmd}.cmd")).args(&args).spawn() } else { Err(e) })
                .or_else(|_| command(opener()).arg(p.components().collect::<PathBuf>()).spawn())
        }
        None => command(opener()).arg(p.components().collect::<PathBuf>()).spawn(),
    };
    reap(child.map_err(|e| e.to_string())?);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Tools {
    // the first line of each one's version, empty when it is not found
    git: String,
    lfs: String,
    gh: String,
    // git-lfs's filter in the user's or the system's config: `git lfs install` ran
    lfs_set_up: bool,
    // found when krill started: it looks for git-lfs once a run
    lfs_in_use: bool,
    // "host (account)" for each server gh is signed in to
    gh_hosts: Vec<String>,
}

/// \brief The tools krill leans on, as they stand now.
#[tauri::command(async)]
fn tool_status() -> Tools {
    // gh asks its server: off the async pool while it waits
    tokio::task::block_in_place(tool_status_now)
}

fn tool_status_now() -> Tools {
    // out of any repository: only the user's and the system's config count
    let home = home();
    let run = |cmd: &str, args: &[&str]| command(cmd).args(args).current_dir(&home).stdin(Stdio::null()).output().ok();
    let first_line = |o: Option<std::process::Output>| o.filter(|o| o.status.success()).map_or(String::new(), |o| String::from_utf8_lossy(&o.stdout).lines().next().unwrap_or("").trim().to_string());
    let lfs = first_line(run("git", &["lfs", "version"]));
    // gh says it on stdout or stderr depending on its version, as "Logged in to <host> account <user>" or "... as <user>"
    let gh_hosts = run("gh", &["auth", "status"]).map_or(vec![], |o| {
        let text = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
        text.lines()
            .filter_map(|l| {
                let words: Vec<&str> = l.split_once("Logged in to ")?.1.split_whitespace().collect();
                let user = words.iter().position(|w| *w == "account" || *w == "as").and_then(|i| words.get(i + 1))?;
                Some(format!("{} ({user})", words.first()?))
            })
            .collect()
    });
    Tools {
        git: first_line(run("git", &["--version"])),
        lfs_set_up: !lfs.is_empty() && run("git", &["config", "--get-regexp", r"^filter\.lfs\."]).is_some_and(|o| o.status.success()),
        lfs_in_use: lfs_installed(),
        lfs,
        gh: first_line(run("gh", &["--version"])),
        gh_hosts,
    }
}

// the global git settings the Settings page edits, and nothing else
const GLOBAL_KEYS: [&str; 6] = ["user.name", "user.email", "user.signingkey", "commit.gpgsign", "rerere.enabled", "rerere.autoUpdate"];

/// \brief The values of GLOBAL_KEYS in ~/.gitconfig, empty when unset.
#[tauri::command(async)]
fn global_config() -> Vec<String> {
    GLOBAL_KEYS
        .iter()
        // included files count, and past the identity a yes/on/1 reads as true
        .map(|k| command("git").args(["config", "--global", "--includes", if k.starts_with("user.") { "--no-type" } else { "--type=bool" }, "--get", k]).stdin(Stdio::null()).output().map_or(String::new(), |o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
        .collect()
}

/// \brief Set `key`, one of GLOBAL_KEYS, in ~/.gitconfig; an empty `value` unsets it.
#[tauri::command(async)]
fn set_global_config(key: String, value: String) -> Result<(), String> {
    if !GLOBAL_KEYS.contains(&key.as_str()) {
        return Err(format!("{key} is not a setting krill edits"));
    }
    let args = if value.is_empty() { vec!["config", "--global", "--unset", &key] } else { vec!["config", "--global", &key, not_option(&value)?] };
    let out = command("git").args(&args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    // 5: unsetting what was not set, nothing to do
    if out.status.success() || (value.is_empty() && out.status.code() == Some(5)) { Ok(()) } else { Err(output_text(&out)) }
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
    // a retry after a push that failed half way finds the new tag made already, on the same commit
    let peeled = |t: &str| git(repo, &["rev-parse", "-q", "--verify", &format!("{t}^{{}}")]).unwrap_or_default();
    let made = peeled(&tag) == peeled(&format!("refs/tags/{new}"));
    if !made && git(repo, &["cat-file", "-t", &tag])?.trim() == "tag" {
        let info = git(repo, &["for-each-ref", "--format=%(taggername)%00%(taggeremail:trim)%00%(taggerdate:raw)%00%(contents)%00%(contents:signature)", &tag])?;
        let f: Vec<&str> = info.splitn(5, '\0').collect();
        let [name, email, date, contents, signature] = f[..] else { return Err(format!("unreadable tag {old}")) };
        // the message as written, its signature dropped: the new tag is not signed
        let msg = contents.strip_suffix(signature.trim_end_matches('\n')).unwrap_or(contents);
        // a tag without a tagger gets the user's own
        let tagger = [("GIT_COMMITTER_NAME", name), ("GIT_COMMITTER_EMAIL", email), ("GIT_COMMITTER_DATE", date)].into_iter().filter(|(_, v)| !v.is_empty());
        let out = git_command(repo, &["tag", "-a", new, "-F", "-", &format!("{tag}^{{}}")], true)
            .envs(tagger)
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
    } else if !made {
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
    // not checked out, git would find the parent and reset it instead
    if path.is_empty() || !dir.join(".git").exists() || !git(repo, &["ls-files", "-s", "--", path])?.starts_with("160000 ") {
        return Err(format!("{path} is not a checked out submodule"));
    }
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
    // a stopped rebase still reads its messages from there
    if !op_state(repo)?.is_empty() {
        return Err("Finish or abort the operation in progress first".into());
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut todo = String::new();
    for (i, step) in steps.iter().enumerate() {
        let [verb, hash, msg @ ..] = &step[..] else { return Err("bad rebase step".into()) };
        if !matches!(verb.as_str(), "pick" | "fixup" | "drop") {
            return Err(format!("bad rebase step {verb}"));
        }
        if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("bad rebase step {hash}"));
        }
        todo += &format!("{verb} {hash}\n");
        // a dropped commit has no message to set: it would amend the one before
        if let ([msg], false) = (msg, verb == "drop") {
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
    static RESTORING: Mutex<()> = Mutex::new(());
    let _one = RESTORING.lock().unwrap();
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
    // a fetch runs beside the others: it would bring the changes back under a pull
    let fetching = op.contains("fetch");
    let out = run_op(repo.clone(), op, arg, arg2);
    // after this op or a later one (continue, abort): the changes come back when the tree is free again
    match (out, if fetching { None } else { restore_autostash(&repo) }) {
        (Ok(o), Some(Ok(back))) => Ok(format!("{o}\n{back}").trim().to_string()),
        (Ok(_), Some(Err(e))) => Err(e),
        (out, _) => out,
    }
}

fn run_op(repo: String, op: String, arg: String, arg2: Option<String>) -> Result<String, String> {
    // a typed folder
    let arg = if op.starts_with("worktree-add") { home_path(&arg) } else { arg };
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
        "lfs-untrack" => return lfs_untrack(&repo, &arg),
        // the LFS objects of the commits in `arg` for the files in `arg2`, comma separated; git-lfs takes refs only after a remote: the branch's own, else origin
        "lfs-fetch" => {
            let up = git(&repo, &["rev-parse", "--abbrev-ref", "@{u}"]).unwrap_or_default();
            let include = format!("--include={arg2}");
            let mut args = vec!["--no-literal-pathspecs", "lfs", "fetch", &include, up.split_once('/').map_or("origin", |(r, _)| r)];
            for rev in arg.split_whitespace() {
                args.push(not_option(rev)?);
            }
            return git_with_stderr(&repo, &args);
        }
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
        // arg2 "file": the path itself, its glob characters escaped
        "lfs-track" if arg2 == "file" => vec!["lfs", "track", "--filename", "--", &arg],
        "lfs-track" => vec!["lfs", "track", "--", &arg],
        "lfs-prune" => vec!["lfs", "prune"],
        // its own `git clean -- :/` of the untracked files it saved: under literal pathspecs it removes none
        "stash-push" => vec!["--no-literal-pathspecs", "stash", "push", "-u"],
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
        "submodule-add" => vec!["submodule", "add", "--", &arg, not_option(&arg2)?],
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
    reap(command(opener()).arg(&url).spawn().map_err(|e| e.to_string())?);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// \brief The login shell's PATH: started from the Finder, an app gets launchd's bare one, without Homebrew's git-lfs and gh.
#[cfg(target_os = "macos")]
fn login_path() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(out) = command(shell).args(["-l", "-c", "printf '\\n%s' \"$PATH\""]).stdin(Stdio::null()).output() else { return };
    // its profile may print first: the last line is ours
    if let Some(path) = String::from_utf8_lossy(&out.stdout).lines().last().filter(|p| out.status.success() && !p.is_empty()) {
        // before any other thread starts
        unsafe { std::env::set_var("PATH", path) };
    }
}

/// \brief macOS's menu bar, its default one minus Close Window and Undo: their Cmd+W and Cmd+Z would beat krill's own (close the tab, undo in git).
#[cfg(target_os = "macos")]
fn mac_menu(h: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, PredefinedMenuItem as Item, Submenu};
    let app = Submenu::with_items(h, "Git Krill", true, &[&Item::about(h, None, None)?, &Item::separator(h)?, &Item::hide(h, None)?, &Item::quit(h, None)?])?;
    // a text field copies and pastes only through these
    let edit = Submenu::with_items(h, "Edit", true, &[&Item::cut(h, None)?, &Item::copy(h, None)?, &Item::paste(h, None)?, &Item::select_all(h, None)?])?;
    Menu::with_items(h, &[&app, &edit])
}

pub fn run() {
    askpass::helper();
    #[cfg(target_os = "macos")]
    login_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(pty::Ptys::default())
        .manage(askpass::Askpass::default())
        .setup(|app| {
            if let Err(e) = askpass::start(app.handle()) {
                eprintln!("no passphrase prompts: {e}");
            }
            #[cfg(target_os = "macos")]
            app.set_menu(mac_menu(app.handle())?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_repo, init, clone, repo_root, log, status, refs, op_info, conflict_text, commit_info, blob, file_log, blame, stop_blame, gh_verified, remote_tags, submodule_change, write_file, stage_text, git_op, tree_files, open_in_editor, on_disk, worktree_main, lfs_patterns, version_ids,
            is_merged, revert_hunk, open_default, open_version, file_bytes, tool_status, global_config, set_global_config, delete_file, open_url, remote_urls, edit_remote,
            pty::pty_spawn, pty::pty_write, pty::pty_resize, pty::pty_kill, askpass::askpass_reply
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_, _| {});
}
