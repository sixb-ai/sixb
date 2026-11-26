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
| `@sixb/sandboxes-vercel` or `@sixb/sandboxes-smolvm` | The branch serves from it. smolvm also needs a [preview domain](#use-a-branch-in-the-browser). `@sixb/sandboxes-local` runs it on production's own host, so production refuses it |
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
`POST /api/branches/refresh`, `POST /api/branches/stop`, and `DELETE /api/branches?name=…`. Every
call takes `can.manage(project.source)`. Push the branch first: one the remote does not have fails,
and says so. A copy waits while its creator has another one running, or while two run in the
project.

## Use a branch in the browser

**Console › Branches** lists the branches with their state, how old their data is and who opened
each, and updates as they start. **Open** signs you into a branch in a new tab; the menu refreshes
it from production, stops or deletes it. A refresh copies what the branch's creator reads, whoever
asks for it. A branch no worker takes up within a minute says it is waiting for a free one. From
code:

```ts
const { url } = await sixb.branches.signIn("feature/invoices") // POST /api/branches/sign-in
// open `url` within a minute: you land on the branch's app, signed in as yourself
```

Every page of a branch's app opens under a thin bar: the branch, how old its data is, **Back to
production** and, for whoever may refresh the branch, **Refresh…** (`SIXB_APP_PUBLIC_ORIGIN` on the
branch worker says where production is).
The app's shell leaves room for it; a layout that sizes itself to the screen subtracts
`var(--app-top-inset, 0px)`.

A branch has an origin of its own, never production's: `<branch>.<previewDomain>` when the
project names one, else its sandbox's URL (Vercel's own domain). smolvm serves branches on its
host's loopback, which nobody's browser reaches: name a preview domain with it, or the branch
worker refuses to start in production.

```ts
source: { repository: "acme/shop", previewDomain: "shop-preview.dev" },
```

| Preview domain | |
|---|---|
| Its own site | Register a domain apart from production's: `shop-preview.dev` beside `shop.dev`, never `preview.shop.dev`. On production's site, a branch's pages would get production's cookies, so production refuses one that shares a site with its API, its app or its `cookieDomain`. Vercel's `vercel.app` is safe because it is on the [Public Suffix List](https://publicsuffix.org), which makes every subdomain a site of its own |
| DNS and TLS | A wildcard record, `*.shop-preview.dev`, to production's API server, and a wildcard certificate for it. Production forwards each host to its branch, WebSockets included |
| Limits | Branches share 64 of production's connections at once. A request has 30 s to start answering and 5 min to finish, a WebSocket an hour |

You sign in from production only: production checks your grant, the branch lets you in as
production has you now (a member, in your groups), and the one-time link signs you in there. The
link works once, for you, for a minute. The branch's session lasts 4 hours at most, so losing the
grant reaches the branch within that. The branch has no other sign-in, and its project's own
strategy signs nobody in. It makes no access token and issues no share link: either would let
someone in past that session.
A branch on your laptop (`sixb dev --from production`) needs no sign-in: it runs as you, and answers
your machine only.

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

A branch is the dry run of its [migrations](../ontology/migrations.md) on production's data: see
[what its copy holds](../cli/production-data.md#what-the-branch-holds). The Console lists what the
copy left out, what a deploy would print, and the types the migrations ran on.

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
