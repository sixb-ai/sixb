# @sixb/env-doppler

Keep a Sixb project's environment variables in [Doppler](https://www.doppler.com).

```ts
// sixb.env.ts
import { defineEnv } from "@sixb/core/env"
import { doppler } from "@sixb/env-doppler"

export default defineEnv({
  source: doppler({ project: "client-a" }),
  vars: { DATABASE_URL: "required" },
})
```

See [Environment variables](https://docs.sixb.ai/deployment/environment-variables).

## How it works

The rest of this file is for working on the package.

| Sixb | Doppler config |
| --- | --- |
| `dev` | `dev` |
| `prod` | `prd` |

Every call goes straight to Doppler's REST API. A token comes from, in order:

1. The token the caller passes: a server's read-only token.
2. `DOPPLER_TOKEN`: a CI job's token.
3. `doppler configure get token --plain`: a person signed in with `doppler login`. In a terminal,
   a person who isn't signed in is sent through `doppler login` first.

A failed request throws `EnvSourceUnreachableError` when Doppler can't answer: no connection, a
timeout, a 429, or a 5xx. Anything else means Doppler refused, and throws a plain error. The CLI
tells them apart: a deploy can continue through an outage, but never past a revoked token.

`read` drops the `DOPPLER_*` names Doppler adds about itself, so they never reach a project's `.env`.

`tests/doppler.e2e.ts` runs against a real project and is skipped without `DOPPLER_TOKEN`. See the
file for what it needs.
