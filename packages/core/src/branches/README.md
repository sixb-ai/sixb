# Hosted branches

A git branch of the project, run next to production. Production makes the branch a schema of
its own on production's PostgreSQL instance, owned by a role limited to it; the branch's own
`sixb dev` loads its copy of what its creator reads there, as `sixb dev --from production` does
on a laptop (`copy.ts`, `wire.ts`, `runtime.ts`).

| Where | What |
|---|---|
| `data.ts` | Production's side: the schema made anew for each copy, the role's login and limits |
| `@sixb/pg` `hosted-branches.ts` | The schema and its role |
| `storage/branches` | Each branch's row: what is wanted of it, and what its worker found |

## Production's instance

The rule: the branch's credentials open its own data and nothing else, and nothing the branch does
runs with production's privileges. What can still reach production is its shared capacity:
vacuum, connections and database-wide locks. The limits are set for those.

| Holds | How | Proved by |
|---|---|---|
| The role owns its schema and every table in it | `CREATE SCHEMA … AUTHORIZATION role`; the branch's runtime migrates and loads it, as the role | `pg-hosted-branches.e2e.ts` |
| Production never runs its DDL or migrations in the schema | It only drops it: `ALTER ROLE … NOLOGIN`, ends the role's sessions, `DROP SCHEMA … CASCADE` under a 5 s `lock_timeout`, `DROP OWNED`, `DROP ROLE` | (same) |
| No password in a statement | No password until a runtime starts; then a SCRAM-SHA-256 verifier computed by production, a new one each start, none stored | (same) |
| Connections | `CONNECTION LIMIT` 5 on the role | (same) |
| Vacuum | Every 3 s, from outside: transactions past 30 min end, and sessions idle in a transaction past 60 s; statements past 15 min are cancelled. Long enough for the framework's own work at volume, an index build or a partition move | (same) |
| Locks shared with production | The framework's advisory keys carry their schema, so a branch never waits on production's nor production on a branch's. A branch session holding one of the database-wide keys (production's migrations, the trigram extension's creation) ends at once | (same) |
| Temporary files | `temp_file_limit` 1 GiB on the role, a superuser's setting it cannot raise, when production may set it | (same) |
| Nothing of production's | No grant on production's schema, no `CREATE` on the database, `NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS` | (same) |
| One role per branch in the cluster | Role and schema are one name of at most 63 bytes, with a hash of the database, production's schema and the namespace | (same) |

What does not hold, and why:

- PostgreSQL grants `CONNECT` on every database to `PUBLIC` by default, and a cluster-wide revoke
  is not the project's to make. The role reaches another database of the cluster where `PUBLIC`
  keeps `CONNECT`, and there only what `PUBLIC` holds. Revoke it there, or restrict `sixb_branch_*`
  in `pg_hba.conf`.
- Memory settings (`work_mem`, `maintenance_work_mem`, parallel workers) are any session's to SET,
  with no ceiling PostgreSQL enforces for a role, and no view shows another session's settings.
  The time limits bound how long a heavy query lasts.
- The limits act every 3 seconds: a statement may run up to that much past its limit.
- The advisory keys moved to the schema's: for one deploy, replicas of the old and new versions
  take different keys for the same work.
- The branch logs in to production's instance directly, with production's TLS settings. A
  certificate given as a file (`sslrootcert` pointing at a path) does not reach the sandbox, and a
  pooler bound to one user (DigitalOcean's pools) refuses the role: give production a direct
  connection with `sslmode=verify-full` and the system's roots, or `require`.
- Production needs `CREATEROLE` and the database's `CREATE` (for its own schema), and `SET` on
  `temp_file_limit` for that cap. PostgreSQL 16+.
