# @sixb/deploy-ssh

Deploy target for a Linux server you reach over SSH. Caddy on the server routes each domain to its
service, and the services run as an unprivileged deploy user.

```ts
// sixb.deploy.ts
import { defineDeploy } from "@sixb/core/deploy"
import { SshTarget } from "@sixb/deploy-ssh"

export default defineDeploy({
  name: "northline",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10" }),
})
```

| Option | Default | Description |
| --- | --- | --- |
| `host` | — | The server: a hostname, an IP address, or a `Host` alias from your SSH config. Use an alias for an SSH port other than 22. |
| `user` | `"sixb"` | The Linux user the deployment runs as. Projects under one user can read each other's files; give a project its own user to wall it off. Never `root`. |
| `ports` | atlas 3000, app 3001, api 3002 | Local ports Caddy forwards to. Set them when projects share a server so that each has its own. |

Run `sixb deploy --dry-run` to print what a deployment runs: every process with its command,
environment, and address.
