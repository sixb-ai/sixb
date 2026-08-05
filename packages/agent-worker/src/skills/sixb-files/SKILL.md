---
name: sixb-files
description: Use when publishing a generated file as a Sixb FileRef for a declared action or workflow.
compatibility: Requires the sandbox bash tool and SIXB_API_BASE_URL.
---

# Sixb Files

Use this skill when an action or workflow input requires a `fileRef` for a file you generated.
Uploading publishes an immutable blob; it does not attach the file to an object or grant permission
to change domain data.

## Workflow

1. Finish writing the local file before uploading it.
2. Read [files API](references/files-api.md) for the supported multipart request.
3. Upload only through `POST /api/files`; staged, multipart-session, and provider-direct routes are
   not available through the agent gateway.
4. Keep the complete returned FileRef unchanged when passing it to an approved action or workflow.
5. Use a declared action or workflow for any domain mutation involving the file.

## References

- Read [files API](references/files-api.md) for the upload command and response shape.
