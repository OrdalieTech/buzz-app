# Desktop releases

Buzz ships on two channels. **Previews** build from `main` every day and reach
preview installs automatically. **Stable** releases (and betas) are cut by an
admin from a tag, and reach installed apps only after a second, approved step
promotes them to the stable updater feed.

Each build has one updater feed compiled in, and the app keeps no channel
setting: the build someone installs decides where it updates from.

| Feed | URL |
| --- | --- |
| Preview | `https://github.com/block/buzz-app/releases/download/preview-feed/latest.json` |
| Stable | `https://github.com/block/buzz-app/releases/download/stable-feed/latest.json` |
| Website installers | `https://raw.githubusercontent.com/block/buzz-app/download-feed/downloads.json` |

Every lane builds the same assets through `desktop-build.yml`: a signed and
notarized DMG and updater archive for Apple Silicon and Intel macOS, an
unsigned Windows x64 NSIS installer, an Ubuntu 24.04 `.deb` and AppImage, each
updater file's `.sig`, plus `SOURCE_COMMIT` and `SHA256SUMS`. A failed platform
blocks the whole release; nothing publishes partially.

## Join or leave previews

- **Join:** install a `Buzz X.Y.Z-preview.N` prerelease from the
  [Releases page](https://github.com/block/buzz-app/releases). It then updates
  to each new preview.
- **Leave:** install the release marked **Latest**. This installs an older
  version over a newer one, and a preview may have changed local data in a way
  the older build can't read.

## Previews

The **Desktop previews** workflow (`release.yml`) runs:
- daily from `main` at 09:37 UTC (Sunday's run also rebuilds the CI caches from
  scratch);
- after each stable release, so preview installs get the release's code;
- by hand: `gh workflow run release.yml --repo block/buzz-app --ref main`.

**Version:** one patch above the latest stable tag in the commit's history,
then `-preview.N`, counting up from 1 for each new base. After `v1.1.0`,
previews are `1.1.1-preview.1`, `.2`, and so on. `tauri.conf.json`'s version is
ignored.

After publishing, the workflow promotes the build to the preview feed, then
prunes old previews. It keeps the newest 10, everything from the last seven
days, and whatever the feed points to. To see what it would delete:

```sh
GH_REPO=block/buzz-app bin/node scripts/prune-preview-releases.mjs
```

**If a run fails:** use **Re-run all jobs**. A failure before publishing takes
no version number. A failed promotion leaves the feed as it was, but needs a
look before the next run. To repromote an existing preview:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main \
  -f promote_version=1.1.1-preview.<N>
```

## Cut a stable or beta release

1. **Tag a commit in `main` and push the tag with Git.** Don't create it from
   the Releases page: that creates the release first, and the workflow then
   fails.

   ```sh
   git fetch origin main
   git tag -a v1.2.0 -m 'Buzz 1.2.0' <commit-sha>
   git push origin refs/tags/v1.2.0
   ```

   Use `vX.Y.Z` for stable and `vX.Y.Z-beta.N` for a beta. **Desktop stable
   release** (`desktop-stable.yml`) builds it at the tag's version and publishes
   it: stable as **Latest**, beta as a prerelease. It refuses tags that aren't
   in `main`, aren't in that exact format, or aren't covered by the tag ruleset.
   Stable releases also start a preview build.

2. **Promote it to installed apps.** Publishing changes nothing for installed
   apps until you run the feed workflow and a reviewer approves it in the
   `desktop-stable-feed` environment:

   ```sh
   gh workflow run desktop-stable-feed.yml --repo block/buzz-app --ref main \
     -f version=1.2.0
   ```

   This also updates the website's `downloads.json`, which can take about five
   minutes to show up. Betas can't be promoted; beta installs update to the next
   promoted stable release.

If a platform job fails, use **Re-run all jobs**. Never move or reuse a
published tag; cut a new version instead.

To check the website manifest without writing it:
`GH_REPO=block/buzz-app bin/node scripts/publish-desktop-downloads.mjs 1.2.0`.
Add `--apply` to republish it for the currently promoted version.

## How promotion protects the feeds

Both feeds go through `scripts/promote-updater-feed.sh`. It downloads every
updater archive and signature, verifies them against the key pinned in the app,
checks the candidate app embeds the right feed URL, refuses a rollback or
changed metadata for the same version, and replaces `latest.json` last. A
failed check leaves the feed unchanged.

**Known gap:** signatures don't include the version, so someone who controls a
feed response could serve an older signed build under a higher version number.
Closing it needs a signing migration (sign with `--app-version`, then enable
`requireSignedVersion` in the client). Don't enable the client flag on its own:
every existing signature would fail.

**Recovery:** you can't roll back an update someone already installed. Fix a
bad feed by promoting a newer, tested build. If the updater key is lost or
clients break, people need to install a new build by hand.

## External release tags

Builds outside GitHub Actions use separate `desktop-vX.Y.Z` (or
`desktop-vX.Y.Z-beta.N`) tags, which never start a workflow. Create one with
**Desktop release tag** from `main`, giving the version and a full commit SHA
in `main`. Until the release GitHub App is set up, an admin tags by hand the same
way as above, with a `desktop-v` prefix.

## One-time setup

A repository admin does these before the first release:

- **Signing secrets:** `OSX_CODESIGN_ROLE`, `CODESIGN_S3_BUCKET`,
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back the
  Tauri key up outside Actions. Losing or rotating it strands every installed
  app, so rotate only with a plan to reinstall by hand. The macOS signing
  role's OIDC trust must accept `refs/tags/v*` as well as `main`.
- **Stable tag ruleset:** include `refs/tags/v*`, **exclude
  `refs/tags/v*-preview.*`**, restrict create, update and delete, block force
  pushes, and allow only the admin role to bypass. Without the exclusion every
  preview fails, because previews create and delete their tags with
  `GITHUB_TOKEN`. Don't add GitHub Actions as a bypass actor instead; any
  workflow could then create a stable tag. Activate the ruleset before any `v*`
  tag exists.
- **`desktop-v*` ruleset:** a separate one with no exclusions, restricting
  create, update, delete and non-fast-forward, with the release App as its only
  bypass actor. The workflow can't see the bypass list, so check it by hand.
- **Environments:** `desktop-stable-feed` with required reviewers and only
  `main` allowed to deploy; `desktop-release-tag`, also `main` only, holding the
  `BUZZ_RELEASE_TAGGER_CLIENT_ID` variable and `BUZZ_RELEASE_TAGGER_PRIVATE_KEY`
  secret.
- **Sign-in servers:** builds sign in to `https://app.builderlab.xyz`. A
  nonempty `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` Actions variable adds more
  (see [configuration](configuration.md#federated-identity-build-input)).

## Bundled tools

**goose-acp.** Every package ships the upstream Goose release pinned in
`runtime/goose-acp.json`. To update it:
1. Verify each target's archive:
   ```sh
   gh attestation verify <archive> --repo aaif-goose/goose \
     --signer-workflow aaif-goose/goose/.github/workflows/release.yml \
     --source-ref refs/tags/<tag> --source-digest <commit> \
     --cert-oidc-issuer https://token.actions.githubusercontent.com \
     --deny-self-hosted-runners
   ```
2. Update the version, source revision, asset URLs and SHA-256 values together,
   and review upstream license changes. Never resolve `latest` at build time.
3. Move the Buzz Security plugin's protected Goose pin to the same revision
   before the release ships.
4. Check provider sessions, HTTP MCP, steering and cancellation, and session
   history. One check is known to fail upstream in every version so far: Goose
   saves the MCP server's URL and bearer header in session data.

**buzz CLI.** Every package ships `buzz` at
`Buzz.app/Contents/Resources/bin/buzz` (`bin\buzz.exe` on Windows). It's built
from the `buzz-audio-client` revision in `src-tauri/Cargo.toml`, so bumping that
pin updates both. On macOS and Linux (except the AppImage), the app links it to
`~/.local/bin/buzz` each time it starts; the Windows installer adds it to
`PATH`.

It updates only with the app, so a newer relay can accept protocol changes the
bundled CLI doesn't know.

## Windows and Linux

To build installers from a branch without signing or publishing:

```sh
gh workflow run release.yml --repo block/buzz-app \
  --ref <branch> -f candidates=true
```

Download the `windows-x64-candidate` and `linux-x64-candidates` artifacts
within seven days. They have no updater. Windows installs are unsigned and
per-user; Linux deb updates ask for an administrator password.

Don't change the Windows `bundle.publisher` (`local`). Updates find the
existing install folder by it.

Before accepting a Windows or Linux build, test it on a disposable Windows 11
or Ubuntu 24.04 GNOME account with a throwaway key:
1. Install and launch without developer tools. Linux needs a working Secret
   Service session.
2. Create or import an identity, quit and relaunch with the same key, join a
   community, send and receive, and reconnect.
3. Open `buzz://` links cold and warm, install a newer preview over the old one
   and check the identity and settings survive, and note what uninstall leaves.
4. Have a person repeat install, messaging and restart.
