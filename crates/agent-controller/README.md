# Native agent identities

The desktop host uses this crate for Agents' `app_agent_*` commands: identity
custody, signing, credentials and bringing over identities from earlier stores.
Plugin runtimes own agent execution; this crate no longer contains a controller,
supervisor, harness launcher, teams, provider defaults or bundled runtime loader.
The crate name is retained to keep native consumers stable.

- `AppAgents` owns the saved identity list, with file-locked atomic updates,
  verified owner attestations and create-only credential custody.
- `OldStores` reads v1 and Buzz 0.X identities without changing their records.
  The selected source binds the exact library and credential service. Imports
  verify the public key and preserve shared credentials on failed saves.
- `PlatformCredentials` stores keys in the OS credential store. Its macOS bundle
  retains compatibility with individual entries; Windows/Linux use the sibling
  credential-store adapter. No plaintext key-file fallback is supplied.
- `Secret` signs bounded events and owner-addressed encrypted memories.
  `CreationProfile` retains the verified profile merge/publication helpers.
- `delete_local_agent_keys` reads the retired v1 registry for sign-out. It holds
  the old controller lock, validates every identity before deleting any key,
  refuses linked/unbounded files, and leaves records unchanged for retries.
  It does not validate or execute retired harness settings.

Tests use temporary directories and isolated credentials; they do not touch a
real Keychain or run agents. Profile tests verify signatures, merge preservation
and malformed-profile refusal. Native import still requires an attended check of OS
credential consent and relay behavior; unit tests do not establish that result.
