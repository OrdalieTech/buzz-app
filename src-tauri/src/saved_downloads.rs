//! Where `media_download` saved each relay file, so a file card can open the
//! saved copy instead of downloading it again. Only the host sees the paths.
//! The ledger is a best-effort cache that never fails a download: a record
//! whose file was moved or changed is dropped, and a ledger that cannot be
//! read starts empty.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter as _, Manager as _, Runtime};
use tauri_plugin_opener::OpenerExt as _;

/// Tells every webview to ask again which attachments have a saved copy.
const CHANGED: &str = "saved-downloads-changed";
/// The webview tells this apart from other failures to offer Download again.
const MOVED: &str = "Saved file moved or changed";
const OPEN_FAILED: &str = "Could not open the saved file";
const FILE: &str = "saved-downloads.json";
/// Version 1 keyed a record by blob name alone, on any relay. Its records
/// cannot be told apart by relay, so a ledger of another version starts empty.
const VERSION: u32 = 2;
/// A record lasts this long after its last download or Open.
const LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;
/// The most records kept; the least recently used go first.
const CAP: usize = 500;

#[derive(Serialize, Deserialize)]
struct Record {
    path: PathBuf,
    size: u64,
    modified_ns: u128,
    /// Seconds since the epoch of the last download or Open.
    used: u64,
}

type Records = BTreeMap<String, Record>;

#[derive(Serialize, Deserialize)]
struct Stored<R> {
    version: u32,
    records: R,
}

/// The records, read from the ledger folder on first use.
#[derive(Default)]
pub(crate) struct SavedDownloads(Mutex<Option<Records>>);

/// One record per relay media URL and saved name, the name Download would
/// use, so the same bytes saved as `notes.md` and `notes.txt` stay separate.
/// `url` is a validated relay media URL. Its relay is part of the key: nothing
/// checks the saved bytes against the hash the URL names, so the same blob
/// name on another relay may be another file.
pub(crate) fn key(url: &url::Url, filename: &str) -> String {
    format!("{url}/{filename}")
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Size and modification time of a regular file.
fn stat(path: &Path) -> io::Result<(u64, u128)> {
    let metadata = std::fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(io::Error::other("not a file"));
    }
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?;
    Ok((metadata.len(), modified.as_nanos()))
}

impl SavedDownloads {
    /// Remembers that `key` was saved at `path`, replacing an earlier copy's record.
    pub(crate) fn record(&self, dir: &Path, key: String, path: PathBuf, now: u64) {
        let (size, modified_ns) = match stat(&path) {
            Ok(stat) => stat,
            Err(error) => return eprintln!("Saved download was not recorded: {error}"),
        };
        let record = Record {
            path,
            size,
            modified_ns,
            used: now,
        };
        self.with(dir, now, |records| {
            records.insert(key, record);
            ((), true)
        });
    }

    /// The saved copy of `key` while it is still the file that was saved.
    /// A moved, deleted or changed file loses its record, and so does one
    /// past its lifetime. Content is not hashed: Open hands the file to the
    /// OS as a double-click would.
    pub(crate) fn check(&self, dir: &Path, key: &str, now: u64) -> Option<PathBuf> {
        self.with(dir, now, |records| {
            let saved = records.get(key).filter(|record| {
                stat(&record.path).is_ok_and(|stat| stat == (record.size, record.modified_ns))
            });
            match saved {
                Some(record) => (Some(record.path.clone()), false),
                None => (None, records.remove(key).is_some()),
            }
        })
    }

    /// Restarts the lifetime of `key` after an Open.
    pub(crate) fn touch(&self, dir: &Path, key: &str, now: u64) {
        self.with(dir, now, |records| {
            (
                (),
                records
                    .get_mut(key)
                    .map(|record| record.used = now)
                    .is_some(),
            )
        });
    }

    /// Runs `change` on the records that are still within their lifetime, so
    /// no lookup or renewal ever sees an expired one.
    fn with<T>(&self, dir: &Path, now: u64, change: impl FnOnce(&mut Records) -> (T, bool)) -> T {
        let mut slot = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let records = slot.get_or_insert_with(|| load(dir));
        let held = records.len();
        prune(records, now);
        let expired = records.len() != held;
        let (value, changed) = change(records);
        if changed || expired {
            prune(records, now);
            if let Err(error) = persist(dir, records) {
                eprintln!("Saved downloads were not stored: {error}");
            }
        }
        value
    }
}

fn load(dir: &Path) -> Records {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored<Records>>(&bytes).ok())
        .filter(|stored| stored.version == VERSION)
        .map(|stored| stored.records)
        .unwrap_or_default()
}

fn prune(records: &mut Records, now: u64) {
    records.retain(|_, record| now.saturating_sub(record.used) < LIFETIME_SECS);
    let excess = records.len().saturating_sub(CAP);
    if excess > 0 {
        let mut oldest: Vec<_> = records
            .iter()
            .map(|(key, record)| (record.used, key.clone()))
            .collect();
        oldest.sort_unstable();
        for (_, key) in oldest.into_iter().take(excess) {
            records.remove(&key);
        }
    }
}

/// Replaces the ledger whole, so a crash leaves the old or the new one.
fn persist(dir: &Path, records: &Records) -> io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!("{FILE}.tmp"));
    let stored = Stored {
        version: VERSION,
        records,
    };
    std::fs::write(&temporary, serde_json::to_vec(&stored)?)?;
    std::fs::rename(temporary, dir.join(FILE))
}

/// Tells every webview to ask again which attachments have a saved copy. The
/// Huddle window may not listen for app events, so its own channel says so.
pub(crate) fn changed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(CHANGED, ());
    if let Some(huddle) = app.try_state::<crate::huddle_window::HuddleWindow>() {
        huddle.saved_downloads_changed();
    }
}

/// Records where `media_download` saved `key`, then tells every webview.
pub(crate) fn recorded<R: Runtime>(app: &AppHandle<R>, key: String, path: PathBuf) {
    match app.path().app_data_dir() {
        Ok(dir) => app.state::<SavedDownloads>().record(&dir, key, path, now()),
        Err(error) => eprintln!("Saved download was not recorded: {error}"),
    }
    changed(app);
}

/// Whether this attachment's last download is still where it was saved, unchanged.
#[tauri::command]
pub(crate) async fn media_download_status<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    source: String,
    name: String,
) -> Result<bool, String> {
    let (url, filename) = crate::relay::download_request(&app, &webview, &source, &name)?;
    let key = key(&url, &filename);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_data_dir().ok()?;
        app.state::<SavedDownloads>().check(&dir, &key, now())
    })
    .await
    .map(|saved| saved.is_some())
    .map_err(|_| "Saved download check interrupted".to_owned())
}

/// Opens this attachment's saved copy in its default app, or shows it in its
/// folder. The webview names an attachment, never a path. The file keeps the
/// quarantine or Mark of the Web from its download, so the OS treats this
/// like a double-click in the file manager.
#[tauri::command]
pub(crate) async fn media_download_open<R: Runtime>(
    app: AppHandle<R>,
    webview: tauri::Webview<R>,
    source: String,
    name: String,
    reveal: bool,
) -> Result<(), String> {
    let (url, filename) = crate::relay::download_request(&app, &webview, &source, &name)?;
    let key = key(&url, &filename);
    tauri::async_runtime::spawn_blocking(move || {
        let dir = app.path().app_data_dir().map_err(|_| OPEN_FAILED)?;
        let opened = open_saved(&app.state(), &dir, &key, now(), |path| {
            if reveal {
                app.opener().reveal_item_in_dir(&path)
            } else {
                let path = path
                    .into_os_string()
                    .into_string()
                    .map_err(|_| OPEN_FAILED)?;
                app.opener().open_path(path, None::<&str>)
            }
            .map_err(|_| OPEN_FAILED.to_owned())
        });
        if matches!(&opened, Err(error) if error == MOVED) {
            changed(&app);
        }
        opened
    })
    .await
    .map_err(|_| OPEN_FAILED.to_owned())?
}

/// Hands `key`'s saved copy to `open`, then restarts its lifetime.
fn open_saved(
    saves: &SavedDownloads,
    dir: &Path,
    key: &str,
    now: u64,
    open: impl FnOnce(PathBuf) -> Result<(), String>,
) -> Result<(), String> {
    let path = saves.check(dir, key, now).ok_or(MOVED)?;
    open(path)?;
    saves.touch(dir, key, now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_762_800_000;

    fn saved(dir: &Path, name: &str, body: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn keys_name_the_relay_the_blob_and_the_saved_name() {
        let hash = "a".repeat(64);
        let url = url::Url::parse(&format!("https://relay.test/media/{hash}.pdf")).unwrap();
        assert_eq!(
            key(&url, "notes.pdf"),
            format!("https://relay.test/media/{hash}.pdf/notes.pdf")
        );
    }

    #[test]
    fn a_copy_saved_from_one_relay_is_not_another_relays_copy() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "report.pdf", b"hostile");
        let blob = format!("{}.pdf", "a".repeat(64));
        let [hostile, trusted] = ["https://hostile.test", "https://trusted.test"].map(|relay| {
            let url = url::Url::parse(&format!("{relay}/media/{blob}")).unwrap();
            key(&url, "report.pdf")
        });
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), hostile.clone(), path.clone(), NOW);
        let unopened = |_: PathBuf| -> Result<(), String> { panic!("opened another relay's copy") };
        for saves in [&saves, &SavedDownloads::default()] {
            assert_eq!(saves.check(ledger.path(), &trusted, NOW), None);
            assert_eq!(
                open_saved(saves, ledger.path(), &trusted, NOW, unopened),
                Err(MOVED.into())
            );
            assert_eq!(
                saves.check(ledger.path(), &hostile, NOW),
                Some(path.clone())
            );
        }
    }

    #[test]
    fn records_keyed_without_a_relay_are_dropped() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "report.pdf", b"report");
        let (size, modified_ns) = stat(&path).unwrap();
        let blob = format!("{}.pdf", "a".repeat(64));
        let url = url::Url::parse(&format!("https://relay.test/media/{blob}")).unwrap();
        // A version 1 ledger, under its key and, were it ever read, the new one.
        let record = serde_json::json!({
            "path": path, "size": size, "modified_ns": modified_ns, "used": NOW
        });
        let stored = serde_json::json!({
            "version": 1,
            "records": {
                format!("{blob}/report.pdf"): record.clone(),
                key(&url, "report.pdf"): record,
            }
        });
        std::fs::write(ledger.path().join(FILE), stored.to_string()).unwrap();
        let saves = SavedDownloads::default();
        assert_eq!(
            saves.check(ledger.path(), &key(&url, "report.pdf"), NOW),
            None
        );
        assert!(saves.with(ledger.path(), NOW, |records| (records.is_empty(), false)));
    }

    #[test]
    fn a_recorded_file_stays_saved_across_launches_until_it_changes() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "notes.md", b"notes");
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), "a/notes.md".into(), path.clone(), NOW);
        assert_eq!(
            saves.check(ledger.path(), "a/notes.md", NOW),
            Some(path.clone())
        );
        assert_eq!(saves.check(ledger.path(), "b/notes.md", NOW), None);

        let relaunched = SavedDownloads::default();
        assert_eq!(
            relaunched.check(ledger.path(), "a/notes.md", NOW),
            Some(path.clone())
        );

        // Same size, new contents: only the modification time differs.
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::fs::write(&path, b"edits").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified + std::time::Duration::from_secs(1))
            .unwrap();
        assert_eq!(relaunched.check(ledger.path(), "a/notes.md", NOW), None);
        // The dropped record is gone for good, even if the file returns.
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            SavedDownloads::default().check(ledger.path(), "a/notes.md", NOW),
            None
        );
    }

    #[test]
    fn a_deleted_or_resized_file_is_dropped() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let deleted = saved(downloads.path(), "deleted.md", b"notes");
        let resized = saved(downloads.path(), "resized.md", b"notes");
        let replaced = saved(downloads.path(), "replaced", b"notes");
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), "deleted".into(), deleted.clone(), NOW);
        saves.record(ledger.path(), "resized".into(), resized.clone(), NOW);
        saves.record(ledger.path(), "replaced".into(), replaced.clone(), NOW);
        std::fs::remove_file(&deleted).unwrap();
        let modified = std::fs::metadata(&resized).unwrap().modified().unwrap();
        std::fs::write(&resized, b"longer notes").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&resized)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        std::fs::remove_file(&replaced).unwrap();
        std::fs::create_dir(&replaced).unwrap();
        for key in ["deleted", "resized", "replaced"] {
            assert_eq!(saves.check(ledger.path(), key, NOW), None, "{key}");
        }
        assert!(SavedDownloads::default()
            .with(ledger.path(), NOW, |records| (records.is_empty(), false)));
    }

    #[test]
    fn records_expire_after_thirty_days_without_use() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let opened = saved(downloads.path(), "opened.md", b"opened");
        let idle = saved(downloads.path(), "idle.md", b"idle");
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), "opened".into(), opened.clone(), NOW);
        saves.record(ledger.path(), "idle".into(), idle, NOW);
        saves.touch(ledger.path(), "opened", NOW + LIFETIME_SECS - 1);

        // The instance that loaded the records enforces their lifetime too.
        let later = NOW + LIFETIME_SECS;
        assert!(saves.check(ledger.path(), "idle", later - 1).is_some());
        assert_eq!(saves.check(ledger.path(), "idle", later), None);
        assert_eq!(
            saves.check(ledger.path(), "opened", later),
            Some(opened.clone())
        );
        // The expired record is gone, not hidden: an earlier clock finds nothing.
        assert_eq!(saves.check(ledger.path(), "idle", NOW), None);
        let relaunched = SavedDownloads::default();
        assert_eq!(relaunched.check(ledger.path(), "idle", NOW), None);
        assert_eq!(
            relaunched.check(ledger.path(), "opened", later),
            Some(opened)
        );
    }

    #[test]
    fn open_does_not_renew_an_expired_record() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "notes.md", b"notes");
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), "notes".into(), path, NOW);
        let unopened = |_: PathBuf| -> Result<(), String> { panic!("opened an expired copy") };
        let later = NOW + LIFETIME_SECS;
        assert_eq!(
            open_saved(&saves, ledger.path(), "notes", later, unopened),
            Err(MOVED.into())
        );
        saves.touch(ledger.path(), "notes", later);
        for saves in [&saves, &SavedDownloads::default()] {
            assert_eq!(saves.check(ledger.path(), "notes", later), None);
        }
    }

    #[test]
    fn the_least_recently_used_records_go_past_the_cap() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "notes.md", b"notes");
        let saves = SavedDownloads::default();
        for index in 0..=CAP as u64 {
            saves.record(ledger.path(), format!("{index}"), path.clone(), NOW + index);
        }
        let relaunched = SavedDownloads::default();
        assert_eq!(relaunched.check(ledger.path(), "0", NOW + CAP as u64), None);
        for index in [1, CAP] {
            let key = format!("{index}");
            assert!(relaunched
                .check(ledger.path(), &key, NOW + CAP as u64)
                .is_some());
        }
        assert_eq!(
            relaunched.with(ledger.path(), NOW, |records| (records.len(), false)),
            CAP
        );
    }

    #[test]
    fn open_hands_over_only_a_valid_copy_and_renews_it() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "notes.md", b"notes");
        let stale = saved(downloads.path(), "stale.md", b"stale");
        let saves = SavedDownloads::default();
        saves.record(ledger.path(), "notes".into(), path.clone(), NOW);
        saves.record(ledger.path(), "stale".into(), stale.clone(), NOW);
        std::fs::remove_file(&stale).unwrap();
        let unopened = |_: PathBuf| -> Result<(), String> { panic!("opened a missing file") };
        for key in ["unknown", "stale"] {
            assert_eq!(
                open_saved(&saves, ledger.path(), key, NOW, unopened),
                Err(MOVED.into())
            );
        }
        assert_eq!(
            SavedDownloads::default().with(ledger.path(), NOW, |records| (
                records.keys().cloned().collect::<Vec<_>>(),
                false
            )),
            ["notes"]
        );

        // A failed hand-off passes its error through and keeps the record.
        let later = NOW + LIFETIME_SECS - 1;
        let refused = open_saved(&saves, ledger.path(), "notes", later, |_| {
            Err(OPEN_FAILED.into())
        });
        assert_eq!(refused, Err(OPEN_FAILED.into()));
        let mut opened = None;
        open_saved(&saves, ledger.path(), "notes", later, |path| {
            opened = Some(path);
            Ok(())
        })
        .unwrap();
        assert_eq!(opened, Some(path.clone()));
        let relaunched = SavedDownloads::default();
        assert_eq!(
            relaunched.check(ledger.path(), "notes", later + 1),
            Some(path)
        );
    }

    #[test]
    fn an_unreadable_ledger_starts_empty_and_is_replaced() {
        let ledger = tempfile::tempdir().unwrap();
        let downloads = tempfile::tempdir().unwrap();
        let path = saved(downloads.path(), "notes.md", b"notes");
        for contents in ["{not json", r#"{"version":3,"records":{}}"#] {
            std::fs::write(ledger.path().join(FILE), contents).unwrap();
            let saves = SavedDownloads::default();
            assert_eq!(saves.check(ledger.path(), "notes", NOW), None);
            saves.record(ledger.path(), "notes".into(), path.clone(), NOW);
            let relaunched = SavedDownloads::default();
            assert_eq!(
                relaunched.check(ledger.path(), "notes", NOW),
                Some(path.clone())
            );
        }
        assert!(!ledger.path().join(format!("{FILE}.tmp")).exists());
    }
}
