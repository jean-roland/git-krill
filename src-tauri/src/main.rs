// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // started from a terminal: run on in its own session and give the prompt back (`</dev/null` keeps it in front); never as git's askpass helper
    #[cfg(all(unix, not(debug_assertions)))]
    if std::io::IsTerminal::is_terminal(&std::io::stdin()) && std::env::var_os("KRILL_ASKPASS").is_none() {
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        if let Ok(exe) = std::env::current_exe() {
            let mut me = Command::new(exe);
            me.args(std::env::args_os().skip(1)).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            unsafe { me.pre_exec(|| (libc::setsid() >= 0).then_some(()).ok_or_else(std::io::Error::last_os_error)) };
            if me.spawn().is_ok() {
                return;
            }
        }
    }
    krill_lib::run()
}
