//! krill as ssh's and git's askpass helper: their prompts reach the window's dialog over a loopback connection that only krill's children hold the key to.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{mpsc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};

// krill's own binary, and where it answers with the key a helper must show: "127.0.0.1:<port> <key>"
static ASKPASS: OnceLock<(PathBuf, String)> = OnceLock::new();

// where the window's answer to the pending prompt goes
#[derive(Default)]
pub struct Askpass(Mutex<Option<mpsc::Sender<Option<String>>>>);

/// \brief Point a git run's prompts at krill: with `ask` they reach the dialog, without they fail at once and say so.
pub fn env(git: &mut Command, ask: bool) {
    match ASKPASS.get() {
        Some((exe, at)) => git.env("SSH_ASKPASS", exe).env("GIT_ASKPASS", exe).env("SSH_ASKPASS_REQUIRE", "force").env("KRILL_ASKPASS", if ask { at.as_str() } else { "" }),
        None => git.env("SSH_ASKPASS_REQUIRE", "never").env_remove("SSH_ASKPASS").env_remove("GIT_ASKPASS"),
    };
}

/// \brief Started by ssh or git as their askpass helper: the question goes to the running krill, and krill exits with its answer.
pub fn helper() {
    let Some(at) = std::env::var_os("KRILL_ASKPASS") else { return };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    // nowhere to ask: a background run nobody can answer, so only say what was needed
    if at.is_empty() {
        eprintln!("krill: needs a passphrase or password: {prompt}");
        std::process::exit(1);
    }
    std::process::exit(ask(&at.to_string_lossy(), &prompt));
}

/// \brief Send the key and the prompt to the running krill at `at`, print its answer; no answer is a cancel.
fn ask(at: &str, prompt: &str) -> i32 {
    let Some((addr, key)) = at.split_once(' ') else { return 1 };
    let Ok(mut s) = TcpStream::connect(addr) else { return 1 };
    let mut answer = String::new();
    if writeln!(s, "{key}\n{}", prompt.replace('\n', " ")).is_err() || s.read_to_string(&mut answer).is_err() || answer.is_empty() {
        return 1;
    }
    print!("{answer}");
    0
}

/// \brief Listen for askpass helpers on loopback: any local process can knock, only one with the key gets a dialog.
pub fn start(app: &tauri::AppHandle) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    // the path as started: a rebuild replaces the file, and its new binary answers the same way
    let _ = ASKPASS.set((std::env::current_exe()?, format!("{} {key}", listener.local_addr()?)));
    let app = app.clone();
    std::thread::spawn(move || {
        // one prompt at a time: ssh asks again only after the answer
        for mut s in listener.incoming().flatten() {
            // a caller that never speaks would hold up the next prompt
            let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let (mut shown, mut prompt) = (String::new(), String::new());
            let mut lines = BufReader::new(&s);
            if lines.read_line(&mut shown).is_err() || shown.trim_end() != key || lines.read_line(&mut prompt).is_err() {
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

/// \brief The window's answer to the pending prompt, `None` when cancelled.
#[tauri::command]
pub fn askpass_reply(answer: Option<String>, ask: State<Askpass>) {
    if let Some(tx) = ask.0.lock().unwrap().take() {
        let _ = tx.send(answer);
    }
}
