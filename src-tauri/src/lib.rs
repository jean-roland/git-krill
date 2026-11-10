use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

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
struct Refs {
    refs: Vec<Ref>,
    stashes: Vec<Stash>,
    remotes: Vec<String>,
}

#[derive(Serialize)]
struct Blob {
    text: String,
    exists: bool,
    binary: bool,
}

fn git_run(repo: &str, args: &[&str], input: Option<&[u8]>) -> Result<std::process::Output, String> {
    let mut child = Command::new("git")
        .current_dir(repo)
        .args(args)
        // never block on an editor or a credential prompt: there is no tty
        .env("GIT_EDITOR", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(data) = input {
        child.stdin.take().unwrap().write_all(data).map_err(|e| e.to_string())?;
    }
    child.wait_with_output().map_err(|e| e.to_string())
}

fn both(out: &std::process::Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)).trim().to_string()
}

fn git_in(repo: &str, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let out = git_run(repo, args, input)?;
    if out.status.success() { Ok(out.stdout) } else { Err(both(&out)) }
}

/// \brief Like `git` but keeps stderr on success too: push and fetch report there.
fn git_loud(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = git_run(repo, args, None)?;
    if out.status.success() { Ok(both(&out)) } else { Err(both(&out)) }
}

/// \brief Let a launched app run on its own; reaped so it does not linger as a zombie.
fn reap(mut child: std::process::Child) {
    std::thread::spawn(move || child.wait());
}

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    git_in(repo, args, None).map(|o| String::from_utf8_lossy(&o).into_owned())
}

/// \brief Repo-relative path, refusing anything that escapes the work tree.
fn work_path(repo: &str, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if p.is_absolute() || p.components().any(|c| c == Component::ParentDir) {
        return Err(format!("bad path {path}"));
    }
    Ok(Path::new(repo).join(p))
}

/// \brief Refs and hashes from the UI, refusing option injection.
fn rev(arg: &str) -> Result<&str, String> {
    if arg.is_empty() || arg.starts_with('-') {
        return Err(format!("bad rev {arg}"));
    }
    Ok(arg)
}

fn op_state(repo: &str) -> Result<String, String> {
    let dir = PathBuf::from(git(repo, &["rev-parse", "--absolute-git-dir"])?.trim());
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

/// \brief Clone `url` under `parent`, returns the new work tree.
#[tauri::command(async)]
fn clone(parent: String, url: String) -> Result<String, String> {
    let name = url.trim_end_matches('/').rsplit(['/', ':']).next().unwrap_or_default().trim_end_matches(".git");
    if name.is_empty() || name.starts_with('.') {
        return Err(format!("no repository name in {url}"));
    }
    git(&parent, &["clone", "--", &url, name])?;
    Ok(Path::new(&parent).join(name).to_string_lossy().into_owned())
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
                subject: f[3].to_string(),
            })
        })
        .collect();
    Ok(Refs { refs, stashes, remotes })
}

#[tauri::command(async)]
fn repo_root(path: String) -> Result<String, String> {
    Ok(git(&path, &["rev-parse", "--show-toplevel"])?.trim().to_string())
}

#[tauri::command(async)]
fn log(repo: String, limit: u32, hide: Vec<String>) -> Result<Vec<Commit>, String> {
    let n = format!("-n{limit}");
    // hidden remotes leave the graph, stash commits drag their index/untracked parents into it
    let hidden: Vec<String> = hide.iter().map(|r| format!("--exclude=refs/remotes/{r}/*")).collect();
    let mut args: Vec<&str> = vec!["log"];
    args.extend(hidden.iter().map(String::as_str));
    args.extend(["--exclude=refs/stash", "--all", "--topo-order", "--decorate=full", &n,
                 "--format=%H%x00%P%x00%an%x00%at%x00%D%x00%s%x00%b%x1e"]);
    // a stash base can be on no branch any more (rebased away): keep it so the stash has a row
    let bases = git(&repo, &["stash", "list", "--format=%P"])?;
    args.extend(bases.lines().filter_map(|l| l.split_whitespace().next()));
    let out = git(&repo, &args)?;
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').splitn(7, '\0').collect();
            (f.len() == 7).then(|| Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                refs: f[4].split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
                subject: f[5].to_string(),
                body: f[6].trim().to_string(),
            })
        })
        .collect())
}

#[tauri::command(async)]
fn status(repo: String) -> Result<Status, String> {
    let out = git(&repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let (mut staged, mut unstaged) = (Vec::new(), Vec::new());
    let mut entries = out.split('\0').filter(|e| e.len() > 3);
    while let Some(e) = entries.next() {
        let (x, y, path) = (&e[0..1], &e[1..2], e[3..].to_string());
        let old = if x == "R" || x == "C" { entries.next().map(String::from) } else { None };
        if matches!(&e[0..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
            unstaged.push(Change { path, old: None, code: "U".into(), conflict: Some(e[0..2].to_string()) });
        } else if x == "?" {
            unstaged.push(Change { path, old: None, code: "?".into(), conflict: None });
        } else {
            if y != " " {
                unstaged.push(Change { path: path.clone(), old: None, code: y.into(), conflict: None });
            }
            if x != " " {
                staged.push(Change { path, old, code: x.into(), conflict: None });
            }
        }
    }
    let counts = git(&repo, &["rev-list", "--left-right", "--count", "@{u}...HEAD"]).ok();
    let mut counts = counts.iter().flat_map(|c| c.split_whitespace()).filter_map(|n| n.parse().ok());
    Ok(Status {
        branch: git(&repo, &["branch", "--show-current"])?.trim().to_string(),
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
    let dir = PathBuf::from(git(&repo, &["rev-parse", "--absolute-git-dir"])?.trim());
    let read = |f: &str| std::fs::read_to_string(dir.join(f)).unwrap_or_default().trim().to_string();
    // the branch at that commit, else its short hash
    let name = |r: &str| {
        ["refs/heads/*", "refs/remotes/*"]
            .iter()
            .find_map(|refs| git(&repo, &["name-rev", "--name-only", "--no-undefined", &format!("--refs={refs}"), r]).ok())
            .map(|n| n.trim().trim_start_matches("remotes/").to_string())
            .filter(|n| !n.contains('~') && !n.contains('^'))
            .unwrap_or_else(|| git(&repo, &["rev-parse", "--short", r]).unwrap_or_default().trim().to_string())
    };
    let merge_msg = || read("MERGE_MSG").lines().filter(|l| !l.starts_with('#')).collect::<Vec<_>>().join("\n").trim().to_string();
    let branch = git(&repo, &["branch", "--show-current"])?.trim().to_string();
    let short = |r: &str| git(&repo, &["rev-parse", "--short", r]).unwrap_or_default().trim().to_string();
    let incoming_commit = short(match state.as_str() {
        "rebase" => "REBASE_HEAD",
        "merge" => "MERGE_HEAD",
        "revert" => "REVERT_HEAD",
        _ => "CHERRY_PICK_HEAD",
    });
    let current_commit = short("HEAD");
    Ok(match state.as_str() {
        "rebase" => {
            let (d, n, end) = if dir.join("rebase-merge").exists() { ("rebase-merge", "msgnum", "end") } else { ("rebase-apply", "next", "last") };
            OpInfo {
                current: name(&read(&format!("{d}/onto"))),
                incoming: read(&format!("{d}/head-name")).trim_start_matches("refs/heads/").to_string(),
                step: format!("{}/{}", read(&format!("{d}/{n}")), read(&format!("{d}/{end}"))),
                message: git(&repo, &["show", "-s", "--format=%B", "REBASE_HEAD"]).unwrap_or_default().trim().to_string(),
                state: state.clone(),
                current_commit,
                incoming_commit,
            }
        }
        "merge" => OpInfo { current: branch, incoming: name("MERGE_HEAD"), step: String::new(), message: merge_msg(), state: state.clone(), current_commit, incoming_commit },
        "cherry-pick" | "revert" => {
            let head = if state == "revert" { "REVERT_HEAD" } else { "CHERRY_PICK_HEAD" };
            OpInfo { current: branch, incoming: name(head), step: String::new(), message: merge_msg(), state: state.clone(), current_commit, incoming_commit }
        }
        _ => OpInfo { current: branch, incoming: String::new(), step: String::new(), message: String::new(), state: state.clone(), current_commit, incoming_commit },
    })
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
    // added on both sides: merged against an empty base
    let base = match oid("1") {
        Some(b) => b,
        None => String::from_utf8_lossy(&git_in(&repo, &["hash-object", "-w", "--stdin"], Some(b""))?).trim().to_string(),
    };
    let out = git_run(&repo, &["merge-file", "-p", "--diff3", "--object-id", "-L", "current", "-L", "base", "-L", "incoming", &cur, &base, &inc], None)?;
    // the exit code counts the conflicts, past 127 it is an error
    if !out.status.code().is_some_and(|c| c < 128) {
        return Err(both(&out));
    }
    match String::from_utf8(out.stdout) {
        Ok(text) if !text.contains('\0') => Ok(Blob { text, exists: true, binary: false }),
        _ => Ok(Blob { text: String::new(), exists: true, binary: true }),
    }
}

#[tauri::command(async)]
fn commit_info(repo: String, hash: String, parent: String) -> Result<CommitInfo, String> {
    let message = git(&repo, &["show", "-s", "--format=%B", rev(&hash)?])?;
    let out = if parent.is_empty() {
        // one commit: diff-tree prints its id first unless told not to
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--name-status", "--no-commit-id", "--root", rev(&hash)?])?
    } else {
        git(&repo, &["diff-tree", "-r", "-M", "-z", "--name-status", rev(&parent)?, rev(&hash)?])?
    };
    let mut files = Vec::new();
    let mut f = out.split('\0').filter(|s| !s.is_empty());
    while let Some(code) = f.next() {
        let code = &code[0..1];
        let first = f.next().unwrap_or_default().to_string();
        if code == "R" || code == "C" {
            let path = f.next().unwrap_or_default().to_string();
            files.push(Change { path, old: Some(first), code: code.into(), conflict: None });
        } else {
            files.push(Change { path: first, old: None, code: code.into(), conflict: None });
        }
    }
    Ok(CommitInfo { message: message.trim_end().to_string(), files })
}

/// \brief The commits that touched `path` from `revs`, across renames, each with the file's name there.
#[tauri::command(async)]
fn file_log(repo: String, revs: Vec<String>, path: String) -> Result<Vec<(Commit, Change)>, String> {
    let mut args = vec!["log", "--follow", "-M", "--name-status", "-z", "--format=%x1e%H%x00%P%x00%an%x00%at%x00%s"];
    for r in &revs {
        args.push(rev(r)?);
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
            let commit = Commit {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                author: f[2].to_string(),
                time: f[3].parse().unwrap_or(0),
                refs: Vec::new(),
                subject: f[4].to_string(),
                body: String::new(),
            };
            let change = Change { path: name.clone(), old: old.clone(), code: code.get(0..1).unwrap_or("M").into(), conflict: None };
            // the name before a rename holds for the older commits
            if let Some(o) = old {
                name = o;
            }
            Some((commit, change))
        })
        .collect())
}

/// \brief `git blame --porcelain` of `path` at commit `at`, or of the working tree file.
#[tauri::command(async)]
fn blame(repo: String, at: String, path: String) -> Result<String, String> {
    if at == "WORKTREE" {
        return git(&repo, &["blame", "--porcelain", "--", &path]);
    }
    git(&repo, &["blame", "--porcelain", rev(&at)?, "--", &path])
}

/// \brief File content `at` a commit, "INDEX" or "WORKTREE".
#[tauri::command(async)]
fn blob(repo: String, at: String, path: String) -> Result<Blob, String> {
    let bytes = match at.as_str() {
        "WORKTREE" => {
            let p = work_path(&repo, &path)?;
            match std::fs::symlink_metadata(&p) {
                // git stores the link target, not what it points to
                Ok(m) if m.file_type().is_symlink() => std::fs::read_link(&p).ok().map(|t| t.to_string_lossy().into_owned().into_bytes()),
                Ok(_) => std::fs::read(&p).ok(),
                Err(_) => None,
            }
        }
        "INDEX" => git_in(&repo, &["cat-file", "blob", &format!(":{path}")], None).ok(),
        r => git_in(&repo, &["cat-file", "blob", &format!("{}:{path}", rev(r)?)], None).ok(),
    };
    let Some(bytes) = bytes else {
        return Ok(Blob { text: String::new(), exists: false, binary: false });
    };
    // non-UTF-8 counts as binary: a lossy round trip would corrupt it on save/stage
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(Blob { text, exists: true, binary: false }),
        _ => Ok(Blob { text: String::new(), exists: true, binary: true }),
    }
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
    let sha = git_in(&repo, &["hash-object", "-w", "--stdin"], Some(text.as_bytes()))?;
    let sha = String::from_utf8_lossy(&sha).trim().to_string();
    git(&repo, &["update-index", "--add", "--cacheinfo", &format!("{mode},{sha},{path}")]).map(|_| ())
}

/// \brief Every file path in the tree of commit `at`.
#[tauri::command(async)]
fn files(repo: String, at: String) -> Result<Vec<String>, String> {
    let out = git_in(&repo, &["ls-tree", "-r", "-z", "--name-only", rev(&at)?], None)?;
    Ok(out.split(|&b| b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect())
}

/// \brief The fetch URL of remote `name`.
#[tauri::command(async)]
fn remote_url(repo: String, name: String) -> Result<String, String> {
    git(&repo, &["remote", "get-url", rev(&name)?]).map(|u| u.trim().to_string())
}

#[derive(Serialize)]
struct RemoteUrls {
    fetch: String,
    push: String,
}

/// \brief Fetch and push URLs of remote `name`.
#[tauri::command(async)]
fn remote_urls(repo: String, name: String) -> Result<RemoteUrls, String> {
    let name = rev(&name)?;
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
        git(&repo, &["remote", "rename", rev(&name)?, rev(&new_name)?])?;
        cur = new_name;
    }
    // an untouched push URL keeps following the fetch one
    if fetch != old.fetch {
        git(&repo, &["remote", "set-url", &cur, rev(&fetch)?])?;
    }
    if push != old.push {
        git(&repo, &["remote", "set-url", "--push", &cur, rev(&push)?])?;
    }
    Ok(())
}

/// \brief Open `path` with the desktop's default app, or the folder holding it.
#[tauri::command(async)]
fn open_default(repo: String, path: String, folder: bool) -> Result<(), String> {
    let p = work_path(&repo, &path)?;
    if !p.exists() {
        return Err(format!("{path} is not in the working tree"));
    }
    let target = if folder { p.parent().unwrap_or(&p).to_path_buf() } else { p };
    reap(Command::new("xdg-open").arg(target).spawn().map_err(|e| e.to_string())?);
    Ok(())
}

/// \brief Delete `path` from the work tree.
#[tauri::command(async)]
fn delete_file(repo: String, path: String) -> Result<(), String> {
    std::fs::remove_file(work_path(&repo, &path)?).map_err(|e| e.to_string())
}

/// \brief Whether `path` exists in the work tree.
#[tauri::command]
fn in_worktree(repo: String, path: String) -> Result<bool, String> {
    Ok(work_path(&repo, &path)?.exists())
}

/// \brief Whether `git branch -d` takes `branch`: merged into its upstream, or into HEAD without one.
#[tauri::command(async)]
fn is_merged(repo: String, branch: String) -> Result<bool, String> {
    let into = git(&repo, &["rev-parse", "--abbrev-ref", &format!("{}@{{upstream}}", rev(&branch)?)]).unwrap_or_else(|_| "HEAD".into());
    Ok(git_run(&repo, &["merge-base", "--is-ancestor", &format!("refs/heads/{branch}"), into.trim()], None)?.status.success())
}

/// \brief Open `path` in VS Code at `line`, else in the desktop's default app.
#[tauri::command(async)]
fn open_in_editor(repo: String, path: String, line: u32) -> Result<(), String> {
    let p = work_path(&repo, &path)?;
    if !p.exists() {
        return Err(format!("{path} is not in the working tree"));
    }
    let child = Command::new("code")
        .arg("-g")
        .arg(format!("{}:{line}", p.display()))
        .spawn()
        .or_else(|_| Command::new("xdg-open").arg(&p).spawn())
        .map_err(|e| e.to_string())?;
    reap(child);
    Ok(())
}

#[tauri::command(async)]
fn git_op(repo: String, op: String, arg: String, arg2: Option<String>) -> Result<String, String> {
    let state = op_state(&repo)?;
    let arg2 = arg2.unwrap_or_default();
    let upstream = format!("HEAD:refs/heads/{arg2}");
    if op == "stash-message" {
        // git cannot reword a stash: store it again under the new message, then drop the old entry
        let n: u32 = arg.strip_prefix("stash@{").and_then(|s| s.strip_suffix('}')).and_then(|s| s.parse().ok()).ok_or_else(|| format!("{arg} is not a stash"))?;
        let hash = git(&repo, &["rev-parse", &arg])?;
        git(&repo, &["stash", "store", "-m", &arg2, hash.trim()])?;
        let old = format!("stash@{{{}}}", n + 1);
        if git(&repo, &["rev-parse", &old])? != hash {
            return Err(format!("{old} moved, kept both entries"));
        }
        return git_loud(&repo, &["stash", "drop", &old]);
    }
    if let Some(stage) = match op.as_str() {
        "take-current" => Some("2"),
        "take-incoming" => Some("3"),
        "take-base" => Some("1"),
        _ => None,
    } {
        // a side without a version of the file deleted it
        let has = git(&repo, &["ls-files", "-u", "--", &arg])?.lines().any(|l| l.split_whitespace().nth(2) == Some(stage));
        if !has {
            return git_loud(&repo, &["rm", "-q", "--", &arg]);
        }
        git(&repo, &["checkout-index", "-f", &format!("--stage={stage}"), "--", &arg])?;
        return git_loud(&repo, &["add", "--", &arg]);
    }
    if op == "resolve-all" {
        let files = git(&repo, &["diff", "--name-only", "--diff-filter=U", "-z"])?;
        let mut args = vec!["add", "-A", "--"];
        args.extend(files.split('\0').filter(|p| !p.is_empty()));
        return git_loud(&repo, &args);
    }
    // a reworded rebase step: commit it here, the rebase then moves on from it
    if op == "continue" && state == "rebase" && !arg.is_empty() && git(&repo, &["diff", "--cached", "--quiet"]).is_err() {
        git(&repo, &["commit", "-q", "-m", &arg])?;
    }
    if op == "discard-all" {
        git(&repo, &["reset", "-q", "--hard"])?;
        return git_loud(&repo, &["clean", "-fd"]);
    }
    let args: Vec<&str> = match op.as_str() {
        "fetch" => vec!["fetch", "--all", "--prune"],
        "pull" => vec!["pull"],
        "push" => vec!["push"],
        "stash" => vec!["stash", "push", "-u"],
        "pop" => vec!["stash", "pop"],
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
        "reset-soft" => vec!["reset", "--soft", rev(&arg)?],
        "reset-keep" => vec!["reset", "--keep", rev(&arg)?],
        "reset-mixed" => vec!["reset", "-q", "--mixed", rev(&arg)?],
        "reset-hard" => vec!["reset", "-q", "--hard", rev(&arg)?],
        "revert" => vec!["revert", "--no-edit", rev(&arg)?],
        // the branch moves to the commit, then is checked out
        "checkout-reset" => vec!["checkout", "-B", rev(&arg)?, rev(&arg2)?],
        // arg is the new name, arg2 where it starts
        "branch-create" => vec!["checkout", "-b", rev(&arg)?, rev(&arg2)?],
        "branch-rename" => vec!["branch", "-m", rev(&arg)?, rev(&arg2)?],
        // annotated, the name as message: tag.gpgSign makes git refuse a tag without one
        "tag-create" => vec!["tag", "-m", &arg, rev(&arg)?, rev(&arg2)?],
        // arg is the remote, arg2 the branch on it
        "push-delete" => vec!["push", rev(&arg)?, "--delete", rev(&arg2)?],
        "fetch-remote" => vec!["fetch", "--prune", rev(&arg)?],
        // first push of a branch: arg is the remote, arg2 the branch name there
        "push-upstream" => vec!["push", "-u", rev(&arg)?, rev(&arg2).map(|_| upstream.as_str())?],
        // worktree only: the restored file shows up unstaged, for review
        "restore-file" => vec!["restore", "--source", rev(&arg)?, "--", &arg2],
        "checkout" => vec!["checkout", rev(&arg)?],
        "merge" => vec!["merge", rev(&arg)?],
        "rebase" => vec!["rebase", rev(&arg)?],
        "cherry-pick" => vec!["cherry-pick", rev(&arg)?],
        "delete-branch" => vec!["branch", "-d", rev(&arg)?],
        "force-delete-branch" => vec!["branch", "-D", rev(&arg)?],
        "stash-apply" => vec!["stash", "apply", rev(&arg)?],
        "stash-pop" => vec!["stash", "pop", rev(&arg)?],
        "stash-drop" => vec!["stash", "drop", rev(&arg)?],
        "continue" if state == "merge" && !arg.is_empty() => vec!["commit", "-m", &arg],
        "continue" if state == "merge" => vec!["commit", "--no-edit"],
        "skip" if state != "merge" && !state.is_empty() => vec![state.as_str(), "--skip"],
        "continue" if !state.is_empty() => vec![state.as_str(), "--continue"],
        "abort" if !state.is_empty() => vec![state.as_str(), "--abort"],
        _ => return Err(format!("{op}: nothing to do")),
    };
    git_loud(&repo, &args)
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

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
struct Ptys(Mutex<(u32, HashMap<u32, Pty>)>);

const fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// \brief Start the user's shell in `repo`; output streams to `on_data`, an empty chunk means it exited.
#[tauri::command(async)]
fn pty_spawn(ptys: State<'_, Ptys>, repo: String, cols: u16, rows: u16, on_data: Channel) -> Result<u32, String> {
    let pair = native_pty_system().openpty(pty_size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&repo);
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n @ 1..) = reader.read(&mut buf) {
            if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                return;
            }
        }
        let _ = on_data.send(InvokeResponseBody::Raw(Vec::new()));
    });
    let mut guard = ptys.0.lock().unwrap();
    guard.0 += 1;
    let id = guard.0;
    guard.1.insert(id, Pty { master: pair.master, writer, child });
    Ok(id)
}

// sync on purpose: async commands run on a pool and could reorder keystrokes
#[tauri::command]
fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut guard = ptys.0.lock().unwrap();
    let pty = guard.1.get_mut(&id).ok_or("no such terminal")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let guard = ptys.0.lock().unwrap();
    let pty = guard.1.get(&id).ok_or("no such terminal")?;
    pty.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn pty_kill(ptys: State<'_, Ptys>, id: u32) -> Result<(), String> {
    let pty = ptys.0.lock().unwrap().1.remove(&id);
    if let Some(mut pty) = pty {
        let _ = pty.child.kill();
        let _ = pty.child.wait();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![
            initial_repo, init, clone, repo_root, log, status, refs, op_info, conflict_text, commit_info, blob, file_log, blame, write_file, stage_text, git_op, files, open_in_editor, in_worktree, is_merged,
            remote_url, open_default, delete_file, open_url, remote_urls, edit_remote,
            pty_spawn, pty_write, pty_resize, pty_kill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
