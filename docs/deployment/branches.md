# Branches next to production

Run a git branch of your project next to production, on a copy of what you read there: its API
and its app. Nothing the branch does reaches production: it calls no connector, sends nothing,
and runs no cron schedule.

## Set it up

Name the project's repository, and give production a sandbox provider that keeps a branch's code
away from production's host:

```ts
// sixb.config.ts
export default createSixb({
  source: { repository: "acme/shop" }, // or any URL git clones; `path` for a project in a folder
  sandboxes: new VercelSandboxFactory({ credentials }),
  storage: new PostgresStorage({ connectionString: process.env.DATABASE_URL }),
  // …
})
```

Then run the branch worker beside production's other workers:

```bash
SIXB_BRANCH_DEV_ENV_TOKEN_FILE=/run/secrets/dev-env-token \
SIXB_BRANCH_ALLOW=https://redis.dev.shop.example \
  sixb worker branches --api-public-origin https://api.shop.example.com
```

| Needs | Why |
|---|---|
| `@sixb/pg` for production, PostgreSQL 16+ | Each branch gets a schema on production's instance, with a role limited to it |
| A role that may `CREATEROLE` | Production creates and drops each branch's role |
| `@sixb/sandboxes-vercel` or `@sixb/sandboxes-smolvm` | The branch serves from it. `@sixb/sandboxes-local` runs it on production's own host, so production refuses it |
| A sandbox recipe without `env` | A provider gives its recipe's `env` to every sandbox, a branch's too |
| Production's PostgreSQL reachable from the sandbox | The branch connects as its own role, with production's TLS settings. On Vercel, from Vercel's addresses |
| A direct connection to PostgreSQL | A pooler bound to one user (DigitalOcean's pools) refuses the branch's role, and a certificate file (`sslrootcert=/path`) does not reach the sandbox: use `sslmode=verify-full` with the system's roots, or `require` |
| `@sixb/pg` in the project's dependencies | The branch reaches its schema with the project's own copy |
| `SIXB_BRANCH_DEV_ENV_TOKEN_FILE` (optional) | A credential your env source scopes to `dev` only. Without it, branches run without dev values, and say so |
| `SIXB_BRANCH_ALLOW` (optional) | Origins the branch may reach beyond production's database and API, the git host, the npm and yarn registries and the project's model providers: the services its `dev` values point at, and a model provider of your own |

## Open a branch

```ts
await sixb.branches.open("feature/invoices")    // copy what you read, then start it
await sixb.branches.refresh("feature/invoices") // a new copy: what the branch wrote goes
await sixb.branches.stop("feature/invoices")
await sixb.branches.delete("feature/invoices")  // sandbox, schema and role go
```

The same through the API: `GET /api/branches`, `POST /api/branches` with `{ name }`,
`POST /api/branches/refresh`, `POST /api/branches/stop`, and `DELETE /api/branches?name=…`. It takes
`can.manage(project.source)`. Push the branch first: one the remote does not have fails, and says
so. A copy waits while its creator has another one running, or while two run in the project.

| When | The branch |
|---|---|
| You push | Reloads its code within about 10 seconds; installs again when the push changes `package.json` or a lockfile. Its data stays |
| Nobody uses it for 20 minutes | Stops |
| You open it again | Keeps its copy when the provider resumed its machine (Vercel). Otherwise, as on smolvm, it takes a new copy and says its data was reset. Each deploy of the worker does the same to smolvm branches |
| Vercel ends its session at your plan's limit | Stops, and says so |
| Nobody opens it for 14 days | Loses its copy; the next open takes a new one |
| Its git branch is deleted | Is deleted. A merge alone deletes nothing |

Each type is checked against the branch's own definitions as its copy loads: a type the branch
changed incompatibly is left out, and the branch says which and why.

A branch reaches production's database, production's API, the git host, the npm and yarn
registries, the providers of the project's models (Anthropic, Vercel AI Gateway, Azure AI Foundry
and TypeSafe, at the URLs the project gives them) and what `SIXB_BRANCH_ALLOW` adds, and nothing
else: no private address and no cloud metadata endpoint.

On production's instance, a branch's role takes at most 5 connections. Its temporary files are
capped at 1 GiB when production's database user may set `temp_file_limit` (a superuser, or one
granted `SET` on it); managed PostgreSQL often keeps that to its own superuser, and the branch then
says it runs uncapped. Production cancels its statements past 15 minutes, ends its transactions past 30 minutes
and its sessions idle in a transaction past 60 seconds, so a branch never holds vacuum back for
long. PostgreSQL lets every role connect to the cluster's other databases unless they revoke
`CONNECT` from `PUBLIC`: revoke it, or limit branch roles (`sixb_branch_…`) in `pg_hba.conf`.
