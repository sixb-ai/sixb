# @sixb/env-azure-key-vault

Keep a Sixb project's environment variables in [Azure Key Vault](https://learn.microsoft.com/azure/key-vault/).

```ts
// sixb.env.ts
import { defineEnv } from "@sixb/core/env"
import { azureKeyVault } from "@sixb/env-azure-key-vault"

export default defineEnv({
  source: azureKeyVault({ vaults: { dev: "client-a-dev", prod: "client-a-prod" } }),
  vars: { DATABASE_URL: "required" },
})
```

See [Environment variables](https://docs.sixb.ai/deployment/environment-variables).

## How it works

The rest of this file is for working on the package.

Each environment is its own vault, as Microsoft recommends. Key Vault names allow letters, digits
and hyphens, so `DATABASE_URL` is the secret `DATABASE-URL`. Key Vault ignores case in names, so
`write` refuses two names that differ only in case. Disabled secrets can't be read, and managed ones
back certificates, so `names` and `read` skip both.

Every call goes straight to Key Vault's REST API. A token comes from, in order:

1. The token the caller passes: a server's credential, a JSON object with `tenant`, `clientId` and
   `clientSecret`, traded for an access token with Microsoft Entra ID.
2. `az account get-access-token`: a person signed in with `az login`, or a CI job after
   `azure/login`. In a terminal, a person who isn't signed in is sent through `az login` first.

It never reads `AZURE_CLIENT_ID` and the rest: a project's `.env` often holds those for its own app,
and Bun loads that file into the CLI's process.

A failed request throws `EnvSourceUnreachableError` when Azure can't answer: no connection, a
timeout, a 429, or a 5xx, from the vault or from Entra ID. Anything else means Azure refused, and
throws a plain error. The CLI tells them apart: a deploy can continue through an outage, but never
past a revoked credential.

Key Vault has no bulk read or write: `read` lists the vault and gets each secret, and `write` sets
one secret per request, a few at a time. A failed write can leave some values written.

`createServerToken` runs `az` as the signed-in person. It creates a service principal and lets it
read the one vault: the `Key Vault Secrets User` role on a vault using Azure RBAC, or a `get` and
`list` access policy on one using access policies. If it can't grant that, it deletes the service
principal again. The secret expires after a year, Azure's default.

`tests/azure-key-vault.e2e.ts` runs against a real vault and is skipped without
`AZURE_KEY_VAULT_E2E_VAULT`. See the file for what it needs.
