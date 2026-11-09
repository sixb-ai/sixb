---
name: sixb-artifacts
description: Publish a deliverable the user should see, such as a report, a write-up, a table of data, or a file they asked for, as an artifact, and revise it with update_artifact.
---

# Artifacts

An artifact is a deliverable the user opens beside the conversation. It has a kind, a title, and
versions: the current one, which your changes go to, and those the user created, which stay
readable as they were. Publish one when the user asks for a report, a document, a table, or
a file, or when the answer is long-form work or data they will read, reuse, or share. When a few sentences answer
the question, answer in the chat.

## Kinds

| Kind | Publish it for | Read first |
| --- | --- | --- |
| `document` | A report, brief, memo, plan, or write-up: anything read top to bottom | `document.md` |
| `sheet` | Tabular data the reader sorts, sums, charts, or downloads: metrics, lists, trackers, exports | `sheet.md` |
| `slides` | A deck to present: a review, a pitch, a plan for a meeting | `slides.md` |
| `page` | A small web app the reader works with: a calculator, a planner, a dashboard with filters | `page.md` |
| `canvas` | Work seen more than read, laid out in two dimensions: screens or frames side by side (a flow, a storyboard, variants, a moodboard), a brainstorm or retro of notes, a diagram | `canvas.md` |
| `file` | One file in a format the user asked for (PDF, DOCX, XLSX, PPTX, CSV), or a binary | `file.md` |

To show or link to another artifact, such as a sheet's chart in a report, read `references.md`.
Data from the project's objects goes in a query, so the artifact stays live: read `queries.md`.

Prefer a `document` to a DOCX or PDF, a `sheet` to an XLSX or CSV file, and `slides` to a PPTX,
unless the user asked for that format: they render in the app, and the versions the user creates stay readable side by side. A report
with a table of a dozen rows is a document; data the reader works with is a sheet. Work made of
pictures, such as screens, shots, or posters, is a canvas even when notes come with it: the notes
go beside each picture.

## Publish

1. Write the artifact's files in a working directory, such as `work/q3-review/`.
2. Call `publish_artifact` with that directory (or one file), the kind, and a title:

   ```text
   publish_artifact({ path: "work/q3-review", kind: "document", title: "Q3 operations review" })
   → Published "Q3 operations review" as artifact art_k3m9q2x7tp, version 1 at revision 1.
   ```

3. If it refuses, nothing was published. Fix what the message names and publish again. If you
   cannot, tell the user the deliverable could not be published; never describe it as ready.
4. Fix what each warning names and update the artifact when it matters to the reader. A
   deck also comes back with a screenshot of each slide, a page with one at a laptop's width and
   one at a phone's, and a canvas with one of each board: look at them (`slides.md`, `page.md`,
   `canvas.md`, Check).
5. In the reply, say in a sentence or two what you published and what stands out. Do not paste
   its content, a path, or its id as text: the user sees the artifact. To show a chart or a range
   of it in place, use its address (`references.md`). A figure you cite from live data is the one
   you read, and what the artifact shows moves on as the objects change, even at a created version:
   date it with when you read it, in the user's time zone ("As of Oct 23, 10:42, three invoices
   are overdue.").

## Revise

Your changes go to the artifact's current version, which stays open: each `update_artifact`
replaces it. Only the user creates a version, which freezes it; your next update then opens a new
one, and the created version stays as it was.

The artifacts this conversation shares are listed in `$SIXB_ARTIFACTS`, each with its current
version installed under `$SIXB_ARTIFACTS_DIR/<id>/`, including one you published moments ago. To
change one, start from that copy, not from an older working copy:

```bash
rm -rf work/q3-review && cp -r "$SIXB_ARTIFACTS_DIR/art_k3m9q2x7tp" work/q3-review
```

Edit the copy, then update the artifact from it:

```text
update_artifact({ id: "art_k3m9q2x7tp", path: "work/q3-review", title: "Q3 operations review" })
→ Updated "Q3 operations review": artifact art_k3m9q2x7tp, version 1 at revision 2.
```

An entry with `"edited": true` was last written outside this conversation: most often a person's
edit in the app, such as a sheet's cells or columns or a canvas's notes and layout, but also
another conversation or the project's code. Start from it as it is, and keep its changes in yours
unless the user asks you to undo them; say what you built on when you reply.

When others changed a canvas while you worked, `update_artifact` merges your changes with theirs
and writes the merged result into the folder you updated from: keep editing it.

If another kind of artifact changes while you work, `update_artifact` refuses rather than write
over what it never saw, says who changed it, and installs it in place of your copy and in the
folder you published it from. What your sub-agents wrote reaches both the same way. Start again from that copy,
keep its changes, make yours again, and update it.

An entry without a `directory` is not installed: the conversation's artifacts were too large to
install together, or its files could not be read. Rebuild it in a working directory with the paths
in its `files`, then update it. An update keeps the artifact's kind; the title may change. Call
`publish_artifact` again only for a different deliverable.

## Rules

- A version holds at most 500 files, 25 MB per file, and 250 MB in all.
- A title is plain text of at most 200 characters that names the deliverable ("Q3 operations
  review"), not the request.
- Files and folders whose names start with a dot are not published.
- A sheet of the project's data is live, its rows read by a query, unless the user asked for a
  snapshot (`queries.md`).
- An artifact holds no secrets, credentials, or internal URLs.
