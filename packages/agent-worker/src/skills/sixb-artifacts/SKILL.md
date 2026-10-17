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
| `file` | One file in a format the user asked for (PDF, DOCX, XLSX, PPTX, CSV), or a binary | `file.md` |

Prefer a `document` to a DOCX or PDF, and a `sheet` to an XLSX or CSV file, unless the user asked
for that format: they render in the app, and their versions stay readable side by side. A report
with a table of a dozen rows is a document; data the reader works with is a sheet.

## Publish

1. Write the artifact's files in a working directory, such as `work/q3-review/`.
2. Call `publish_artifact` with that directory (or one file), the kind, and a title:

   ```text
   publish_artifact({ path: "work/q3-review", kind: "document", title: "Q3 operations review" })
   → { artifactId: "art_k3m9q2x7tp", version: 1, kind: "document", title: "Q3 operations review", warnings: [] }
   ```

3. If it refuses, nothing was published. Fix what the message names and publish again. If you
   cannot, tell the user the deliverable could not be published; never describe it as ready.
4. Fix what each warning names and publish its next version when it matters to the reader.
5. In the reply, say in a sentence or two what you published and what stands out. Do not paste
   its content, its id, or a path: the user sees the artifact.

## Revise

The artifacts this conversation published are listed in `$SIXB_ARTIFACTS`, each with its latest
version installed under `$SIXB_ARTIFACTS_DIR/<id>/`. To change one, start from that version, not
from an older working copy:

```bash
rm -rf work/q3-review && cp -r "$SIXB_ARTIFACTS_DIR/art_k3m9q2x7tp" work/q3-review
```

Edit the copy, then publish it as the artifact's next version:

```text
publish_artifact_version({ id: "art_k3m9q2x7tp", path: "work/q3-review", title: "Q3 operations review" })
→ { artifactId: "art_k3m9q2x7tp", version: 2, ... }
```

An artifact you published earlier in this turn is not installed yet: publish its next version from
your working copy. A new version keeps the earlier ones and the artifact's kind; the title may
change. Call `publish_artifact` again only for a different deliverable.

## Rules

- A version holds at most 200 files, 25 MB per file, and 100 MB in all.
- A title is plain text of at most 200 characters that names the deliverable ("Q3 operations
  review"), not the request.
- Files and folders whose names start with a dot are not published.
- An artifact holds no secrets, credentials, or internal URLs.
