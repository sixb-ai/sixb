# @sixb/connector-sftp

Promise-based SFTP connector for Sixb, backed by `ssh2`.

## Usage

```ts
import { defineConnector } from "@sixb/core"
import { sftp } from "@sixb/connector-sftp"

export const files = defineConnector(
  "files",
  sftp(
    {
      host: process.env.SFTP_HOST,
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASSWORD,
    },
    {
      readAheadRequests: 8,
    }
  )
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

### Directory permissions

`mkdir(...)` and `ensureDir(...)` accept optional POSIX permission bits. `ensureDir(...)` applies
the requested mode only to path segments created by that call and never changes existing directory
permissions:

```ts
await client.mkdir("/exports/private", { mode: 0o700 })
await client.ensureDir("/exports/shared/2026", { mode: 0o770 })
```

The SFTP server can restrict a requested creation mode through its umask or ACL policy. Use
`stat(...)` when the effective mode is a required postcondition. Use `chmod(...)` only when an
existing path must be changed explicitly:

```ts
await client.chmod("/exports/shared", 0o770)
const effectiveMode = (await client.stat("/exports/shared")).mode & 0o7777
```

Modes must be integers between `0o0000` and `0o7777`.

### Stream read-ahead

`readAheadRequests` controls how many ordered SFTP reads may be in flight for each streamed file.
It accepts integers from `1` to `64` and defaults to `1`, which preserves sequential reads. Higher
values can improve throughput on high-latency connections at the cost of bounded buffering and
additional work for the SFTP server.

Read-ahead applies only to `open(...)`. It preserves output order, backpressure, cancellation, and
remote-handle cleanup. Choose the value for the target server and remember that concurrent file
streams each receive their own read-ahead window.

### Raw SSH clients

Use `createSshClient()` when an integration needs an SSH channel without SFTP:

```ts
import { createSshClient } from "@sixb/connector-sftp"

const client = await createSshClient()
client.connect(connection)
```

This factory also keeps `ssh2` on its JavaScript crypto implementation under Bun. The optional
`sshcrypto` and `cpu-features` native addons remain available under Node, where they are supported.
