<h1 align="center"><img src="src-tauri/icons/128x128@2x.png" alt="" width="72" align="center"> Git Krill</h1>

A lean desktop git client for Linux: a commit graph, diffs you can stage from, a merge tool, and little else. It runs the `git` you already have, so your config, hooks, keys and credentials apply as usual.

## Features

- **Graph**: every branch in lanes, with branch and tag labels, generated author avatars, and search (Ctrl+F). Branches, tags, remotes and stashes can be hidden one by one.
- **Changes**: stage and unstage whole files, hunks or single lines; commit; discard with undo (Ctrl+Z).
- **Diffs**: hunk, inline or side-by-side views; the working tree file can be edited and saved in place; a commit's hunk can be reverted.
- **Conflicts**: a three-pane merge tool with picks per hunk or per line, then finish or abort the merge or rebase.
- **File history**: each version of a file, as a diff or in full with blame.
- **Branches and remotes**: checkout, create, merge, rebase, reset, delete (local and upstream); fetch, pull and push, with a fetch in the background every 5 minutes.
- **Stashes, tags and worktrees** from the sidebar.
- **Tabs**, one repository each, and a terminal in each tab (Ctrl+`).
- SSH passphrase and HTTPS password prompts show in the window.

## Install

Download the `.deb` from the [releases](https://github.com/jean-roland/Git_Krill/releases), then:

```sh
sudo apt install ./git-krill_0.1.0_amd64.deb
```

Run `krill`, or `krill path/to/repo`. Needs `git` (tested with 2.43). "Open in editor" uses VS Code's `code` command.

## Build

Needs Rust 1.85 or newer, Node.js 18 or newer, and Tauri's system libraries:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
npm install
npx tauri build              # the .deb lands in src-tauri/target/release/bundle/deb/
npx tauri build --no-bundle  # the bare binary only: src-tauri/target/release/krill
npm test
```

## Keys

| Key | Action |
| --- | --- |
| Ctrl+T, Ctrl+W, Ctrl+Shift+T | New tab, close it, reopen the last closed |
| Ctrl+Tab, Ctrl+Shift+Tab | Next, previous tab |
| Ctrl+O | Open a repository |
| Ctrl+F | Search the graph |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+` | Terminal |
| F5 | Refresh |
| Arrows | Move through commits and files, open and close diffs |
| Escape | Close the open view or dialog |

## Licence

[MIT](LICENSE)
