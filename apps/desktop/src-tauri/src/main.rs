//! Native capabilities for the wordwork desktop client.
//!
//! Everything the web layer cannot do by itself lives here: choosing real files
//! through the OS dialog, reading and writing them, launching Word/WPS, showing
//! OS notifications and keeping the session on disk (DPAPI-protected on Windows).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Serialize)]
struct PickedFile {
    path: String,
    name: String,
    bytes: String,
}

/* ------------------------------------------------------------------ */
/* Session / configuration persistence                                 */
/* ------------------------------------------------------------------ */

fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("state.bin"))
}

/// The stored blob is DPAPI-protected on Windows. Plain JSON is also accepted on
/// read so a state file copied from another machine still loads.
fn encode_state(json: &str) -> Vec<u8> {
    match secret::protect(json.as_bytes()) {
        Some(blob) => blob,
        None => json.as_bytes().to_vec(),
    }
}

fn decode_state(raw: &[u8]) -> Option<String> {
    if raw.first() == Some(&b'{') {
        return String::from_utf8(raw.to_vec()).ok();
    }
    let plain = secret::unprotect(raw)?;
    String::from_utf8(plain).ok()
}

#[tauri::command]
fn load_state(app: AppHandle) -> Option<serde_json::Value> {
    let path = state_file(&app).ok()?;
    let raw = fs::read(path).ok()?;
    let text = decode_state(&raw)?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
fn save_state(app: AppHandle, state: serde_json::Value) -> Result<bool, String> {
    let path = state_file(&app)?;
    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("tmp");
    fs::write(&temp, encode_state(&json)).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())?;
    Ok(true)
}

/* ------------------------------------------------------------------ */
/* File system                                                         */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn pick_docx(app: AppHandle) -> Option<PickedFile> {
    let chosen = app
        .dialog()
        .file()
        .set_title("选择 Word 文档")
        .add_filter("Word 文档", &["docx"])
        .blocking_pick_file()?;
    let path = chosen.into_path().ok()?;
    let bytes = fs::read(&path).ok()?;
    Some(PickedFile {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document.docx".into()),
        path: path.to_string_lossy().to_string(),
        bytes: BASE64.encode(bytes),
    })
}

#[tauri::command]
async fn pick_save_path(app: AppHandle, default_name: String) -> Option<String> {
    let chosen = app
        .dialog()
        .file()
        .set_title("保存到")
        .set_file_name(&default_name)
        .add_filter("Word 文档", &["docx"])
        .blocking_save_file()?;
    chosen.into_path().ok().map(|p| p.to_string_lossy().to_string())
}

/// Write through a temporary file and rename it into place.
///
/// A plain `fs::write` truncates the destination first, so a crash (or a full disk)
/// halfway through leaves the user with a half-written, un-openable .docx where
/// their work copy used to be. Renaming a complete file over the old one is the
/// closest thing to an atomic replace Windows offers without extra crates.
#[tauri::command]
fn write_file(path: String, bytes: String) -> Result<bool, String> {
    let data = BASE64.decode(bytes.as_bytes()).map_err(|e| e.to_string())?;
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut temp = target.clone();
    let temp_name = format!(
        "{}.wordwork-tmp",
        target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into())
    );
    temp.set_file_name(temp_name);
    fs::write(&temp, data).map_err(|e| e.to_string())?;
    // `fs::rename` maps to MoveFileExW(MOVEFILE_REPLACE_EXISTING) on Windows, so an
    // existing destination is replaced rather than causing an error.
    fs::rename(&temp, &target).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })?;
    Ok(true)
}

/* ------------------------------------------------------------------ */
/* Offline queue snapshots                                             */
/* ------------------------------------------------------------------ */

fn snapshot_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("snapshots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keep an immutable copy of a file the user is about to submit, keyed by its
/// content hash. The working copy on the desktop can then be overwritten (or the
/// user can re-download the base version) without the queued submission changing
/// underneath us — which is what a queue that only stored a path would do.
///
/// `namespace` is the account bucket (`server + member id`) so two people sharing
/// one Windows login cannot read, submit or delete each other's snapshots.
#[tauri::command]
fn save_snapshot(app: AppHandle, namespace: String, sha256: String, bytes: String) -> Result<String, String> {
    let key: String = sha256.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if key.is_empty() {
        return Err("缺少内容校验值".into());
    }
    let bucket: String = namespace
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if bucket.is_empty() {
        return Err("缺少账号标识".into());
    }
    let dir = snapshot_dir(&app)?.join(bucket);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let data = BASE64.decode(bytes.as_bytes()).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{key}.docx"));
    if path.is_file() {
        return Ok(path.to_string_lossy().to_string());
    }
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn remove_file(path: String) -> Result<bool, String> {
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<Option<String>, String> {
    match fs::read(&path) {
        Ok(data) => Ok(Some(BASE64.encode(data))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

/// Why a destination path can or cannot be written to right now.
///
/// A `bool` is not enough: "Word has the file open" and "that folder does not
/// exist" need different advice, and reporting the second as the first sends the
/// user chasing the wrong problem. That is exactly what happened to a download
/// into a brand-new file name — `OpenOptions::write(true)` returns `NotFound`
/// when nothing is there yet, and every error used to be read as "not released",
/// so a brand-new target was always reported as a Word/WPS lock.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
enum WriteProbe {
    /// Free to write: the target does not exist yet, or nothing holds it open.
    Writable,
    /// The target exists and another process (Word/WPS) holds it open.
    Locked,
    /// The parent directory does not exist or is not a directory.
    MissingParent,
    /// The target path is itself a directory.
    IsDirectory,
    /// The OS refused access: a read-only attribute, or a restrictive ACL.
    Denied,
    /// Anything else, carrying the OS message so the cause stays diagnosable.
    Error { message: String },
}

/// Map an open-for-write failure onto the advice the user actually needs.
///
/// `ERROR_SHARING_VIOLATION` (32) is what Word/WPS produce while they hold the
/// document open; `ERROR_LOCK_VIOLATION` (33) is the byte-range equivalent. Both
/// must be checked before `ErrorKind` because Windows maps them onto
/// `PermissionDenied`, which we would otherwise report as an ACL problem.
fn classify_open_error(err: &std::io::Error) -> WriteProbe {
    if matches!(err.raw_os_error(), Some(32) | Some(33)) {
        return WriteProbe::Locked;
    }
    match err.kind() {
        std::io::ErrorKind::PermissionDenied => WriteProbe::Denied,
        std::io::ErrorKind::NotFound => WriteProbe::MissingParent,
        _ => WriteProbe::Error { message: err.to_string() },
    }
}

fn probe_write_target_at(path: &Path) -> WriteProbe {
    match fs::metadata(path) {
        Ok(meta) if meta.is_dir() => WriteProbe::IsDirectory,
        // Opening for write without `truncate` only asks the OS for access; it does
        // not modify the file. It is the cheapest way to learn whether a share lock
        // is outstanding.
        Ok(_) => match fs::OpenOptions::new().write(true).open(path) {
            Ok(_) => WriteProbe::Writable,
            Err(e) => classify_open_error(&e),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // "Save as a new file" lands here for every download into a fresh name.
            // Nothing can be holding a file that does not exist, so the only real
            // question left is whether the containing folder is there to write into.
            match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => match fs::metadata(parent) {
                    Ok(meta) if meta.is_dir() => WriteProbe::Writable,
                    _ => WriteProbe::MissingParent,
                },
                // A bare file name resolves against the working directory, which exists.
                _ => WriteProbe::Writable,
            }
        }
        Err(e) => classify_open_error(&e),
    }
}

#[tauri::command]
fn probe_write_target(path: String) -> WriteProbe {
    probe_write_target_at(Path::new(&path))
}

/// Wait for Word/WPS to let go of the target, then report why we stopped.
///
/// Only `Locked` is worth waiting on: a missing folder or a denied ACL will not
/// fix itself, so those come straight back instead of stalling the UI until the
/// timeout expires.
#[tauri::command]
async fn wait_for_write_target(path: String, timeout_seconds: u64) -> WriteProbe {
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds.max(1));
    loop {
        match probe_write_target_at(Path::new(&path)) {
            WriteProbe::Writable => return WriteProbe::Writable,
            WriteProbe::Locked => {
                if Instant::now() >= deadline {
                    return WriteProbe::Locked;
                }
                sleep(Duration::from_millis(500));
            }
            other => return other,
        }
    }
}

#[tauri::command]
fn open_with_system(app: AppHandle, path: String) -> Result<bool, String> {
    if !Path::new(&path).is_file() {
        return Err("文件不存在，请重新下载工作副本".into());
    }
    app.opener()
        .open_path(path, None::<String>)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            pick_docx,
            pick_save_path,
            write_file,
            read_file,
            file_exists,
            probe_write_target,
            wait_for_write_target,
            open_with_system,
            notify,
            save_snapshot,
            remove_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run wordwork desktop");
}

/* ------------------------------------------------------------------ */
/* Windows DPAPI wrapper (no external crate, only crypt32/kernel32)     */
/* ------------------------------------------------------------------ */

mod secret {
    #[cfg(windows)]
    mod imp {
        use std::ffi::c_void;

        #[repr(C)]
        struct Blob {
            cb_data: u32,
            pb_data: *mut u8,
        }

        #[link(name = "crypt32")]
        extern "system" {
            fn CryptProtectData(
                data_in: *const Blob,
                description: *const u16,
                entropy: *const Blob,
                reserved: *const c_void,
                prompt: *const c_void,
                flags: u32,
                data_out: *mut Blob,
            ) -> i32;

            fn CryptUnprotectData(
                data_in: *const Blob,
                description: *mut *mut u16,
                entropy: *const Blob,
                reserved: *const c_void,
                prompt: *const c_void,
                flags: u32,
                data_out: *mut Blob,
            ) -> i32;
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn LocalFree(handle: *mut c_void) -> *mut c_void;
        }

        /// Never show a Windows prompt; a headless desktop must not block.
        const UI_FORBIDDEN: u32 = 0x1;

        fn take(output: Blob) -> Vec<u8> {
            let bytes = unsafe { std::slice::from_raw_parts(output.pb_data, output.cb_data as usize).to_vec() };
            unsafe { LocalFree(output.pb_data as *mut c_void) };
            bytes
        }

        pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
            let mut input = Blob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
            let mut output = Blob { cb_data: 0, pb_data: std::ptr::null_mut() };
            let ok = unsafe {
                CryptProtectData(
                    &mut input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 || output.pb_data.is_null() {
                return None;
            }
            Some(take(output))
        }

        pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
            let mut input = Blob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
            let mut output = Blob { cb_data: 0, pb_data: std::ptr::null_mut() };
            let ok = unsafe {
                CryptUnprotectData(
                    &mut input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null(),
                    UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 || output.pb_data.is_null() {
                return None;
            }
            Some(take(output))
        }
    }

    #[cfg(not(windows))]
    mod imp {
        /// Non-Windows builds keep the state file in the per-user app config
        /// directory. macOS Keychain integration is not part of the pilot.
        pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
            Some(data.to_vec())
        }

        pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
            Some(data.to_vec())
        }
    }

    pub use imp::{protect, unprotect};
}

/* ------------------------------------------------------------------ */
/* Write-probe tests                                                   */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    /// A private scratch directory per test, without pulling in a temp-dir crate.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wordwork-probe-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_target_that_does_not_exist_yet_is_writable() {
        let dir = scratch("missing");
        // The "download to a brand-new file name" case. This used to be reported as
        // a Word/WPS lock because `NotFound` was folded into "not released".
        assert_eq!(probe_write_target_at(&dir.join("brand-new.docx")), WriteProbe::Writable);
    }

    #[test]
    fn an_unheld_existing_file_is_writable() {
        let dir = scratch("free");
        let file = dir.join("existing.docx");
        fs::write(&file, b"placeholder").unwrap();
        assert_eq!(probe_write_target_at(&file), WriteProbe::Writable);
    }

    #[test]
    fn a_missing_parent_directory_is_reported_as_such() {
        let dir = scratch("noparent");
        assert_eq!(
            probe_write_target_at(&dir.join("no-such-folder").join("x.docx")),
            WriteProbe::MissingParent
        );
    }

    #[test]
    fn a_directory_target_is_not_a_writable_file() {
        let dir = scratch("isdir");
        let nested = dir.join("a-folder");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(probe_write_target_at(&nested), WriteProbe::IsDirectory);
    }

    #[cfg(windows)]
    #[test]
    fn a_read_only_file_is_reported_as_denied_not_locked() {
        let dir = scratch("readonly");
        let file = dir.join("readonly.docx");
        fs::write(&file, b"placeholder").unwrap();
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file, perms).unwrap();

        let probe = probe_write_target_at(&file);

        // Clear the attribute again so the scratch directory can be cleaned up.
        let mut perms = fs::metadata(&file).unwrap().permissions();
        perms.set_readonly(false);
        fs::set_permissions(&file, perms).unwrap();

        assert_eq!(probe, WriteProbe::Denied);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_held_open_by_another_process_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = scratch("locked");
        let file = dir.join("held-open.docx");
        fs::write(&file, b"placeholder").unwrap();
        // `share_mode(0)` is what Word effectively does: nobody else may open it.
        let held = fs::OpenOptions::new().write(true).share_mode(0).open(&file).unwrap();

        let probe = probe_write_target_at(&file);
        drop(held);

        assert_eq!(probe, WriteProbe::Locked);
    }
}
