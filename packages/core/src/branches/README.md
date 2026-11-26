# Hosted branches

A git branch of the project, run next to production. Production makes the branch a database of
its own on production's PostgreSQL instance, owned by a role limited to it. The branch's own
`sixb dev` runs in a sandbox, behind a front that answers only production, as the same runtime
`sixb dev --from production` runs on a laptop: it loads its copy of what its creator reads into its
database, and serves. Branch mode (`branch-mode/README.md`) holds the branch to its gates: nothing it
does reaches production.

```txt
sixb.branches.open(name)        branches row (wanted: running)
        │
sixb worker branches            reads the remote's heads (git ls-remote, every 10 s)
  │                             claims the row once the remote has the branch (lease, revision)
  ├─ every 20 s   renew the lease; past it unrenewed, let the branch go
  ├─ every 3 s    hold the role to its limits, a load or a checkout included
  ├─ sandbox      restricted network; resumed, or made anew under its name: Bun if missing,
  │               clone, install, each a worker command
  ├─ copy         empty database + role ◄── production
  │               copyForBranch as the creator ──► sandbox .sixb/branches/hosted.copy
  ├─ runtime      `sixb dev` in branch mode: loads the copy as the role, on its own definitions;
  │               its front, its API, the project's app
  ├─ every 3 s    keep-alive, pull remoteCommit, refresh, status and use from the front
  └─ stop         unused 20 min, closed by production, or drained → stopped, login taken away;
                  deleted, or gone from the remote → sandbox (by name), database, role, row
```

| Where | What |
|---|---|
| `execution.ts` | `sixb.branches`: list, open, refresh, stop, delete. They only say what is wanted, over the row as read |
| `data.ts` | Production's side: the database made anew for each copy, the role's login and limits |
| `copy.ts`, `wire.ts`, `credential.ts`, `copy-slots.ts` | The copy production sends a branch, the credential it reads production with, and how many run at once |
| `runtime.ts` | The branch runtime, laptop and hosted: what it is started with, and its front's status |
| `source.ts` | `createSixb({ source })`, the checkout recipe and the install |
| `@sixb/branch-worker` | The worker: the read of the remote, the lease, the copy, the runtime |
| `@sixb/pg` `hosted-branches.ts` | The database and its role |
| `storage/branches` | Each branch's row: what is wanted of it, and what its worker found |
| CLI `dev-branch.ts`, `branch-providers.ts`, `branch-from-production.ts` | The runtime's front, the database it runs on, and its copy's load |

## Lifecycle

| Event | What happens |
|---|---|
| Open | A row, with its namespace and key. The worker claims it once the remote has the branch; a branch the remote never had fails, and says so |
| Claim | Sandbox resumed, or made: its checkout runs as the worker's own commands, each bounded at 10 min and failing in its own words, Bun installed from npm first where the image has none or one older than 1.4.2, then first on the PATH. A last step marks the checkout done. Copy taken, runtime started |
| Push | The read of the remote writes the head to `remoteCommit`; the worker holding the branch resets its checkout to it, and the runtime's watcher reloads the code. A push that changes `package.json` or a lockfile stops the runtime, installs, then starts it. The data stays |
| Refresh | A new copy: the database and its role are made anew, so what the branch wrote goes. The row has no copy until the new one is loaded |
| Stop, or 20 min unused | The runtime stops and the role's login goes (`closeBranchData`); a provider that persists sandboxes keeps its state. A copy delivered and not loaded yet lets its lake slice go |
| Closed by production | `enforceBranchLimits` found it taking what the instance cannot spare: it stops, without a restart, with a `database-limit` notice |
| Reopen | A resumed sandbox runs on its copy. One whose last session still runs (its worker died) is waited for, up to 12 min. One whose state is gone, or whose first checkout never finished, is deleted by name and made anew under the same name and port: the port is the sandbox's route, set when it was made, and the worker never changes it. A sandbox made anew takes a whole new copy, with a `data-reset` notice: what the branch wrote is gone |
| Machine ended | A provider that ends a session at its limit (Vercel's plan maximum) stops the branch, with a `machine-ended` notice |
| 14 days unopened | Its copy, database and role go; the next open takes a new copy |
| Delete, or its remote branch deleted | Sandbox, database, role and row go. A saved sandbox is deleted by name (`SandboxFactory.destroy`), without a session or credentials. A delete that fails stays wanted, and the next claim tries again |
| Worker drained or stopped | Each branch it holds is put back as a stop puts it, at once: the next worker opens it |
| Nobody holds it, stopped | `settleStopped` takes its login away, whoever left it (a worker that died left its runtime's sessions running, unbounded): it claims the row through its revision first, so a login another worker just opened stays, then writes it stopped. Once per revision and worker |

A merge ends nothing by itself: a branch reset to the default branch looks the same, and would
lose its data. A branch ends when its remote branch is deleted, as a merged one usually is.

Use is what the runtime's front forwards: production's status reads don't count. Until preview
URLs forward people's requests, only `open` and `refresh` keep a branch from stopping. A copy
counts as use when it ends, however long it took.

Neither `@sixb/sandboxes-local` nor `@sixb/sandboxes-smolvm` resumes a sandbox: every stop, and
every restart of the worker (a deploy drains it), means a new copy at the next open there. Vercel
resumes. Nothing is kept half: the branch's data and its lake slice always
come from one copy.

## The lease

A worker holds a branch for 60 s at a time and renews it every 20 s, apart from its work: a
clone, a copy or an install outlasting the lease never lets another worker take the branch. A
worker that cannot renew in time lets the branch go: it stops the runtime and the sandbox, as
another worker may hold the branch by then. A worker that begins stopping claims nothing more.
Before each step that drops what the branch has (its database and role, its sandbox), the hold
checks the lease still holds for 15 s, renewing it first when it does not: a worker back from a
pause finds another worker's name on the row, and drops nothing.

The worker's writes compare the row's revision. A retry after someone else moved the row on
writes what the worker found, but never its own `wanted` over a newer delete, stop, open or
refresh.

The read of the remote (`mirror.ts`) writes why it failed to `remoteError` on the branches that
wait for it, a private repository read without credentials say, and clears it once a read
succeeds. Source credentials come from the project's sandbox `auth`, with the host's connector
connections for an OAuth source: the creator's own for a branch's clone, and a waiting branch's
creator's for the read of every branch.

## The runtime

`sixb dev` in the sandbox, started with the project's `dev` values (when the deployment gives the
worker a credential that reads `dev` only, `SIXB_BRANCH_DEV_ENV_TOKEN_FILE`; else a `no-dev-env`
notice), then its key, its port and branch mode's variables (`SIXB_BRANCH`,
`SIXB_BRANCH_DATA_FROM=production`) over them, plus:

| Variable | Read by |
|---|---|
| `SIXB_BRANCH_DATABASE_URL`, `SIXB_BRANCH_DATABASE_SCHEMA` | The CLI, which builds the project's own `@sixb/pg` on them: the branch's database, with production's schema name, which it loads its copy into and runs on (`hostOnBranch`) |
| `SIXB_BRANCH_PUBLIC_ORIGIN` | The project's app, which sends its API requests to the front |

Its copy arrives as a laptop's does: production writes it whole to `.sixb/branches/hosted.copy`
(0600, in a 0700 folder), and the runtime's first generation loads it into its database, then reads
production's lake and object files with the branch credential the copy carries, never with a
production token. The front says what the runtime loaded (its age, objects and types left out)
in its status, where production reads it.

Nothing of production's environment reaches the sandbox: the worker refuses a sandbox recipe that
sets `env`, which its provider would give every sandbox, a branch's too.

The front, on the branch's port, never loads project code. It answers with the generation's
state, the commit, the project file a startup error points at, the copy it loaded, and the
requests it forwarded; every request needs the branch's key, which only production holds. It sends the API's paths
(`/api`, `/auth`, `/ws`, `/docs`, `/health`, `/ready`) to the API on the next port, and the rest
to the project's app on the one after. A runtime that keeps exiting starts again after 5 s, then
twice as long each time, up to 5 min; one that never answers within 3 min fails the branch.

## The sandbox

In production the worker refuses `@sixb/sandboxes-local`, which runs a branch on its own host.
`@sixb/sandboxes-vercel` serves a port through its public domain (4 ports at most),
`@sixb/sandboxes-smolvm` on the host's loopback. The worker also refuses a provider that resumes
sandboxes but cannot delete one by name, and, with source `auth`, one whose commands get request
credentials only through a forwarder (`forwardsRequestCredentials`: smolvm), which `git clone`
does not use.

Its network is restricted to production's PostgreSQL instance, production's API, the git host,
the npm and yarn registries, `https://extensions.duckdb.org` when the project's lake is DuckLake,
the providers of the project's models (each says where it calls when
it is made: `models/origins.ts`), and the origins `SIXB_BRANCH_ALLOW` adds (the services the `dev`
values point at, a model provider of the project's own; HTTPS only, as Vercel allows neither
plain HTTP nor a TCP service by name). The provider refuses the rest: private ranges, link-local and cloud metadata
included. PostgreSQL is allowed by its addresses, resolved when the sandbox is made: it negotiates
TLS after it connects, so no firewall that reads TLS names can match its host name.

| Provider | Enforces | Notes |
|---|---|---|
| Vercel | Domains by TLS name, PostgreSQL's addresses as `/32` | Production's PostgreSQL must accept connections from Vercel's addresses |
| smolvm | Hosts, resolved when the VM starts, every port of each | A real-VM test proves metadata and other private addresses unreachable |
| local | Nothing (`isolation: "none"`) | Development and tests only |

## Production's instance

The rule: the branch's credentials open its own data and nothing else, and nothing the branch does
runs with production's privileges. A database per branch keeps apart what PostgreSQL scopes to a
database: advisory locks, the vacuum horizon of ordinary tables (PostgreSQL 14+), the statistics
views (`pg_stat_*`, so a branch never reads production's row counts) and large objects. What can
still reach production is the instance's shared capacity: shared catalogs' vacuum, connections,
the lock table and disk. The limits are set for those.

Production checks its instance before it hosts any branch (`branchHostingRequirement`, then
again at each copy): PostgreSQL 16+, `CREATEROLE` and `CREATEDB`, `max_prepared_transactions =
0`, its own database closed to `PUBLIC`, and a lock table large enough for the ontology's copy.
Each refusal says what to run.

| Holds | How | Proved by |
|---|---|---|
| The role owns its database and every table in it | `CREATE DATABASE … OWNER role`; the branch's runtime migrates and loads it, as the role | `pg-hosted-branches.e2e.ts` |
| No one else connects to it | `REVOKE ALL ON DATABASE … FROM PUBLIC`: only the role, and production through it | (same) |
| Production runs nothing in it but its own extensions | Before the role first logs in, production creates there `pg_trgm` and `vector` when its own database has them, which a branch may not create | (same) |
| Production's own locks and statistics | Advisory locks and `pg_stat_*` are per database, and production's database is closed to `PUBLIC` (a requirement), so the role cannot connect to it | (same) |
| A login only while it runs | `NOLOGIN` until `openHostedBranch`, which gives a new password `VALID UNTIL` 15 minutes ahead and ends an earlier runtime's sessions; `enforce` renews it while a worker holds the branch; `closeBranchData` takes it away and ends the sessions once the runtime stops, and the worker's backstop (`settleStopped`, #1271) closes every branch no worker holds | (same) |
| Production never waits on the role's own row | Each of production's statements on the role or its database waits at most 2 s for a lock (`lock_timeout`); when the role holds its own row (an `ALTER ROLE` of its own left open), production ends its sessions and tries again, five times | (same) |
| No prepared transactions | `max_prepared_transactions = 0` is a requirement: one the branch prepared would outlive its session with its locks, and only its owner may finish it | `pg-hosted-branch-requirements.test.ts` |
| No password in a statement | A SCRAM-SHA-256 verifier computed by production, a new one each start, none stored | `pg-hosted-branches.e2e.ts` |
| Connections | `CONNECTION LIMIT` 5 on the role, out of the instance's `max_connections` (about 25 on DigitalOcean's smallest plans) | (same) |
| Vacuum of what databases share | Every 3 s, from outside: transactions past 30 min end (a 9M-object load took 4 min), and sessions idle in a transaction past 60 s; statements past 15 min are cancelled. A copy's load keeps its waiting lanes busy with a `SELECT 1` | (same) |
| The lock table every database shares | It holds `max_locks_per_transaction` × (`max_connections` + `max_prepared_transactions`) locks, 6,400 by default, and a full one fails production's new connections with "out of shared memory" (15,000 advisory keys of one session did). A branch whose sessions together hold more than a quarter of it closes, and so does the branch holding the most once all branches hold more than three eighths (two at their full share): production always keeps more than half. So does a branch with a session holding more than 64 advisory locks (the framework takes a few). A copy's load holds about 120 locks plus 20 per type at most, so a quarter of the default table fits about 70 types; a larger ontology is refused up front, with the `max_locks_per_transaction` it needs | (same) |
| Production's sessions never wait on the branch | A branch session in `pg_blocking_pids()` of another role's session closes the branch | (same) |
| Production's other databases | A branch session connected to any other database than its own closes the branch; what the role owns there (a large object) is dropped with it, `DROP OWNED` in each database `pg_shdepend` names | (same) |
| Disk | Its database's size, measured once a minute and every round past 80% of its limit, past twice production's own database (at least 20 GiB; `databaseSizeLimitMb`) closes the branch. `temp_file_limit` 1 GiB on the role, a superuser's setting it cannot raise, when production may set it | (same) |
| Nothing of production's | No grant on production's database or schema, `NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS`, and no way to lift its connection limit, login or temporary files (`ALTER ROLE CURRENT_USER` cannot change them) | (same) |
| One role and database per branch in the cluster | One name of at most 63 bytes, with a hash of production's database, its schema and the namespace | (same) |

Closing a branch (`closed` in `enforceBranchLimits`) takes its login away and ends its sessions;
its worker stops it with `branchClosureNotice`, and the next open gives it a new login.

What does not hold, and why:

- The time limits are production's, enforced from outside. The role owns its database and may
  change its own defaults (`ALTER ROLE CURRENT_USER SET`, `ALTER DATABASE … SET`, its database's
  connection limit): nothing production relies on.
- `CONNECT` on the cluster's other databases stays `PUBLIC`'s unless revoked there: the role
  reaches them, with what `PUBLIC` holds, until `enforce` closes the branch, 3 s at most. Revoke
  it there too, or restrict `sixb_branch_*` in `pg_hba.conf`.
- Memory settings (`work_mem`, `maintenance_work_mem`, parallel workers) are any session's to SET,
  with no ceiling PostgreSQL enforces for a role, and no view shows another session's settings.
  The time limits bound how long a heavy query lasts.
- The limits act every 3 seconds, and the size every minute until 80% of it: a branch may go
  that much past them. A copy also writes as much WAL as it loads, on production's volume, until
  a checkpoint recycles it.
- A worker that crashes leaves its branches' sessions running, within their login's 15 minutes,
  until the worker backstop closes them.
- `pg_database`, `pg_roles` and `pg_stat_activity` are instance-wide: every user of the instance
  sees each branch's role and database, named after its git branch.
- The branch logs in to production's instance directly, with production's TLS settings. A
  certificate given as a file (`sslrootcert` pointing at a path) does not reach the sandbox, and a
  pooler bound to one user (DigitalOcean's pools) refuses the role: give production a direct
  connection with `sslmode=verify-full` and the system's roots, or `require`.
- Production needs `SET` on `temp_file_limit` for that cap. Managed PostgreSQL's admin user
  (DigitalOcean's `doadmin`) has `CREATEROLE` and `CREATEDB`; a database costs nothing more there.
