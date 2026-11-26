# Snapshots

A snapshot is what one person can read in production at one moment, S: the objects and links of
every type they read, the latest value of each telemetry series, the vectors whose configuration the
target accepts, and the members they may see. A branch starts from one.

```ts
const snapshot = exportSnapshot(hostSnapshotSource(production), { scope })

await writeSnapshotFile(path, snapshot)                          // a laptop downloads this
await importSnapshot({ snapshot, storage: branch, ontology })    // or into a namespace
```

Both sinks read the same bytes: `readSnapshotFile(path)` reads a file back, and
`spoolSnapshot(snapshot, directory)` puts a file between production and a slow consumer, so the
read closes at export speed.

## Export

| Step | Where |
|---|---|
| The applied markings are refreshed, the reader's clearance pinned, its scope read from it | `export.ts` `takeSnapshot` |
| `readSnapshot` opens one consistent read with N views | each provider |
| At S, the versions projections applied are compared with the clearance's; a move retries | `takeSnapshot` |
| Manifest, members, then each type, or each range of a large one, on whichever view is free | `export.ts` |
| Each page: objects, their outgoing links, latest points, vectors | `readSnapshotPage`, `exportPage` |

- **Nothing hidden leaves.** Every page goes through `readSnapshotPage` on the person's
  `AuthorizedObjectReader`: type grants, view conditions (applied by the storage inside each
  statement) and clearance apply as on any read. Links come from the reader's storage, so a link to
  an object a condition hides is not returned; `isLinkViewable` checks the rest.
- **The clearance is S's.** Applied markings may lag the versions projections applied by a few
  seconds. The clearance is built from versions `appliedSources` names; when those differ from the
  ones listed at S, the attempt is dropped before any frame and taken again, three times at most.
- A vector leaves only when every property its profile reads is visible, and when its source
  fingerprint matches the row as read. A telemetry point leaves only where the row holds its value.
- Members: everyone and every group with `can.view(project.users)`, otherwise the person and their
  own groups. Why a member is suspended stays in production.
- Never read: history, runs, threads, activity, sessions, tokens, connections, sources and edits.
- A reader with no condition and no hidden property pays nothing for redaction: rows pass through.
- Keyset pages in primary id order, without totals, never `OFFSET`. The next page is read while
  the current one is encoded, and a page's reads never overlap another's on its view.
- A provider may split a large type into ranges (`readRanges`): PostgreSQL takes bounds from the
  partition's statistics, moved onto objects of the snapshot. A range starts at a page token and
  ends with an object, which the next range starts after. A type seen through a condition stays
  whole: its reader might not see that object.
- The frame queue holds `2 × concurrency` frames, so a slow consumer slows the readers. The
  duration cap (`maxDurationMs`, 30 min by default) wakes and stops them, and the provider closes
  its read only once every view has settled. PostgreSQL bounds the read on the server too:
  `transaction_timeout` on 17 and later, statement and idle timeouts before.

## Format

`format.ts`: an 8-byte signature ending in the format's version, then frames of
`[u32 length][u8 codec][JSON record]`, zstd by default, 512 MB at most: a page that would not fit
is written in halves. Objects are columnar per page. The `end` record counts what the stream holds,
and the importer checks it, so a cut or doubled stream never imports.

The manifest carries each type's definition fingerprints, the properties hidden from the person,
the vector configurations, and the projection feeding the type with the version production
applied. `lake` is left for the lake slice of the same moment. A new record kind, such as a
projection's source rows, comes with the next format version, which this one refuses.

## Import

- Members are written first, in a transaction of their own, and kept by a load taken again.
- `checkTypeFits` compares each type with the branch's definition. A removed type, a changed
  primary or property, or a newly required property skips the type; a removed property or link is
  left out. Everything is reported per type.
- A required property hidden from the person keeps its type: its objects are read and linked, and
  the report lists it (`requiredHiddenPropertyIds`). The base commit records it with who took the
  copy, and a write on the branch that leaves it unset fails with that reason
  (`materializer/effective/withheld.ts`). Only objects nothing wrote since the import name that
  commit, so production never reads it.
- `loadSnapshot` writes one base commit, the kernel operation `ontology.loadSnapshot`, with no
  outbox row: nothing reacts. Its ontology revision is the branch's. It is all or nothing.
- Each object is created by an edit (`create` override), each link by an edge or slot override, so
  later edits on the branch resolve as they do in production.
- Unique values are claimed and marked prepared for properties unique in production too; a
  property only the branch made unique is left to the branch's own preparation, which refuses
  duplicates. Artifact refs are derived from the values. Vectors are kept when the branch's profile
  has the same configuration.
- SQLite and in-memory load in one transaction; SQLite drops the indexes of the tables it fills,
  inserts many rows a statement, builds the indexes again, then runs `ANALYZE`.
- PostgreSQL loads only into a branch namespace, one load at a time (an advisory lock):
  1. one transaction writes the commit and marks the schema `loading` in its comment;
  2. six lanes, a connection and a transaction each, truncate their tables (empty for every
     project), drop their secondary indexes, `COPY … FREEZE` their rows (binary for vectors, into
     each type's partition for objects), build the indexes again and run `ANALYZE`;
  3. the lanes commit in turn, the last one clearing the mark.

  A failure rolls back the open lanes and empties what any committed. A crash between two commits
  leaves the mark, and the namespace refuses to open until it is dropped. Frozen rows are visible
  to all at once, so counts use index-only scans right after the load.

## Projections

A type fed by a projection is exported and imported as created objects. The manifest records its
projection, dataset, whether the person holds `dataset.view` (not whether they read the dataset in
full: column markings decide that), and the version and revisions production applied. A branch
that reads the dataset in place needs them to take the type's source rows over. Until then its
projection cannot run on the branch, and the import report names it.

## Branch namespaces

| Provider | A namespace is |
|---|---|
| PostgreSQL | the schema `<schema>_branch_<name>`, hashed past 63 bytes, its comment naming the branch |
| SQLite | `<path>/branches/<name>/storage.sqlite`, or a database in memory |
| In-memory | an instance of its own |

`branchNamespaces(storage)` refuses a provider without namespaces.
