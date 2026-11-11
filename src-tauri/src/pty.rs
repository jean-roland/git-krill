//! The terminal panel's shells, one pty each, in the tab's repository.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

struct Pty {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<String>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys(Mutex<(u32, HashMap<u32, Pty>)>);

const fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
}

/// \brief Start the user's shell in `repo`; output streams to `on_data`, an empty chunk means it exited.
#[tauri::command(async)]
pub fn pty_spawn(ptys: State<'_, Ptys>, repo: String, cols: u16, rows: u16, on_data: Channel) -> Result<u32, String> {
    let pair = native_pty_system().openpty(pty_size(cols, rows)).map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&repo);
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    // a write blocks while the program in front does not read: keep that off the main thread
    let (input, keys) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for data in keys {
            if writer.write_all(data.as_bytes()).is_err() {
                return;
            }
        }
    });
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
    guard.1.insert(id, Pty { master: pair.master, input, child });
    Ok(id)
}

// sync on purpose: async commands run on a pool and could reorder keystrokes
#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let guard = ptys.0.lock().unwrap();
    let pty = guard.1.get(&id).ok_or("no such terminal")?;
    pty.input.send(data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let guard = ptys.0.lock().unwrap();
    let pty = guard.1.get(&id).ok_or("no such terminal")?;
    pty.master.resize(pty_size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_kill(ptys: State<'_, Ptys>, id: u32) -> Result<(), String> {
    let pty = ptys.0.lock().unwrap().1.remove(&id);
    if let Some(mut pty) = pty {
        let _ = pty.child.kill();
        let _ = pty.child.wait();
    }
    Ok(())
}
