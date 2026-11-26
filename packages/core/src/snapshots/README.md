# Snapshots

A snapshot is what one person can read in production at one moment, S: the objects and links of
every type they read, the latest value of each telemetry series, the vectors whose configuration the
target accepts, and the members they may see. A branch starts from one.

```ts
const snapshot = exportSnapshot(hostSnapshotSource(production), { scope })

await writeSnapshotFile(path, snapshot)     // a laptop downloads this
```

`readSnapshotFile(path)` reads a file back, as the bytes of the stream itself.

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

## Projections

A type fed by a projection is exported as objects. The manifest records its
projection, dataset, whether the person holds `dataset.view` (not whether they read the dataset in
full: column markings decide that), and the version and revisions production applied. A branch
that reads the dataset in place needs them to take the type's source rows over.
