//! krill as ssh's and git's askpass helper: their prompts reach the window's dialog through a unix socket.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

// krill's own binary and the socket it answers on, for ssh and git to ask a passphrase or password through
static ASKPASS: OnceLock<(PathBuf, PathBuf)> = OnceLock::new();

// where the window's answer to the pending prompt goes
#[derive(Default)]
pub struct Askpass(Mutex<Option<mpsc::Sender<Option<String>>>>);

/// \brief Point a git run's prompts at krill: with `ask` they reach the dialog, without they fail at once and say so.
pub fn env(git: &mut Command, ask: bool) {
    match ASKPASS.get() {
        Some((exe, sock)) => git.env("SSH_ASKPASS", exe).env("GIT_ASKPASS", exe).env("SSH_ASKPASS_REQUIRE", "force").env("KRILL_ASKPASS", if ask { sock.as_os_str() } else { "".as_ref() }),
        None => git.env("SSH_ASKPASS_REQUIRE", "never").env_remove("SSH_ASKPASS").env_remove("GIT_ASKPASS"),
    };
}

/// \brief Started by ssh or git as their askpass helper: the question goes to the running krill, and krill exits with its answer.
pub fn helper() {
    let Some(sock) = std::env::var_os("KRILL_ASKPASS") else { return };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    // no socket: a background run nobody can answer, so only say what was needed
    if sock.is_empty() {
        eprintln!("krill: needs a passphrase or password: {prompt}");
        std::process::exit(1);
    }
    std::process::exit(ask(Path::new(&sock), &prompt));
}

/// \brief Send the prompt to the running krill, print its answer; no answer is a cancel.
fn ask(sock: &Path, prompt: &str) -> i32 {
    let Ok(mut s) = UnixStream::connect(sock) else { return 1 };
    let mut answer = String::new();
    if writeln!(s, "{}", prompt.replace('\n', " ")).is_err() || s.read_to_string(&mut answer).is_err() || answer.is_empty() {
        return 1;
    }
    print!("{answer}");
    0
}

/// \brief Listen for askpass helpers in a folder only this user can enter.
pub fn start(app: &tauri::AppHandle) -> std::io::Result<()> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(format!("krill-{}", std::process::id()));
    // a dead krill with the same pid left it
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    let sock = dir.join("askpass");
    let listener = UnixListener::bind(&sock)?;
    // the path as started: a rebuild replaces the file, and its new binary answers the same way
    let _ = ASKPASS.set((std::env::current_exe()?, sock));
    let app = app.clone();
    std::thread::spawn(move || {
        // one prompt at a time: ssh asks again only after the answer
        for mut s in listener.incoming().flatten() {
            let mut prompt = String::new();
            if BufReader::new(&s).read_line(&mut prompt).is_err() {
                continue;
            }
            let (tx, rx) = mpsc::channel();
            *app.state::<Askpass>().0.lock().unwrap() = Some(tx);
            if app.emit("askpass", prompt.trim_end()).is_ok() && let Ok(Some(answer)) = rx.recv() {
                let _ = writeln!(s, "{answer}");
            }
        }
    });
    Ok(())
}

/// \brief Remove the socket's folder, on exit.
pub fn stop() {
    if let Some((_, sock)) = ASKPASS.get() {
        let _ = sock.parent().map(std::fs::remove_dir_all);
    }
}

/// \brief The window's answer to the pending prompt, `None` when cancelled.
#[tauri::command]
pub fn askpass_reply(answer: Option<String>, ask: State<Askpass>) {
    if let Some(tx) = ask.0.lock().unwrap().take() {
        let _ = tx.send(answer);
    }
}
