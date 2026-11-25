# Managed plugin sources

An organization, or a tool that manages a machine for it, can list the plugins it
recommends by writing one JSON file, `managed-plugins.json`. Buzz offers them in
**Settings → Plugins**. A version 1 file only recommends: the person using Buzz installs
and updates each plugin themselves. A [version 2](#version-2-automatic-installs-and-updates)
file [signed](#signed-policies) by the key the build names can also install plugins and
keep them at their pins with no prompt. Only the desktop app reads the file.

Whoever writes this file is choosing plugin authors for the people who use it. Plugins
have no sandbox (see [plugins](plugins.md#trust)), so list only authors you trust with
those people's accounts and computers. The file isn't a secret, and anything that can
write the app data folder can change it.

The code is the reference: `crates/plugin-manager/src/managed.rs` parses and compares
policies, and `buzzodz plugin managed` checks a file with the same code.

## File location

The file sits in the app data folder, next to `profiles/`. Buzz reads the first of:

1. `BUZZ_MANAGED_PLUGINS`, an absolute path to the file (use it for tests).
2. `$BUZZODZ_HOME/managed-plugins.json`.
3. `managed-plugins.json` in the app data folder:

| OS | App data folder |
| --- | --- |
| macOS | `~/Library/Application Support/<identifier>/` |
| Windows | `%APPDATA%\<identifier>\` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/<identifier>/` |

The identifier is `xyz.block.buzz.desktop` for installed Buzz and
`xyz.block.buzz.desktop.dev` for development builds. One file serves every profile.

Buzz never writes the file, and "erase local data" deletes it, so a writer should restore
it on its next run. Write UTF-8 JSON of at most 256 KiB to a temporary file in the same
folder, then rename it over the target. Buzz rereads it whenever it refreshes the plugin
catalog, so changes appear without a restart.

### Packaged policy

A packager can bake a policy URL into its build instead:

```sh
BUZZ_BUILD_MANAGED_PLUGINS_URL=https://plugins.example/managed-plugins.json bin/pnpm tauri build
```

The URL must be `https`, with no credentials or fragment. The app fetches it at startup
and every 6 hours (15 minutes after a failure), and keeps the last good copy. It also
fetches `<url>.sig` for a [signature](#signed-policies); a `404` means unsigned. A local
file, when there is one, replaces the packaged policy completely. Serve the policy with
little or no edge caching. Leave this unset for OSS builds.

## Schema (version 1)

```json
{
  "version": 1,
  "source": "Example Org",
  "plugins": [
    {
      "id": "example.notes",
      "repository": "https://github.com/example-org/buzz-plugins",
      "reference": "v1.4.0",
      "commit": "0123456789abcdef0123456789abcdef01234567",
      "path": "plugins/notes/dist"
    }
  ]
}
```

| Field | Rules |
| --- | --- |
| `version` | `1`, or `2` for automatic entries. |
| `source` | Shown as "Recommended by *source*". 1 to 80 visible characters. |
| `plugins` | At most 256 entries. |
| `id` | The plugin's manifest id. Not a plugin bundled with Buzz. |
| `repository` | An HTTPS or SSH Git URL, or GitHub `owner/repository`. No credentials, query or fragment. An SSH and an HTTPS URL count as different sources. |
| `reference` | A branch or tag. |
| `commit` | The full commit id to install. It must be the tip of `reference` or an earlier commit on it. Pin a tag, or update `commit` when you want a branch to advance. |
| `path` | Optional folder of the built plugin inside the repository, such as `plugins/notes/dist`. Default `.`. |

Instead of a repository, an entry can name one artifact over HTTPS:

```json
{ "id": "example.notes", "url": "https://downloads.example.com/notes-1.4.0.json", "sha256": "<64 hex digits>" }
```

`buzzodz plugin pack DIST_DIRECTORY FILE` writes the artifact. Buzz installs it only if
it hashes to `sha256`, so publish each version at its own URL.

Unknown fields are errors. A broken file recommends nothing; a broken entry is skipped
while the rest apply. Both show their reason in Settings → Plugins.

### Version 2: automatic installs and updates

Version 2 adds two optional fields to each entry:

| Field | Values |
| --- | --- |
| `install` | `"recommend"` (default) lists it. `"automatic"` installs and enables it if it's missing. `"manual"` never offers it, and only governs updates of a copy the person installed. |
| `update` | `"review"` (default) offers the update to the person. `"automatic"` moves an installed copy to the pin. |

Automatic entries apply only in a signed policy; otherwise they act like the defaults. A
plugin the person removes is never reinstalled automatically. An automatic update happens
only when the new version declares the same host access and publisher as the installed
one. Otherwise the person gets the update to review. The pin wins over the person's own
choice of version. A plugin installed from a folder or bundled with Buzz is never
replaced.

### Signed policies

A build that should honor automatic entries names the key allowed to sign its policy:

```sh
BUZZ_BUILD_MANAGED_PLUGINS_SIGNER=<64 hex digits> bin/pnpm tauri build
```

Sign a policy with:

```sh
BUZZ_MANAGED_PLUGINS_SIGNING_KEY=<nsec or hex> buzzodz plugin sign-policy managed-plugins.json
```

That writes `managed-plugins.json.sig` beside it. The signature covers the file's exact
bytes, so any edit needs a new one. Publish the policy before or with its signature. A
signature never expires: anyone who can serve an older signed policy can roll Buzz back
to its pins, but can't pin anything the key never signed.

## Checking a policy

```sh
buzzodz plugin managed            # what Buzz reads, and each entry's state
buzzodz plugin managed --apply    # also apply version 2 automatic entries
BUZZ_MANAGED_PLUGINS=/tmp/policy.json buzzodz plugin managed
```

Check that no entry is reported as ignored before you publish.
