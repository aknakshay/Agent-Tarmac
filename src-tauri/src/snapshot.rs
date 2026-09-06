use base64::Engine;
use std::path::Path;

/// Writes a base64-encoded PNG to `path`, for the tokenmaxxing share card's
/// save-dialog fallback (used when the webview's clipboard image write is
/// unavailable). Deliberately narrow instead of a general-purpose fs-write
/// plugin: `path` always comes back from a native save dialog the user just
/// drove, so the only thing worth guarding here is that this command can't
/// be pointed at an arbitrary non-image file — the `.png` + absolute-path
/// checks are that guard, not a security boundary against an untrusted
/// caller (there isn't one; this app has no remote content).
#[tauri::command]
pub fn save_snapshot_png(path: String, data_b64: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    if !file_path.is_absolute() {
        return Err("path must be absolute".to_string());
    }
    if file_path.extension().and_then(|e| e.to_str()) != Some("png") {
        return Err("path must end with .png".to_string());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("invalid base64: {e}"))?;

    std::fs::write(file_path, bytes).map_err(|e| format!("failed to write file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_png_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.jpg");
        let err = save_snapshot_png(path.to_str().unwrap().to_string(), String::new()).unwrap_err();
        assert!(err.contains(".png"));
        assert!(!path.exists());
    }

    #[test]
    fn rejects_relative_path() {
        let err =
            save_snapshot_png("relative/snapshot.png".to_string(), String::new()).unwrap_err();
        assert!(err.contains("absolute"));
    }

    #[test]
    fn writes_decoded_bytes_to_an_absolute_png_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.png");
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"fake-png-bytes");
        save_snapshot_png(path.to_str().unwrap().to_string(), encoded).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"fake-png-bytes");
    }

    #[test]
    fn rejects_invalid_base64() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("snapshot.png");
        let err = save_snapshot_png(
            path.to_str().unwrap().to_string(),
            "not valid base64!!".to_string(),
        )
        .unwrap_err();
        assert!(err.contains("base64"));
        assert!(!path.exists());
    }
}
