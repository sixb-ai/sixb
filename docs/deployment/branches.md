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
  sandboxes: new VercelSandboxFactory({
    credentials,
    auth: githubApp({ appId, privateKey }), // a private repository needs it
  }),
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
| `@sixb/pg` for production, PostgreSQL 16+ | Each branch gets a database on production's instance, with a role limited to it |
| A role that may `CREATEROLE` and `CREATEDB` | Production creates and drops each branch's role and database; managed admin users such as `doadmin` have both |
| Production's database closed to `PUBLIC` | `REVOKE CONNECT ON DATABASE <production's> FROM PUBLIC` (grant it back to production's user): a branch's role could connect to it otherwise, so production refuses to host branches until then |
| `max_prepared_transactions = 0` | PostgreSQL's default. A prepared transaction outlives its session, and no limit production sets on a branch could end it |
| A lock table that fits the ontology | A branch's copy takes about 120 locks plus 20 per object type, within a quarter of the lock table (`max_locks_per_transaction` × connections): raise `max_locks_per_transaction` for a large ontology. Production says so before the worker starts |
| `@sixb/sandboxes-vercel` or `@sixb/sandboxes-smolvm` | The branch serves from it. `@sixb/sandboxes-local` runs it on production's own host, so production refuses it |
| The sandbox factory's `auth` for a private repository | Production reads the repository's branches and the branch clones with it: `githubApp(...)`, or `githubOAuth(...)`, which reads and clones as the branch's creator, so its creator connects GitHub first. Without it, the branch says production cannot read the repository. smolvm cannot clone with it, so production refuses that pair |
| Bun 1.4.2+ in the sandbox | A branch installs and runs with Bun: boot the sandbox from the [Sixb agent image](https://github.com/sixb-ai/sixb/tree/main/sandboxes/agent-image#use-with-a-sandbox-provider), which has it. Otherwise, as on Vercel's stock runtime (Node only), the branch installs Bun 1.4.4 from the npm registry first, checked against the registry's sha512 |
| A sandbox recipe without `env` | A provider gives its recipe's `env` to every sandbox, a branch's too |
| Production's PostgreSQL reachable from the sandbox | The branch connects as its own role, with production's TLS settings. On Vercel, from Vercel's addresses |
| A direct connection to PostgreSQL | A pooler bound to one user (DigitalOcean's pools) refuses the branch's role, and a certificate file (`sslrootcert=/path`) does not reach the sandbox: use `sslmode=verify-full` with the system's roots, or `require` |
| `@sixb/pg` in the project's dependencies | The branch reaches its database with the project's own copy |
| `SIXB_BRANCH_DEV_ENV_TOKEN_FILE` (optional) | A credential your env source scopes to `dev` only. Without it, branches run without dev values, and say so |
| `SIXB_BRANCH_ALLOW` (optional) | `https://` origins the branch may reach beyond production's database and API, the git host, the npm and yarn registries and the project's model providers: the services its `dev` values point at, and a model provider of your own. Plain HTTP and a TCP service (`redis://`) cannot be allowed by name, and are refused |

## Open a branch

```ts
await sixb.branches.open("feature/invoices")    // copy what you read, then start it
await sixb.branches.refresh("feature/invoices") // a new copy: what the branch wrote goes
await sixb.branches.stop("feature/invoices")
await sixb.branches.delete("feature/invoices")  // sandbox, database and role go
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
| The worker drains (a deploy) | Stops at once, and opens again on the next worker |
| Its checkout fails | Fails with the step and its own words (clone, install, each up to 10 minutes). Opening it again checks it out anew |
| Vercel ends its session at your plan's limit | Stops, and says so |
| Nobody opens it for 14 days | Loses its copy; the next open takes a new one |
| Its git branch is deleted | Is deleted. A merge alone deletes nothing |

Each type is checked against the branch's own definitions as its copy loads: a type the branch
changed incompatibly is left out, and the branch says which and why.

A branch reaches production's database, production's API, the git host, the npm and yarn
registries, DuckDB's extensions (`https://extensions.duckdb.org`) when the project's lake is
DuckLake, the providers of the project's models (Anthropic, Vercel AI Gateway, Azure AI Foundry
and TypeSafe, at the URLs the project gives them) and what `SIXB_BRANCH_ALLOW` adds, and nothing
else: no private address and no cloud metadata endpoint.

On production's instance, a branch's role takes at most 5 connections. Its temporary files are
capped at 1 GiB when production's database user may set `temp_file_limit` (a superuser, or one
granted `SET` on it); managed PostgreSQL often keeps that to its own superuser, and the branch then
says it runs uncapped. Production cancels its statements past 15 minutes, ends its transactions past 30 minutes
and its sessions idle in a transaction past 60 seconds, so a branch never holds vacuum back for
long. Production stops a branch whose database grows past 20 GiB or twice production's own,
whichever is larger, or whose code holds more database locks than it needs, holds up production's
sessions, or connects to another database, and says so on the branch. A stopped branch can no
longer log in. PostgreSQL lets every role connect to the cluster's other databases unless they
revoke `CONNECT` from `PUBLIC`: revoke it on those too, or limit branch roles (`sixb_branch_…`) in
`pg_hba.conf` (large objects a branch creates there also keep its role from being dropped).
