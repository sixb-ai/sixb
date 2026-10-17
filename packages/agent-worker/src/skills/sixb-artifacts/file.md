# Files

A `file` artifact is exactly one file, delivered as it is. Publish one when the user asked for a
format (PDF, DOCX, XLSX, PPTX, CSV), or when the deliverable is a binary such as an image or an
archive. When no format was asked for, write a `document` instead.

```text
publish_artifact({ path: "work/service-report.pdf", kind: "file", title: "Harbor Point service report" })
```

- The artifact keeps the file's name, which is what the user downloads. Name it for the
  deliverable: `harbor-point-service-report.pdf`, not `output.pdf`.
- The app shows images, PDFs, Markdown, CSV and TSV tables, and plain text in place. Other formats
  download.
- Check the file before publishing it: render documents, decks, and spreadsheets with
  `sixb-render` and inspect the previews; open a CSV and check its header row and a few rows.
- Publish each file the user asked for as its own artifact.
