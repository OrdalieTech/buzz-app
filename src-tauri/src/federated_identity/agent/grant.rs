//! One agent's stored grant. A grant outlives the owner's BB session (8 days
//! idle, 90 absolute), so session expiry never touches it. It records the BB
//! account that enrolled it: whenever the owner is signed in, a different
//! account retires it, which also covers a restart into another account.

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::super::store;

// No Debug, no IPC serialization. Only the secure store serializes this record.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    version: u8,
    pub(crate) owner: String,
    pub(crate) agent: String,
    /// The enrolling BB account's session email.
    pub(crate) account: String,
    /// The `nip_fi_issuer` that granted it, which its assertions must carry.
    pub(crate) issuer: String,
    pub(crate) token: String,
    /// Issued by the one re-enrollment after a refusal and not yet used to
    /// mint: if it is refused too, the agent stops instead of enrolling again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) replacement: bool,
    /// A token-free stop/reservation, reset only by a new persisted sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) stopped: Option<String>,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
impl Grant {
    pub(crate) fn new(
        owner: String,
        agent: String,
        account: String,
        issuer: String,
        token: String,
    ) -> Self {
        Self {
            version: 1,
            owner,
            agent,
            account,
            issuer,
            token,
            replacement: false,
            stopped: None,
        }
    }
    /// Whether this grant may be used. Without a session (expired or not yet
    /// restored) the grant is used as it is, so agents keep working.
    pub(crate) fn usable_with(&self, signed_in: Option<&str>) -> bool {
        signed_in.is_none_or(|account| account == self.account)
    }
}

pub(crate) trait GrantStore: Send + Sync {
    fn read(&self, key: &str) -> Result<Option<Grant>, &'static str>;
    fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str>;
    fn delete(&self, key: &str) -> Result<(), &'static str>;
    /// Whether the durable retirement record at `key` exists.
    fn pending(&self, key: &str) -> Result<bool, &'static str>;
    fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str>;
}

/// Reads the grant at `key`, retiring it when the signed-in account differs.
pub(crate) fn load(
    store: &dyn GrantStore,
    key: &str,
    signed_in: Option<&str>,
) -> Result<Option<Grant>, &'static str> {
    match store.read(key)? {
        Some(grant) if grant.usable_with(signed_in) => Ok(Some(grant)),
        Some(_) => store.delete(key).map(|()| None),
        None => Ok(None),
    }
}

/// Grants in the owner's bundle where it exists (see `store::BUNDLED`).
pub(crate) struct SecureGrantStore(pub(crate) String);

impl SecureGrantStore {
    fn store(&self) -> Result<store::SecureStore, &'static str> {
        Ok(store::SecureStore {
            account: self.0.clone(),
            root: store::root().map_err(|_| "Secure storage is unavailable")?,
            bundled: store::BUNDLED,
        })
    }
    fn raw(&self, key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        self.store()?
            .grant(key)
            .map_err(|_| "Secure storage is unavailable")
    }
    fn set(&self, key: &str, value: Option<&[u8]>) -> Result<(), &'static str> {
        self.store()?
            .set_grant(key, value)
            .map_err(|_| "Secure storage is unavailable")
    }
}

impl GrantStore for SecureGrantStore {
    fn read(&self, key: &str) -> Result<Option<Grant>, &'static str> {
        self.raw(key)?
            .map(|raw| serde_json::from_slice(&raw).map_err(|_| "Stored agent grant is unreadable"))
            .transpose()
    }
    fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str> {
        let next = Zeroizing::new(serde_json::to_vec(grant).map_err(|_| "Invalid agent grant")?);
        self.set(key, Some(&next))
    }
    fn pending(&self, key: &str) -> Result<bool, &'static str> {
        self.raw(key).map(|raw| raw.is_some())
    }
    // Kept beside the grants, so a full Buzz sign-out erases it with them.
    fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str> {
        self.set(key, pending.then_some(b"retiring".as_slice()))
    }
    fn delete(&self, key: &str) -> Result<(), &'static str> {
        self.set(key, None)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// The next write signals `.0` once called, then waits for `.1`.
    pub(crate) type Gate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    /// Grants in memory, plus the retirement record. `failing` refuses deletes;
    /// `gate` holds the next write.
    #[derive(Default)]
    pub(crate) struct MemoryGrants(
        pub(crate) Mutex<HashMap<String, Vec<u8>>>,
        std::sync::atomic::AtomicBool,
        Mutex<Option<Gate>>,
        std::sync::atomic::AtomicBool,
        pub(crate) Mutex<Option<usize>>,
        std::sync::atomic::AtomicBool,
    );
    impl MemoryGrants {
        pub(crate) fn failing(&self, on: bool) {
            self.1.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn fail_writes(&self, on: bool) {
            self.5.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn fail_pending(&self, on: bool) {
            self.3.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn gate(&self, gate: Gate) {
            *self.2.lock().unwrap() = Some(gate);
        }
    }

    impl GrantStore for MemoryGrants {
        fn read(&self, key: &str) -> Result<Option<Grant>, &'static str> {
            let grants = self.0.lock().unwrap();
            Ok(grants
                .get(key)
                .map(|raw| serde_json::from_slice(raw).unwrap()))
        }
        fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str> {
            let gate = self.2.lock().unwrap().take();
            if let Some((held, release)) = gate {
                held.send(()).unwrap();
                release.recv().unwrap();
            }
            if self.5.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Secure storage is unavailable");
            }
            let raw = serde_json::to_vec(grant).unwrap();
            self.0.lock().unwrap().insert(key.into(), raw);
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), &'static str> {
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Secure storage is unavailable");
            }
            if let Some(left) = self.4.lock().unwrap().as_mut() {
                if *left == 0 {
                    return Err("Secure storage is unavailable");
                }
                *left -= 1;
            }
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
        fn pending(&self, key: &str) -> Result<bool, &'static str> {
            Ok(self.0.lock().unwrap().contains_key(key))
        }
        fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str> {
            if !pending {
                return self.delete(key);
            }
            if self.3.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Secure storage is unavailable");
            }
            self.0
                .lock()
                .unwrap()
                .insert(key.into(), b"retiring".to_vec());
            Ok(())
        }
    }

    fn enrolled(store: &MemoryGrants, account: &str) {
        let grant = Grant::new(
            "owner".into(),
            "agent".into(),
            account.into(),
            "issuer".into(),
            "g".into(),
        );
        store.write("key", &grant).unwrap();
    }

    #[test]
    fn a_restart_into_a_different_account_retires_the_old_grant() {
        let store = MemoryGrants::default();
        enrolled(&store, "a@example.com");

        // A new run: the session signal says Refreshed, but the account differs.
        assert!(load(&store, "key", Some("b@example.com"))
            .unwrap()
            .is_none());
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_same_account_or_no_session_keeps_the_grant() {
        let store = MemoryGrants::default();
        enrolled(&store, "a@example.com");

        let same = load(&store, "key", Some("a@example.com")).unwrap().unwrap();
        assert_eq!(same.token, "g");
        // Owner session expired: agents keep working on their grant.
        assert!(load(&store, "key", None).unwrap().is_some());
        assert!(store.0.lock().unwrap().contains_key("key"));
    }
}
