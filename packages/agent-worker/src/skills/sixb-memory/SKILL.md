---
name: sixb-memory
description: Organize the memory into topic files, and merge a save that conflicts.
---

# Memory

The memory is a folder of Markdown files under `$SIXB_MEMORY_DIR/<repo>/`. Later conversations
start from its `MEMORY.md` and open the other files when a topic comes up.

- `user/` is this user's own memory: only their conversations read it.
- `project/` is built up from every user's conversations, and everyone who uses the agent in this
  project reads it, including people who cannot see the data this user sees. Put in it what holds
  for everyone, such as the team's vocabulary, a convention, or how something is measured, and
  only what users told you: nothing about a particular person, and nothing learned from records or
  data.

## Topic files

`MEMORY.md` is a list of one-line entries that every conversation reads. When a subject outgrows a
line or two, move it into a topic file with one subject, such as `projects/payments.md` or
`team_structure.md`, and leave one entry in `MEMORY.md` that links it with a few words on what it
holds.

Link a file with `[[path]]`, from the repo root, leaving out `.md`: `[[projects/payments]]`. Other
files keep their extension: `[[metrics/keep_rate.sql]]`.

```md
# Memory

- Prefers summaries as short bullet lists (added 2026-10-04)
- Report invoice amounts excluding VAT (added 2026-10-21)
- Billing projects and how invoices are measured: [[projects/payments]] (added 2026-10-12)
- The query behind the weekly keep rate: [[metrics/keep_rate.sql]] (added 2026-10-15)
```

## Writing an entry

- One bullet on one line, ending with the date it was added: `(added YYYY-MM-DD)`.
- Write it so a conversation that never saw this one understands it.
- Edit in place. When the user corrects an entry, change or remove it; never leave two entries that
  disagree.
- Save how to find project data, such as the object type, the query or the property, never the
  data itself: the memory outlives the user's access to it.

## Saving

End every edit with the save of the repo you edited, in the same command:

```sh
echo '- Report invoice amounts excluding VAT (added 2026-10-21)' >> "$SIXB_MEMORY_DIR/user/MEMORY.md" && sixb memory save user -m "Invoice amounts excluding VAT"
```

Only the files are remembered. The chat shows the message under your reply, so keep it to a few
words saying what you learned. Save once per thing learned, after all of its edits.

The command prints JSON:

- `"saved": true`: the edits are stored. `warnings` lists `[[links]]` that point at no file; fix
  them and save again.
- `"saved": false` with `conflicts`: another conversation saved the same files first. Each of their
  versions is next to yours as `<file>.theirs`. Merge it into your file, delete the `.theirs` file,
  and save again. `"theirs": null` means they deleted the file; keep yours only if it is still
  right.
- `"saved": false` with `"changed": []`: nothing changed since the files were loaded.

A save is rejected with what to change when `MEMORY.md` is over 16 KB, a file over 256 KB, or the
repo over 4 MB, or when a path is absolute, has a `..` segment, or names a dotfile.
