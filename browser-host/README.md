# Browser host

This directory contains the **Node host for browser development and tests**.
It is checked-in source, not browser-compatible application code, a cache, a
production browser backend or another relay server. Packaged desktop uses the
native Rust host in `src-tauri/`; shared application logic stays in `src/`.
Development tooling lives in `scripts/`, including the
[developer-settings Vite plugin](../scripts/developer-settings.ts) and
[live setup probe](../scripts/live-setup-probe.mjs).

Keep platform-neutral feature policy under its existing `src/features/*` owner;
retain host custody and boundary enforcement here. Existing tests are discovered
by Vitest. [Broker setup](../CONTRIBUTING.md#run-it) requires an explicit public
identity pin; never put a private key in environment configuration. Preserve
supported browser capabilities while consolidating duplicate implementations.
A browser run doesn't prove native behavior such as signing, the Keychain or
IPC; check those in the desktop app.

## Hosted browser previews

`relayBrokerPlugin({ browserOrigin: "https://preview.example.org" })` accepts
one explicit HTTPS browser origin through a trusted proxy. The listener must
stay on loopback. This setting is an explicit development opt-in. The broker
refuses it outside the Vite development server in `development` mode, including
production mode and builds. The proxy must authenticate its users; the origin setting
does not grant access or authenticate a remote client. Use a simulated identity
and relay for shared UX previews.

Set the origin in trusted server configuration, never from request headers.
Origins with credentials, a path, a query, or a fragment are refused. Requests
still require a loopback Host and matching Origin. Cross-site browser requests
remain refused. Without this setting, the broker requires its HTTP loopback
origin. Native and release hosts do not use this setting.
