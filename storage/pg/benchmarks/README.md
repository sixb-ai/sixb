# PostgreSQL query benchmark

Synthetic directory objects: users with names, email, phone, status, timestamps and normalized
search text; one city link per user; support accounts/conversations and subscriptions. No production
records or credentials are used. Read fixtures write canonical tables directly. A separate projection benchmark uses the actual
core replacement and publication pipeline. Names and statuses have deliberately frequent values to expose broad
searches and high fanout. Correctness tests separately cover missing/null values and duplicate paths.

## Local environment

From the repository root, create a dedicated PostgreSQL 17 container:

```sh
docker run -d --name sixb-query-bench-pg --cpus=1 --memory=2g --memory-swap=2g \
  --shm-size=512m -e POSTGRES_PASSWORD=local-benchmark-only -e POSTGRES_DB=sixb_query_bench \
  -p 127.0.0.1:55506:5432 postgres:17 \
  -c shared_buffers=512MB -c effective_cache_size=1536MB -c work_mem=8MB \
  -c maintenance_work_mem=128MB -c max_parallel_workers_per_gather=0 \
  -c max_connections=40 -c jit=off
```

The seed scripts refuse other hosts, ports or database names. They grow the fixture without
truncating it; use independent schemas for independent sizes. Set `QUERY_BENCH_SCHEMA` to
`bench_300000`, `bench_1000000`, or `bench` (5M) for every stage and measurement. Each stage is idempotent.
Run each stage to completion before the next; do not run other DDL during concurrent index builds.

```sh
mkdir -p .local/query-bench
bun storage/pg/benchmarks/seed-query.ts 300000
bun storage/pg/benchmarks/seed-traversal.ts
bun storage/pg/benchmarks/prepare-query.ts # explicit maintenance, including offline rewrite
```

Repeat with `1000000` and `5000000`. The latter has 5M users, 100 cities, 500k support accounts,
125k conversations, 1M subscriptions, and 7M links. The storage budget includes all indexes; inspect
the report's relation sizes as well as the PostgreSQL data volume and WAL before extrapolating.

Run the client separately with the VPS resource envelope:

```sh
docker run --rm --cpus=2 --memory=4g --memory-swap=4g \
  -v "$PWD:/work" -w /work \
  -e QUERY_BENCH_URL=postgresql://postgres:local-benchmark-only@host.docker.internal:55506/sixb_query_bench \
  -e QUERY_BENCH_REPEATS=10 \
  oven/bun:1.4.2 bun storage/pg/benchmarks/measure-framework-query.ts
```

On Linux add `--add-host=host.docker.internal:host-gateway`. Results go to
`.local/query-bench/<label>-<user count>.json`: raw timings, median, p95, returned IDs/counts,
`EXPLAIN (ANALYZE, BUFFERS)` plans, PostgreSQL settings and relation sizes. Ten samples give a useful
local tail indicator, not a production latency SLO. `QUERY_BENCH_CASES` accepts comma-separated
case names for focused iterations.

The complete screen runs its list and four exact counters concurrently against a five-connection
pool. List queries include the `currentCity` expansion. Traversals cover outgoing city, incoming
city residents with sort/page/count, user → support account → conversation, incoming subscriptions,
and the date-filtered partner-report selection, both with and without its exact total. A cursor at 90% of the recent-user ordering checks
deep-page behavior. Search cases include rare, absent, common, two-character, multi-term and phone
queries.

For an exact compiler comparison against PR #706, retain its compiler locally:

```sh
git show e4d3e6a4fae9b5e9d89a6d85d0f06ed88f24a319:storage/pg/src/objects/query-compiler.ts \
  > .local/query-bench/baseline-compiler.ts
```

Pass `-e QUERY_BENCH_BASELINE=/work/.local/query-bench/baseline-compiler.ts` to the same client
command with label `baseline`. Run serially on identical data. Keeping the new indexes for this
comparison favors the old compiler; separately record a run before adding workload indexes to
measure the full change. Compare returned IDs/counts, not just timings.

These containers reproduce CPU quotas and memory capacity, not DigitalOcean's CPU speed, storage
IOPS, network latency or managed-service configuration. The client measures the PostgreSQL query
boundary; it is not a browser/HTTP/auth benchmark. Redis and S3 are outside this read path. Cache
state matters: the first timing and subsequent timings are retained separately; a container restart
clears PostgreSQL shared buffers but does not reliably clear the host filesystem cache.

After read measurements finish, `bun storage/pg/benchmarks/measure-writes.ts` measures database
write amplification for base indexes, workload indexes, and prepared text counts. It copies 50k
users from `bench_300000`, measures five 1k-row insert/update batches, then drops only its three
fixed `bench_write_*` scratch schemas. Run it in the same constrained client container. This isolates
index maintenance cost; it is not a projection pipeline throughput benchmark. Do not run it during
latency measurements.

`measure-concurrency.ts` drives the actual `PostgresStorage` reader with five simultaneous screens,
three bursts, including expansions and four exact counters. Run separately for `bench_300000` and
`bench`; `QUERY_BENCH_POOL` controls the pool size (default 10). Compare 1, 2 and 10 on a one-CPU
database: excessive concurrent count scans can reduce throughput as well as increase latency.
These synchronized bursts are a stress test, not a model of typical human request timing.

## SDK and coherent summary measurements

`measure-framework-query.ts` executes the fluent SDK, core normalization/planning and PostgreSQL
reader. It records `.local/query-bench/framework-<schema>-pool<max>.json`: first call, individual
samples, p50/p95, complete answers, deep cursor pages, city expansion, two-hop support, incoming
subscriptions and a filtered city report with and without its total. Authorization is explicitly
disabled by the testing binding; this is not HTTP/browser latency. Read-scope correctness has its
own regression tests.

The screen workload loads its page and one `{total, facets}` summary. Five screens start together,
for three bursts. Every summary executes SQL, including repeated identical searches; no maintained
counters or aggregate result cache are used. Separate first-call and repeated-call measurements
to show ordinary PostgreSQL buffer and filesystem cache effects. `QUERY_BENCH_POOL` defaults
to 2 for the one-CPU database; `QUERY_BENCH_REPEATS` defaults to 10.

Run `measure-mixed.ts` in the same constrained client after read tests. It saves 100 synthetic
rows locally, updates two disjoint groups concurrently, then opens five screens against the updated
data. It checks totals and each bucket, repeats three times, and restores the saved rows in
`finally`. The backup allows recovery if the process is interrupted. Output is `mixed-<schema>.json`.
These are database writes against the large fixture; projection costs are measured separately.

`measure-projections.ts` compares current base storage with prepared queries in its two dedicated
scratch schemas. It uses `replaceProjection` and `finishProjection`: an initial 10k-user publication
and three 1k-user deltas, validating total and buckets after every commit. Set
`QUERY_BENCH_WRITE_ROWS` to increase the initial size. It drops only its own scratch schemas.
The baseline restores the generic JSON GIN, while both modes use the current projection engine. It is a controlled preparation-overhead comparison, not an
exact checkout of the old PR. `QUERY_BENCH_PROFILE=1` optionally requires `pg_stat_statements` in
`public` and resets that dedicated database's statistics before each mode.

Run benchmarks serially, without preparation, test-suite or profiling activity on the benchmark
server. The earlier `measure-query.ts`, `index-query.ts`, `prepare-text-counts.ts` and
`measure-concurrency.ts` retain the first investigation's lower-level comparison protocol; they
are not the full SDK path and do not include the coherent summary workload.

The SDK script also starts five **different** searches together. Those aggregates cannot
share results. Report their page completion separately from the final counter; a one-CPU database
still performs their cumulative scan work. Admission defaults to one count/facet calculation
per storage instance, leaving the second connection available for pages.
