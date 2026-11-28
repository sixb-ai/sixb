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
and the importer checks it, with nothing after it, before the provider commits: a cut, doubled or
extended stream never imports.

The manifest carries each type's primary property and shape, the properties hidden from the
person, the vector configurations, and the projection feeding the type with the version
production applied, and `lake.catalogVersion`, the lake point the branch's slice was cut at.
Version 2 adds a projection's source roots and the edits over its type. Version 3 replaces the
definition fingerprints with the shape production's objects fit (`ontology/type-shapes.ts`): the
row production recorded, read at S with the migrations it settled, or its code's, `unrecorded`,
when it recorded none. `withheld` names the keys production's objects hold that its code no
longer declares, and only that: no value travels, their markings gone with their definition,
and no count, which could tell what a marking or a condition hid. They are found before the
consistent read opens, so no view waits on the scan; a commit refuses an undeclared key, so none
appears meanwhile. A recorded shape names the candidates, each probed; a type never recorded is
scanned for its keys alone (`listHeldPropertyKeys`, one SQL pass). A reader takes
versions 2 and 3, and refuses any other.

## Lake slice

With `lake: { path, branch, onSlice }`, the export cuts the person's lake slice too
(`datasets/lake-slices.ts`). The lake's point is taken inside the consistent read, right after
S: every version an object was derived from was committed before the read began, so the point is
at or after it, and a commit landing meanwhile is in neither. The cut runs beside the type reads;
`onSlice` receives the slice and its first token before the `end` record. A snapshot that fails
deletes its slice, which would otherwise hold production's files for two weeks, and so does a cut
whose token cannot be issued. Once the stream has ended, the export is done: an import that fails
then deletes the slice through its caller (`dropLakeSlice`).

## Import

- Members are written first, in a transaction of their own, and kept by a load taken again.
- **The branch decides as a deploy would, on the copy's data.**

  | Step | What |
  |---|---|
  | Before the load | `checkTypeFits` (`definitions.ts`) runs the gate's `classifyTypeChanges` on production's shape and the branch's code and migrations. Only what can't be stored skips the type: a removed type, a changed primary, a type production was migrating, conflicting steps. A removal nothing migrates is left out of the objects; the keys and links a pending step moves load, so the step runs |
  | The load | Counts the objects that held each left-out key, and those of a removed type or a changed primary: the gate's own finding, a deploy would refuse it (`refusedByDeploy`, a skip's `findings`). A withheld key is said to be held, with no count; through a view condition it is listed as not checked, since only hidden objects may hold it |
  | After it | Production's shapes and settled migrations are recorded (not for an `unrecorded` type, nor a version 2 snapshot: the gate's baseline pass reads the copy, as a first deploy does). Then `checkTypeShapes` in `check` mode, with the unique dry run worded as findings (`uniqueDuplicates`, so `applyTypeShapes` doesn't run it again), and hidden and withheld properties `unseen`: the copy holds none of their values, so their changes are listed as not checked (`unchecked`). The properties a projection feeds on a type copied as created objects are `unseenValues` (see Projections) |
  | A type it refuses | `unloadSnapshot` empties the load, as a failed one is emptied, only while its commit is the project's only one, and the copy loads again from `snapshot()` without it, skipped (`unfit`) with the gate's lines and counts. The second read must be the same copy (`takenAt`) and refuse nothing more. Only this path reads the copy twice |
  | Then | `applyTypeShapes`, as a deploy after its checks: the run, unique values, the shapes. A fill or a convert whose plan refuses objects (`ValuePlanError`) wrote nothing: its types are refused with the plan's lines, and the copy loads again without them |

  Hidden properties and objects a condition hides are listed per type: the migrations never saw
  them. A version 2 snapshot has no shapes: every key loads, so a pending rename still finds the
  old key, and a type its data doesn't fit is refused like any other.
- A required property hidden from the person keeps its type: its objects and their links travel
  and read normally, and the report lists it (`requiredHiddenPropertyIds`). Any write to one of
  those objects, a new link included, fails while the property is unset, and says why; a delete
  works. The branch's fills and converts check those objects without it. The base commit records
  the property and who took the copy (`materializer/effective/withheld.ts`). Only objects nothing
  wrote since the import name that commit, so production never reads it.
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

A type a projection feeds travels as its projection's source when a branch can continue it:

| Condition | Checked |
|---|---|
| The export cuts a lake slice, so the branch reads the dataset in place | `travellingSources` |
| The projection applied a version, and no other projection of the dataset applied another | " |
| The person reads every object and property of the type: the edits over it hide nothing | " |
| No link projection feeds links from the type: their source does not travel, so the branch could not tell them from the type's own | " |
| The person reads the dataset in full at that version (`readsVersionInFull`, the slice's rule) | " |
| The slice holds the dataset at that version (`pinned`), or the export fails | `cutLakeSlice` |
| The branch's projection of the same id still feeds the type from that dataset, and the branch drops none of its properties or links | `import.ts` `sourceTravel` |

Then the manifest carries the active source's identity (version, revisions), and the stream its
live roots (`sourceRoots`, in root key order) and the edits over the type and the links from it
(`edits`), each paged by key inside the consistent read. Every edit over an object travels, a
masked one (superseded under `mostRecent`) included. A link edit travels as the link would: the
person reads links of its definition (`readsLink`) and the object it reaches, which was exported
or belongs to a type that travels as its source, whose roots hold even objects an edit deleted.
A cleared slot's anchor is such an object too, or the clear stays in production. The import writes the source as active as of the base commit, its roots and
assertions, the objects without a creating edit, their links without one, and production's edits
as they are. The branch's projection then reads the changes from that version to the branch's
(`prepareIncrementalReplacement`) and updates only what changed; when its revisions differ from
production's, it reads the dataset in full, as anywhere.

Otherwise the type travels as created objects, and the manifest and the import report say why
(`notReprojectable`): its projection cannot update them on the branch.

Each object is then one `create` edit, which flattens the projection's values into edits. A deploy
reads only edits for a value's fit and for a missing required value, and leaves the projection's
values to the projection. So the properties production's projection feeds (`propertyIds`, from its
definition; for an older snapshot, the branch's projection of the same id, or else every property
but the primary), and those the branch's projections feed, are `unseenValues`: a change of their
values or of whether they are required is listed as not checked, never refused. Their keys are
still read: a removal or a rename is decided and runs as for any property.

The branch's fills and converts still run on them, so the copy fits its code where they can: an
object one of them fails on keeps its value, and is listed as not checked too (`onUncheckedValue`).
A value the branch's schema refuses with no convert declared stays as it is: a write to its object
fails on the branch until a convert exists, and a required one nothing fills stays missing. The
limit: a real edit production holds over one of those values is flattened like the rest, so the
branch can't check it either.

## Branch namespaces

| Provider | A namespace is |
|---|---|
| PostgreSQL | the schema `<schema>_branch_<name>`, hashed past 63 bytes, its comment naming the branch |
| SQLite | `<path>/branches/<name>/storage.sqlite`, or a database in memory |
| In-memory | an instance of its own |

`branchNamespaces(storage)` refuses a provider without namespaces.
