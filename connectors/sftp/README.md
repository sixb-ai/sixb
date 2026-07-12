# @sixb/connector-sftp

Promise-based SFTP connector for Sixb, backed by `ssh2`.

## Usage

```ts
import { defineConnector } from "@sixb/core"
import { sftp } from "@sixb/connector-sftp"

export const files = defineConnector(
  "files",
  sftp({
    host: process.env.SFTP_HOST,
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
  })
)
```

The connected `SftpClient` exposes directory and file operations such as `list`, `stat`, `open`,
`read`, `write`, `rename`, and `delete`.

Use `open(...)` for large files. It preserves backpressure and closes the remote handle when the
stream is canceled or its signal aborts:

```ts
const body = await client.open("/exports/video.mov", { signal })
const fileRef = await blobs.put({ body, expectedSizeBytes: size, signal })
```

`read(...)` returns a `Buffer` and remains useful when the complete file is intentionally needed in
memory.
