---
name: sixb-artifacts
description: Publish a deliverable the user should see, such as a report, a write-up, a table of data, or a file they asked for, as an artifact, and revise it as a new version.
---

# Artifacts

An artifact is a deliverable the user opens beside the conversation. It has a kind, a title, and
versions that stay readable. Publish one when the user asks for a report, a document, a table, or
a file, or when the answer is long-form work or data they will read, reuse, or share. When a few sentences answer
the question, answer in the chat.

## Kinds

| Kind | Publish it for | Read first |
| --- | --- | --- |
| `document` | A report, brief, memo, plan, or write-up: anything read top to bottom | `document.md` |
| `sheet` | Tabular data the reader sorts, sums, charts, or downloads: metrics, lists, trackers, exports | `sheet.md` |
| `slides` | A deck to present: a review, a pitch, a plan for a meeting | `slides.md` |
| `page` | A small web app the reader works with: a calculator, a planner, a dashboard with filters | `page.md` |
| `canvas` | Screens side by side with arrows, a brainstorm or retro of notes, a diagram | `canvas.md` |
| `file` | One file in a format the user asked for (PDF, DOCX, XLSX, PPTX, CSV), or a binary | `file.md` |

To show or link to another artifact, such as a sheet's chart in a report, read `references.md`.
Data from the project's objects goes in a query, so the artifact stays live: read `queries.md`.

Prefer a `document` to a DOCX or PDF, a `sheet` to an XLSX or CSV file, and `slides` to a PPTX,
unless the user asked for that format: they render in the app, and their versions stay readable side by side. A report
with a table of a dozen rows is a document; data the reader works with is a sheet.

## Publish

1. Write the artifact's files in a working directory, such as `work/q3-review/`.
2. Call `publish_artifact` with that directory (or one file), the kind, and a title:

   ```text
   publish_artifact({ path: "work/q3-review", kind: "document", title: "Q3 operations review" })
   → Published "Q3 operations review" as artifact art_k3m9q2x7tp, version 1.
   ```

3. If it refuses, nothing was published. Fix what the message names and publish again. If you
   cannot, tell the user the deliverable could not be published; never describe it as ready.
4. Fix what each warning names and publish its next version when it matters to the reader. A
   deck also comes back with a screenshot of each slide, a page with one at a laptop's width and
   one at a phone's, and a canvas with one of each board: look at them (`slides.md`, `page.md`,
   `canvas.md`, Check).
5. In the reply, say in a sentence or two what you published and what stands out. Do not paste
   its content, a path, or its id as text: the user sees the artifact. To show a chart or a range
   of it in place, use its address (`references.md`). A figure you cite from live data is the one
   you read, and what the artifact shows moves on as the objects change, even at a pinned version:
   date it with when you read it, in the user's time zone ("As of Oct 23, 10:42, three invoices
   are overdue.").

## Revise

The artifacts this conversation published are listed in `$SIXB_ARTIFACTS`, each with its latest
version installed under `$SIXB_ARTIFACTS_DIR/<id>/`, including one you published moments ago. To
change one, start from that version, not from an older working copy:

```bash
rm -rf work/q3-review && cp -r "$SIXB_ARTIFACTS_DIR/art_k3m9q2x7tp" work/q3-review
```

Edit the copy, then publish it as the artifact's next version:

```text
publish_artifact_version({ id: "art_k3m9q2x7tp", path: "work/q3-review", title: "Q3 operations review" })
→ Published "Q3 operations review" as artifact art_k3m9q2x7tp, version 2.
```

An entry with `"edited": true` has a latest version published outside this conversation after you
last published it: most often a person's edit in the app, such as a sheet's cells or columns or a
canvas's notes and layout, but also another conversation or the project's code. Start from that
version as it is, and keep its changes in yours unless the user asks you to undo them; say what you
built on when you reply.

If the artifact moves on while you work, `publish_artifact_version` refuses rather than publish
over the newer version, says who published it, and installs it in place of your copy. Start again
from that copy, keep its changes, make yours again, and publish.

An entry without a `directory` is not installed: the conversation's artifacts were too large to
install together, or its files could not be read. Rebuild it in a working directory with the paths
in its `files`, then publish its next version. A new version keeps the earlier ones and the
artifact's kind; the title may change. Call `publish_artifact` again only for a different
deliverable.

## Rules

- A version holds at most 200 files, 25 MB per file, and 100 MB in all.
- A title is plain text of at most 200 characters that names the deliverable ("Q3 operations
  review"), not the request.
- Files and folders whose names start with a dot are not published.
- A sheet of the project's data is live, its rows read by a query, unless the user asked for a
  snapshot (`queries.md`).
- An artifact holds no secrets, credentials, or internal URLs.
