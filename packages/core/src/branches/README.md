# Hosted branches

A git branch of the project, run next to production. Production makes the branch a database of
its own on production's PostgreSQL instance, owned by a role limited to it; the branch's own
`sixb dev` loads its copy of what its creator reads there, as `sixb dev --from production` does
on a laptop (`copy.ts`, `wire.ts`, `runtime.ts`).

| Where | What |
|---|---|
| `data.ts` | Production's side: the database made anew for each copy, the role's login and limits |
| `@sixb/pg` `hosted-branches.ts` | The database and its role |
| `storage/branches` | Each branch's row: what is wanted of it, and what its worker found |

## Production's instance

The rule: the branch's credentials open its own data and nothing else, and nothing the branch does
runs with production's privileges. A database per branch keeps apart what PostgreSQL scopes to a
database: advisory locks, the vacuum horizon of ordinary tables (PostgreSQL 14+), the statistics
views (`pg_stat_*`, so a branch never reads production's row counts) and large objects. What can
still reach production is the instance's shared capacity: shared catalogs' vacuum, connections,
the lock table and disk. The limits are set for those.

| Holds | How | Proved by |
|---|---|---|
| The role owns its database and every table in it | `CREATE DATABASE … OWNER role`; the branch's runtime migrates and loads it, as the role | `pg-hosted-branches.e2e.ts` |
| No one else connects to it | `REVOKE ALL ON DATABASE … FROM PUBLIC`: only the role, and production through it | (same) |
| Production runs nothing in it but its own extensions | Before the role first logs in, production creates there `pg_trgm` and `vector` when its own database has them, which a branch may not create | (same) |
| Production's own locks | Advisory locks are per database: a branch's keys, production's keys included, never meet production's | (same) |
| A login only while it runs | `NOLOGIN` until `openHostedBranch`, which gives a new password `VALID UNTIL` 15 minutes ahead and ends an earlier runtime's sessions; `enforce` renews it while a worker holds the branch; `closeBranchData` takes it away and ends the sessions once the runtime stops | (same) |
| No password in a statement | A SCRAM-SHA-256 verifier computed by production, a new one each start, none stored | (same) |
| Connections | `CONNECTION LIMIT` 5 on the role | (same) |
| Vacuum of what databases share | Every 3 s, from outside: transactions past 30 min end, and sessions idle in a transaction past 60 s; statements past 15 min are cancelled. A copy's load keeps its waiting lanes busy with a `SELECT 1` | (same) |
| The lock table every database shares | A session holding more than 64 advisory locks (the framework takes a few) closes the branch: 15,000 of them filled the table at the default `max_locks_per_transaction`, and production's new connections failed with "out of shared memory" | (same) |
| Production's sessions never wait on the branch | A branch session in `pg_blocking_pids()` of another role's session closes the branch | (same) |
| Production's other databases | A branch session connected to any other database than its own closes the branch | (same) |
| Disk | Its database's size, measured once a minute, past 20 GiB (`databaseSizeLimitMb`) closes the branch. `temp_file_limit` 1 GiB on the role, a superuser's setting it cannot raise, when production may set it | (same) |
| Nothing of production's | No grant on production's database or schema, `NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS`, and no way to lift its own limits (`ALTER ROLE CURRENT_USER` cannot change them) | (same) |
| One role and database per branch in the cluster | One name of at most 63 bytes, with a hash of production's database, its schema and the namespace | (same) |

Closing a branch (`closed` in `enforceBranchLimits`) takes its login away and ends its sessions;
its worker stops it with `branchClosureNotice`, and the next open gives it a new login.

What does not hold, and why:

- PostgreSQL grants `CONNECT` on every other database to `PUBLIC` by default, and a cluster-wide
  revoke is not the project's to make. The role reaches them, with what `PUBLIC` holds there,
  until `enforce` closes the branch, 3 s at most. A large object it creates there survives
  `DROP OWNED` and keeps `DROP ROLE` failing. Revoke `CONNECT` from `PUBLIC` on the cluster's other
  databases, or restrict `sixb_branch_*` in `pg_hba.conf`.
- Relation locks share the same lock table, and a copy's load holds a few hundred at once (one
  per partition and index). They are not counted: size `max_locks_per_transaction` for production
  and its branches together.
- Memory settings (`work_mem`, `maintenance_work_mem`, parallel workers) are any session's to SET,
  with no ceiling PostgreSQL enforces for a role, and no view shows another session's settings.
  The time limits bound how long a heavy query lasts.
- The limits act every 3 seconds, and the size every minute: a branch may go that much past them.
- The branch logs in to production's instance directly, with production's TLS settings. A
  certificate given as a file (`sslrootcert` pointing at a path) does not reach the sandbox, and a
  pooler bound to one user (DigitalOcean's pools) refuses the role: give production a direct
  connection with `sslmode=verify-full` and the system's roots, or `require`.
- Production needs `CREATEROLE` and `CREATEDB` (`branchHostingRequirement` says so before a worker
  starts), and `SET` on `temp_file_limit` for that cap. PostgreSQL 16+. Managed PostgreSQL's admin
  user (DigitalOcean's `doadmin`) has both; a database costs nothing more there.
