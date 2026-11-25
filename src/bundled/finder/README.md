# Finder

Find a message when you remember a piece of it, a name, or a word, but not
where it was said.

## Getting started

1. Press ⌘P (Ctrl+P on Windows and Linux) to search the channel you're in,
   or ⌘⇧P (Ctrl+Shift+P) to search all of Buzz.
2. Type any pieces you remember. Letters don't need to be next to each other:
   `dplyrlbk` finds "deploy rollback". Words can match who wrote it or where.
3. Use ↑ and ↓ to look through matches, with a preview of each in context, and
   press Enter to open one.
4. Switch between **This channel** and **All of Buzz** under the search field,
   or press the other key. Closing Finder clears what you typed.

---

## Details

- The finder searches your own conversations from the last 90 days: messages
  you wrote, threads you replied in, direct messages, and messages that mention
  you. The first time, it reads them from the community, which can take a
  minute. It also adds every message Buzz shows or receives from channels
  you're in while it's open, such as a channel you scroll through.
- It also reads the newest 500 messages of the channels you visit and search
  most, up to 16. It keeps count of those visits on this device, as channel
  IDs and numbers only, and older visits count for less.
- `'word` matches those exact letters together, `!word` leaves out messages
  with that word, and a capital letter makes a word match case.
- The index is kept in memory on this device and never sent anywhere. It is
  built again each time Buzz starts. Signing out or switching account or
  community starts it over; a reconnect keeps it and reads only what is
  newer. Clear cache takes effect at restart.
- **This channel**: with fewer than 20 matches, it reads older pages, up to 5,000 messages per
  opening. **Keep going** allows another 5,000. It remembers its place for this
  session and stops when you close or switch scope. Join a public preview to
  search its history here.
- **All of Buzz** shows matches from this device at once, then asks the relay
  after you pause typing. Its hits appear below, under **More from all of
  Buzz**, and the rows above them don't move. Use **Retry** if a read fails, or
  **More messages** for the next page. Hits from joined channels join the
  local index when you close Finder. Public previews stay out.
- ⌘⇧P doesn't open Finder while you type in a text field: there it's Spoiler.
- Change the shortcuts in **Settings → Shortcuts**.
