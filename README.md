<h1 align="center"><img src="src-tauri/icons/128x128@2x.png" alt="" width="72" align="center"> Git Krill</h1>

A lean desktop git client for Linux, Windows and macOS: a commit graph, diffs you can stage from, a merge tool, and little else. It runs the `git` you already have, so your config, hooks, keys and credentials apply as usual.

![The commit graph, with a commit's details](docs/screenshots/graph.png)

## Features

- **Graph**: every branch in lanes, with branch and tag labels, generated author avatars, and search (Ctrl+F). Branches, tags, remotes and stashes can be hidden one by one.
- **Changes**: stage and unstage whole files, hunks or single lines; commit, amend, reword; discard with undo (Ctrl+Z).
- **Diffs**: hunk, inline or side-by-side views; the working tree file can be edited and saved in place; a commit's hunk can be reverted.
- **Images**: old and new side by side; an SVG as its text or drawn. Other binary files open in their default program.
- **Conflicts**: a three-pane merge tool with picks per hunk or per line, then finish or abort the merge or rebase; recorded resolutions can be reused (git rerere).
- **Interactive rebase**: pick, reword, squash or drop commits, and reorder them by dragging.
- **File history**: each version of a file, as a diff or in full with blame.
- **Branches and remotes**: checkout, create, merge, rebase, reset, delete (local and upstream); fetch, pull and push, with a fetch in the background.
- **Stashes, tags, worktrees and submodules** from the sidebar; a worktree or a submodule opens in the same tab, Esc steps back.
- **Git LFS**: files diffed by their content, missing versions downloaded on demand; track, untrack and prune from the menus.
- **Commits** show whether the server verified their signature (with the GitHub CLI).
- **Settings**: tool status, background fetch, the editor command, and the global git identity.
- **Tabs**, one repository each, and a terminal in each tab (Ctrl+`).
- SSH passphrase and HTTPS password prompts show in the window.

![A diff with Stage hunk buttons](docs/screenshots/diff.png)

![The three-pane merge tool](docs/screenshots/merge.png)

![A file's history with blame](docs/screenshots/history.png)

## Install

From the [releases](https://github.com/jean-roland/git-krill/releases):

- **Linux** (Debian, Ubuntu): `sudo apt install ./git-krill_0.2.0_amd64.deb`, then run `git-krill`, or `git-krill path/to/repo`.
- **Windows**: run `git-krill_0.2.0_x64-setup.exe`. It is not signed: SmartScreen asks first, "More info" then "Run anyway". Needs [Git for Windows](https://git-scm.com/download/win).
- **macOS**: open `git-krill_0.2.0_universal.dmg` and drag Git Krill to Applications. It is not notarized: the first launch is refused, then System Settings > Privacy & Security > "Open Anyway". Needs git: `xcode-select --install`, or Homebrew's.

Needs `git` (tested with 2.43; before 2.40 a commit's files lack their LFS chip). "Open in editor" runs the command set in Settings, VS Code's `code` by default.

## Build

Needs Rust 1.88 or newer, Node.js 18 or newer, and Tauri's system libraries (on Windows and macOS, see Tauri's [prerequisites](https://v2.tauri.app/start/prerequisites/)):

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
npm install
npx tauri build              # the .deb lands in src-tauri/target/release/bundle/deb/
npx tauri build --no-bundle  # the bare binary only: src-tauri/target/release/git-krill
npm test
```

## Keys

| Key | Action |
| --- | --- |
| Ctrl+T, Ctrl+W, Ctrl+Shift+T | New tab, close it, reopen the last closed |
| Ctrl+Tab, Ctrl+Shift+Tab | Next, previous tab |
| Ctrl+O | Open a repository |
| Alt+← | Back from a worktree or a submodule to its repository |
| Ctrl+F | Search the graph |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+` | Terminal |
| F5 | Refresh |
| Arrows | Move through commits and files, open and close diffs |
| Escape | Close the open view or dialog |

On macOS, Cmd in place of Ctrl, but for Ctrl+Tab and Ctrl+`.

## Big repositories

The graph loads 3000 commits at a time, with "Load more commits" at its bottom. On tens of thousands of commits, git's commit-graph file halves the time it takes to read the history. `git gc` writes it; to have every fetch keep it current:

```sh
git config --global fetch.writeCommitGraph true
```

## Licence

[MIT](LICENSE)
