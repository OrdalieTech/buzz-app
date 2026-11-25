# Plugin trust

Buzz verifies every supplied [NIP-PS](nips/NIP-PS.md) signature. Unsigned plugins
can run by default unless `BUZZ_REQUIRE_PLUGIN_SIGNATURES=1` is set. A plugin
trust file requires signatures and limits external plugins to
publishers you register. It can also allow **self-developed** plugins: ones signed
with your own saved Buzz human identity through `buzzodz plugin sign`, for
development and testing.

Plugins built into Buzz are always exempt. Trust controls who may publish code that
runs; it does not sandbox that code.

## File location

`plugin-trust.json` lives in the app data folder beside `managed-plugins.json`; see
[managed plugin sources](managed-plugins.md#file-location) for the folder on each OS
and for `BUZZODZ_HOME`. `BUZZ_PLUGIN_TRUST`, when set and non-empty, is the full path
of the file and must be absolute. One file serves every local profile. Buzz reads it
before each install, reload, enable, rollback and load, and on every catalog refresh,
so an edit applies to the running app within a second.

| File | Effect |
| --- | --- |
| Missing at the default location | Follows `BUZZ_REQUIRE_PLUGIN_SIGNATURES`, which is off by default. Supplied signatures are always verified. |
| Missing at the `BUZZ_PLUGIN_TRUST` path | No external plugin runs until the file exists or the variable is unset. A mistyped path or an undeployed policy never lifts the restriction. `buzzodz plugin trust add` creates it. |
| Valid | Only listed publishers run, plus your own identity when `allowSelfDeveloped` is true. Unsigned plugins never run, even with `BUZZ_REQUIRE_PLUGIN_SIGNATURES=0`. |
| Unusable, including a symbolic link to a missing file | No external plugin runs. Fix the file in place or remove the policy by removing the default file or unsetting the override. |

Plugins that a policy blocks stay installed and listed with the reason, the same as
an unsigned installation under the signature requirement. They run again as soon as
their publisher is trusted.

The file is local configuration, not a secret. Anything that can write the app data
folder can change it, including an agent or plugin running as you; it protects against
installing code from unexpected publishers, not against software already running.

## Schema (version 1)

```json
{
  "version": 1,
  "trustedPublishers": [
    { "publisher": "npub1…", "name": "Example publisher" }
  ],
  "allowSelfDeveloped": true
}
```

- `version` is required and must be `1`.
- `trustedPublishers`, optional, lists up to 64 entries. `publisher` is an `npub` or a
  64-digit hex public key; `name`, optional, is a label of up to 80 characters. A key
  listed twice makes the file unusable.
- `allowSelfDeveloped`, optional (default `false`), also trusts the public key of the
  saved Buzz human identity, the one `buzzodz plugin sign` uses. It is read from
  secure storage only when a plugin's publisher is not listed, at most once per
  process, so restart Buzz after changing your identity. A missing identity or busy
  storage is retried; other read failures last until restart. The CLI may ask for
  secure storage access the same way `sign` does.
- Any other field, at either level, makes the file unusable, so a misspelled field
  cannot silently turn a setting off.

An empty `trustedPublishers` list with `allowSelfDeveloped` false allows no external
plugins.

## Managing it from the CLI

```sh
buzzodz plugin trust                                # show the policy
buzzodz plugin trust add npub1… "Example publisher" # register or rename a publisher
buzzodz plugin trust remove npub1…                  # stop trusting a publisher
buzzodz plugin trust self-developed on              # or off
```

The first `add` or `self-developed` creates the file and so turns the restriction on.
Each change prints the resulting policy and any installed plugins that can no longer
run. The CLI refuses to edit an unusable file. To return to the default policy, remove
the default file and unset `BUZZ_PLUGIN_TRUST` if you set it. `buzzodz plugin list`
shows each plugin's publisher key, the value to register.
