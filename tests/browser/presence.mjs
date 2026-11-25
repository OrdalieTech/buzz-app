import { expect } from "@playwright/test";

// Wait until a presence snapshot read includes the DM peer. The first read
// carries only the viewer: the DM row's avatar subscribes after it.
// presence.ts admits the peer behind its read gate (5 s after the previous
// read settles), and a busy presence lane answers null and defers another
// 5–6 s. The default budget covers those gates, not the default expect
// timeout, which a loaded runner can exceed.
export function peerPresenceAdmitted(app, timeout = 20_000) {
  return expect
    .poll(
      () =>
        app.report.presenceSnapshots.some((snapshot) =>
          snapshot.filter.authors.includes(app.participants[0]),
        ),
      { timeout },
    )
    .toBe(true);
}
