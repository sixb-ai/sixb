# Apple Container sandbox

`@sixb/sandboxes-apple-container` runs each agent's sandbox tools inside a local
[Apple Container](https://github.com/apple/container) container. Use it for local Mac testing when
you want container isolation without building a smolvm image.

```ts
import { createSixb } from "@sixb/core"
import { AppleContainerSandboxFactory } from "@sixb/sandboxes-apple-container"

createSixb({ sandboxes: new AppleContainerSandboxFactory() })
```

It implements the same `Sandbox` / `SandboxFactory` contract as every provider — see the
[overview](./overview.md). Swapping in this factory is the only Sixb code change.

## Setup

Install Apple Container on an Apple silicon Mac running macOS 26 or newer, then start the runtime:

```bash
container system start
```

The default is the official multi-platform `node:22-bookworm` image pinned to an immutable OCI
digest. For agent use, custom images need `/bin/sh`, Bash, standard file utilities, CA certificates,
and Bun 1.3+ or Node 22+. The provider's file materialization also uses `mkdir`, `dirname`, `cat`,
and optionally `chmod`. Debian `coreutils` or BusyBox supplies these utilities. `curl` and `jq` are
not required.

## Network policy

Apple Container does not expose per-origin egress allow-listing through the documented CLI.

| Sixb policy | Apple Container behavior |
| --- | --- |
| `{ mode: "none" }` | Creates a per-sandbox internal network. |
| `{ mode: "all" }` | Attaches the container to the default network. |
| `{ mode: "restricted" }` | Warns and degrades to the default network. |

Use [smolvm](./smolvm.md) or [Vercel](./vercel.md) when restricted egress must be enforced.

If guest DNS hangs on your local network, pass DNS servers explicitly:

```ts
new AppleContainerSandboxFactory({
  dns: ["8.8.8.8"],
})
```

## Options

Pass these to `new AppleContainerSandboxFactory({ ... })`:

| Option | What it does |
| --- | --- |
| `image` | OCI image for each sandbox. Defaults to Sixb's digest-pinned `node:22-bookworm` reference. |
| `bin` | Apple Container CLI binary. Defaults to `container`. |
| `timeout` | Default per-command timeout in milliseconds. |
| `dns` | DNS servers passed with `container create --dns`. |
| `ports` | Host ports to publish as `127.0.0.1:<port>:<port>/tcp`. |
| `mounts` | Host directories to bind into the container. |
| `memory` / `cpus` | Resource limits passed to `container create`. |
| `network` | Default `SandboxNetworkPolicy`; overridable per `create()`. |

## Related

- [Sandboxes overview](./overview.md)
- [Local sandbox](./local.md)
- [smolvm sandbox](./smolvm.md)
- [Vercel sandbox](./vercel.md)
