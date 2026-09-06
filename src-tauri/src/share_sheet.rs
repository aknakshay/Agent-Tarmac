use base64::Engine;
use tauri::{AppHandle, Manager};

/// Writes the snapshot PNG to a fixed cache-dir path and, on macOS, presents
/// the native share sheet (`NSSharingServicePicker`) anchored to the main
/// window so the user can hand the image to Mail, Messages, AirDrop, etc.
/// On every other platform this returns an error — the frontend's fallback
/// chain (clipboard, already attempted before this is ever called) is what
/// covers Windows/Linux, not this command.
#[tauri::command]
pub fn share_snapshot_png(app: AppHandle, data_b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("invalid base64: {e}"))?;

    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache dir: {e}"))?;
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("failed to create cache dir: {e}"))?;
    let file_path = cache_dir.join("tarmac-snapshot.png");
    std::fs::write(&file_path, &bytes).map_err(|e| format!("failed to write file: {e}"))?;

    #[cfg(target_os = "macos")]
    {
        macos::present(&app, file_path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = file_path;
        Err("share sheet not supported on this platform".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_app_kit::{NSSharingServicePicker, NSView};
    use objc2_foundation::{NSArray, NSRectEdge, NSString, NSURL};
    use tauri::{AppHandle, Manager};

    thread_local! {
        // NSSharingServicePicker isn't kept alive by AppKit on our behalf;
        // dropping our `Retained` right after `show` would deallocate the
        // picker mid-presentation. `run_on_main_thread` only *schedules*
        // the closure — it doesn't block for a result — so we park the
        // picker here (main-thread only, hence thread_local rather than a
        // Mutex around a non-Send objc type) until the next share replaces
        // it or the app exits.
        static ACTIVE_PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> =
            const { RefCell::new(None) };
    }

    pub fn present(app: &AppHandle, file_path: PathBuf) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;

        window
            .clone()
            .run_on_main_thread(move || {
                if let Err(err) = show_picker(&window, &file_path) {
                    eprintln!("[share_sheet] failed to present NSSharingServicePicker: {err}");
                }
            })
            .map_err(|e| e.to_string())
    }

    fn show_picker(window: &tauri::WebviewWindow, file_path: &Path) -> Result<(), String> {
        let view_ptr = window.ns_view().map_err(|e| e.to_string())?;
        if view_ptr.is_null() {
            return Err("ns_view returned null".to_string());
        }
        let view: &NSView = unsafe { &*(view_ptr as *const NSView) };

        let path_str = file_path.to_string_lossy();
        let ns_path = NSString::from_str(&path_str);
        let url = NSURL::fileURLWithPath(&ns_path);
        let items: Retained<NSArray> = NSArray::from_slice(&[url.as_ref()]);

        let picker = unsafe {
            NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items)
        };
        picker.showRelativeToRect_ofView_preferredEdge(view.bounds(), view, NSRectEdge::MaxY);

        ACTIVE_PICKER.with(|cell| {
            *cell.borrow_mut() = Some(picker);
        });
        Ok(())
    }
}
