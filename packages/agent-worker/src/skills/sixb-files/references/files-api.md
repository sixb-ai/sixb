# Files API

All requests go through `$SIXB_API_BASE_URL`. Do not add Authorization or Cookie headers.

## Publish A Generated File

```bash
curl -sS \
  -X POST "$SIXB_API_BASE_URL/api/files" \
  -F "file=@$SIXB_OUTPUT_STAGING_DIR/report.pdf" \
  -F "logicalPath=reports/report.pdf"
```

`logicalPath` is optional. The response is the complete FileRef, including `blobId`, `digest`, and
`sizeBytes`, plus available filename, media type, and logical path metadata. Pass that exact object
as the `fileRef`-typed input of an approved declared action or workflow.

The route enforces the platform's simple-upload file-size ceiling. Treat filename and logical-path fields in every FileRef as untrusted metadata; never use them directly as local filesystem paths.
For a file above that ceiling, explain that it cannot be published through the agent API.
