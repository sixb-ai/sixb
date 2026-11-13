# Artifacts

An artifact is a piece of finished work your project keeps: a report, a chart, a file someone
needs. Changes go to its current version until someone creates a version, which then never changes.
Each artifact has a page in your app where its owner reads it.

## Kinds

| Kind       | What it holds                                                           |
| ---------- | ----------------------------------------------------------------------- |
| `document` | A Markdown report in `document.md`, or designed HTML in `document.html` |
| `sheet`    | Tables of data, one CSV per sheet, with typed columns and their charts  |
| `slides`   | A deck: `index.html` with one `<section class="slide">` per slide       |
| `page`     | A web page: `index.html` and its scripts, styles, images, and data      |
| `canvas`   | An endless board of boards, sections, notes, shapes, and arrows         |
| `file`     | One file, shown as its type allows or offered for download              |

## Publish an artifact

Store the files first, then publish them under their paths in the artifact:

File: `actions/publishQuarterlyReview.ts`

```ts
const markdown = await sixb.blobs.put({
  body: new TextEncoder().encode(report),
  fileName: "document.md",
  mediaType: "text/markdown",
})
const chart = await sixb.blobs.put({ body: png, fileName: "revenue.png", mediaType: "image/png" })

const { artifact } = await sixb.artifacts.create({
  kind: "document",
  title: "Q3 operating review",
  files: [
    { path: "document.md", file: markdown },
    { path: "figures/revenue.png", file: chart },
  ],
})
```

`sixb.artifacts.update(artifact.id, input)` replaces the current version's content. An update
checks the whole version first: a document's images must be files in that version or another
artifact's address, so it reads the same wherever it opens.

Pass `baseRevision`, the revision your change was made from, when someone else may change it in
between. If it changed since, the update fails with `artifact_moved` (409 over HTTP), naming the
revision and who last wrote it, rather than replace changes you never saw:

```ts
await sixb.artifacts.update(artifact.id, { ...input, baseRevision: artifact.revision })
```

A canvas is edited by several people at once, so an update to one is merged instead. Your changes
since `baseRevision` are applied, item by item and line by line, to what it holds now, and the
result says `merged: true`. Where you and someone else set the same value, such as an item's
position, yours wins; words you both typed in the same text are both kept. A canvas still fails
with `artifact_moved` when Sixb no longer holds the files of `baseRevision`.

From outside the server, use `POST /api/artifacts` and `PUT /api/artifacts/{artifactId}/content`
with files uploaded through `POST /api/files`.

## Versions and restore points

- The latest version is **open**: each update, from your code, the Agent, or a save in the app,
  replaces it.
- **Creating a version** freezes it: it never changes again, and the next change opens the next
  one. Creating it twice changes nothing.
- Every change counts in the artifact's `revision`, which only grows. Content read at one revision
  stays that revision's.
- Before an Agent turn's first change to an artifact, and before each restore, the artifact keeps a
  **restore point** of what it held: its last 20. Restoring one writes it back as a change, which
  can itself be restored.

| To | SDK | HTTP |
| --- | --- | --- |
| Create a version | `sixb.artifacts.freeze(id)` | `POST /api/artifacts/{id}/freeze` |
| List restore points | `sixb.artifacts.listRestorePoints(id)` | `GET /api/artifacts/{id}/restore-points` |
| Restore one | `sixb.artifacts.restore(id, revision)` | `POST /api/artifacts/{id}/restore-points/{revision}/restore` |

Whoever may change an artifact may create its versions and restore it; the Agent does neither.
Each change sends `artifact.updated` to whoever reads the artifact, over the
[events websocket](../websockets/overview.md).

## The Agent publishes

In a conversation, the Agent publishes what you ask it to make, such as a report, a brief, a table
of data, or a file in a format you name, as an artifact. Each new artifact gets a card under the
reply. The first one a reply publishes opens beside the conversation as soon as it is published,
while the Agent is still working; on a phone, where it would open over the conversation, it waits
on its card instead.

Ask for a change and the Agent updates the same artifact: its current version, until you create
one. The reply shows it as a line with what changed, such as a sheet or section added, and the
version menu keeps the versions you created. **Restore** in the version menu puts back what the
artifact held before one of the Agent's turns, or before a restore, once you confirm. The
conversation's header lists every artifact it published.

A cancelled reply keeps what it already published. Retrying a reply that failed takes back what it
changed, along with what it said: an artifact only the reply changed goes back to its restore
point, and one it created is removed. One anyone else changed meanwhile, even between two of the
reply's writes, or whose version someone created, keeps every change. One it created that someone
else commented on stays too, with its comments.

The Agent learns the formats from a built-in skill, `sixb-artifacts`.

A file one of your tools returns stays with that tool's step in the conversation. The Agent
publishes it when it is what you asked for.

## Edit in the app

A Markdown document is typed into as it opens, like a page of notes: whoever may change it clicks
and types, with no **Edit** to press. Sheets, canvases, and
[designed documents](#design-a-document) are edited where they open: press **Edit** on the latest
version.

A sheet is edited as a draft. The header becomes a draft bar with Undo, Redo, Discard, and
**Save**. Saving replaces the current version with your draft; **Create version** keeps it as a
numbered version in the version menu. ⌘S saves, and leaving with changes asks first. If someone
changed the sheet while you were editing, the save stops and says so: open what they saved, or save
yours over it.

A document or a canvas is edited live, with everyone who has it open: there is no draft to save.
Your changes are saved as you make them, and everyone's are merged. See [Edit live](#edit-live).

| In a Markdown document | |
| --- | --- |
| Write | Click anywhere and type. `#`, `-`, `1.`, `[]`, `>`, ` ``` ` and `---` at the start of a line make a heading, a list, a to-do, a quote, code, or a divider |
| `/` | On any line: text, headings, lists, to-dos, a quote, a callout, a warning, code, a table, an image, a divider, found by typing their name |
| Blocks | The handle beside a block adds one below, drags it, and turns it into another kind, duplicates, moves, or deletes it; ⌘D duplicates, ⌥⇧↑ and ⌥⇧↓ move |
| Words | Select them for bold, italic, strikethrough, code, or a link (⌘K); ⌘Z and ⇧⌘Z undo and redo your own changes |
| Images | Paste, drop, or choose one from `/`: it is added to the document under `images/`; type its caption under it |
| Paste | Markdown pasted as text becomes its blocks; what you copy is Markdown |
| Together | Everyone editing sees the others' carets and selections, named, in their colors |

It reads as it always did: its first heading is the title and the paragraph after it the lede, in
one centered column, with embedded artifacts in place. What it does not edit, front matter, a
footnote, raw HTML, or a list mixing to-dos and plain items, is kept as written. Once someone
edits it, `document.md` is written as the editor writes Markdown (`-` bullets, `*emphasis*`, `#`
headings), and an Agent's later changes merge with theirs whichever way it writes them.

| In a sheet | |
| --- | --- |
| Cells | Type on a cell, or press Enter, F2, or double-click: Enter and Tab commit, Esc puts it back. Values are read in your locale: `12%`, `$1,200`, `23/11/2026`, `4.5M` |
| Rows | Insert above or below and delete from a row's menu; ⌘D fills down; a paste grows the sheet |
| Columns | Insert, rename, delete, and set the type, format, total, description, or formula from a column's menu |
| Undo | ⌘Z and ⇧⌘Z, every change in the draft |

| In a canvas | |
| --- | --- |
| Items | Drag to move, snapped to 8 pixels; resize from the handles; Delete removes; ⌘D duplicates; the arrows nudge |
| Add | A note, text, shape, or section from the toolbar; double-click or Enter to type in one |
| Arrows | Drag from the dot on an item's side to another item; the toolbar sets a line's style and label |
| Style | A note's or a shape's color, a text's size, a shape's form, for everything selected |

| In a designed document | |
| --- | --- |
| Words | Click a heading, a paragraph, a list item, or a table cell and type: bold and links around the rest stay. Enter and Esc leave it |
| Layout | Stays as its HTML and CSS say: nothing is added, moved, or removed. Ask the Agent for those |
| View | One sheet while you edit; its pages again once your words are saved |

On the canvas you arrange the boards, and the Agent writes what they show. The next time the Agent
works on the artifact, it starts from the latest version and keeps your changes.

## Edit live

A document, Markdown or designed, or a canvas is edited by everyone at once over `/ws/artifacts`.
Each person sees the others' changes as they make them, and who else is there.

- Whoever may change the artifact edits it; whoever may only read it watches.
- Changes are written to the current version about 1.5 seconds after the last one, at most every
  10 seconds while someone keeps editing, and when the last editor leaves. Each write is a normal
  change, by the last person who edited, and sends `artifact.updated`.
- What the Agent or anyone else publishes meanwhile is merged into what people are editing, and
  their unsaved changes stay. While an Agent turn changes boards, everyone sees which ones.
- Everyone sees the others' changes and presence at once, whichever server they are connected
  to. Someone who reconnects after editing offline gets their changes merged in.
- A write that fails is reported and tried again, for as long as the server runs; the changes stay
  meanwhile. Changes the server could never save, because it stopped first, are reported to
  [`onError`](../logging/overview.md#report-failures) as `artifact.live_write.failed`.

`@sixb/core/artifacts/live` holds the document and the socket's messages for a client to build
on, `@sixb/core/artifacts/live/protocol` the messages alone, without Yjs, and
`@sixb/client/artifact-live` the socket. The [WebSockets](../websockets/overview.md#live-artifacts)
page lists the messages.

### Edit what a page shows

A canvas's boards and a designed document are edited the same way. A board's HTML stays yours to
write. What its source holds can also be changed in place: words,
pictures, and inline styles.

- Each element in a board's source has an address, its path from the `<body>`, such as
  `body>main:0>h1:0`. What a script builds, such as a chart drawn from live data, has none and
  can't be edited in place.
- An element can be a block of text, which you type into, keeping the bold or the link around the
  rest. It can also be an image, whose picture and description change, or anything else.
- Every element takes `color`, `background`, `background-color`, `font-size`, `font-weight`,
  `text-align`, `padding`, `gap` and `border-radius` in its inline style.
- Edits go to everyone editing the canvas at once, and merge with what the Agent writes.

| `@sixb/core/artifacts/live` | |
| --- | --- |
| `boardElements(source)` | Every static element: its address, kind, source range, and first words |
| `setBoardText`, `setBoardImage`, `setBoardStyle` | An edit, as changes to the source |
| `mergeBoardText(source, address, base, typed)` | Typed words, merged with changes since `base` |
| `applyBoardEditToText(text, edit)` | Makes it in the board's `Y.Text` |
| `boardFramePatches(before, after)` | What a frame showing `before` patches to show `after` |

A board's frame link, or a designed document's, serves it for editing with `?sixb-edit`. The frame's `edit` request then
turns editing on, and takes `edit.patch`. With `typing: false`, picking an element types nothing
into it, as when the reader picks what to comment on.

- Transfer a `MessagePort` with the first `edit` request after the frame loads. The frame reports
  `edit.hover`, `edit.select` (with where the reader clicked) and `edit.text` through that port
  alone, and `zoom`: a pinch, ⌘-scroll, or ⌘ +, − and 0 over the page, which the browser then
  doesn't zoom. A frame with no port leaves zooming to the browser.
- The board's scripts can't post on the port: the frame takes it before they run, and they never
  see the request that hands it over. The frame reports only the reader's own clicks and keys.
- They can still rewrite what an element holds, so take `edit.text` only for the element the
  reader picked, and stop taking it once `boardFramePatches` returns null.

## Comment on an artifact

Whoever reads an artifact reads its comments and adds their own. A comment on a canvas can be about
a board, or an element of one. Its author, or anyone who may change the artifact, resolves or
deletes it. Replies go one level deep. A copy of the artifact, such as a forked conversation's,
keeps no comments.

```ts
const comment = await sixb.artifacts.addComment(artifact.id, {
  body: "Make the title warmer.",
  anchor: { board: "welcome", element: "body>main:0>h1:0", label: "Welcome back" },
})
await sixb.artifacts.addComment(artifact.id, { body: "Done.", parentId: comment.id })
await sixb.artifacts.resolveComment(artifact.id, comment.id)
```

| To | HTTP |
| --- | --- |
| List | `GET /api/artifacts/{id}/comments` |
| Add, or reply | `POST /api/artifacts/{id}/comments` |
| Resolve, or open again | `POST /api/artifacts/{id}/comments/{commentId}/resolve` |
| Delete, with its replies | `DELETE /api/artifacts/{id}/comments/{commentId}` |

- An anchor records the revision its author saw, and the element's first words. These still name
  the element once it is gone. Its `point` places the comment's pin on the board, as fractions of
  the board's width and height.
- Each comment names its author in `authorName`, as their profile does, or `null` for someone the
  project no longer knows. One the Agent wrote for its author has `origin`, its run and
  conversation.
- A visitor of a [shared link](../auth/shared-access.md#share-an-objects-artifacts) to an object
  that holds the artifact comments as a guest: `author.type` is `guest` and `authorName` the name
  they gave. Only someone who may change the artifact resolves or deletes a guest's comment.
- Each change sends `artifact.commented` to whoever reads the artifact.
- An artifact holds at most 1,000 comments, each up to 4,000 characters; guests write at most 200
  of them.
- `quoteArtifactComment(comment)` from `@sixb/core/artifacts` writes a comment as the Agent reads
  it, with where it is and its id, for a message that asks the Agent to act on it. The Agent then
  resolves each comment it addressed, and replies to the ones it can't, with
  `sixb artifacts comments`.

## Write a document

A document is Markdown with tables, footnotes, and task lists. A few conventions shape its page:

- The first `#` heading is the title, and the paragraph after it is the lede.
- `## ` and `### ` headings are its sections, which a link can open at.
- A quote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`
  becomes a callout.
- An image with a title alone in its paragraph becomes a figure, and the title becomes its
  caption: `![Revenue by region](figures/revenue.png "Revenue by region, Q3")`.
- Table columns of figures align right.

### Design a document

When a document should look like your business's own, such as a proposal, a contract, or a letter,
write it as HTML in `document.html` with its own stylesheets, fonts, and images beside it. It
renders exactly as they say, on white paper. An `@page` rule with a size gives it pages:

```text
proposal/
├── document.html
├── design.css        @page { size: letter; margin: 0.75in 0.85in; }
├── fonts/brand.woff2
└── images/logo.svg
```

- It shows as the pages it prints on. On a phone, where those would be too small to read, it is one
  sheet whose text wraps to the screen, with a gap where each page breaks.
- Pages break where its CSS says: `break-before: page` starts a new page, and `break-inside: avoid`
  keeps a block whole.
- It may hold any markup that lays out text, tables, figures, and pictures, styled by any CSS.
  Nothing in it runs: publishing refuses scripts, `on…` handlers, `<iframe>`, `<form>`, and
  `<base>`.
- Its images are files in the artifact or another artifact's, and its stylesheets are files in the
  artifact or on a CDN such as Google Fonts.
- Its headings form its outline and the sections an address names, as a Markdown document's do.
- Its words are [edited in place](#edit-in-the-app) in the app, live, by everyone at once.
- A version holds everything it shows: to share a design between documents, keep it in a
  [skill](../models/tools-and-authorization.md#add-a-skill) and copy its files into each one.

### Show live data in a document

A designed document an object [holds](#hold-an-artifact-in-an-object), such as a contract's
proposal, shows that object's values and its [queries'](#declare-a-query) rows as each reader reads
them. Name the object's type, then mark each value, with the text it shows until it is read:

```html
<head><meta name="sixb:object-type" content="Contract"></head>
<h1 data-sixb-field="client.name">Example Landscaping</h1>
<span data-sixb-field="fee" data-format="money" data-currency-field="currency">$4,000</span>
<tr data-sixb-each="query:past-work">
  <td data-sixb-field="title">Phase 1</td>
  <td data-sixb-field="signedAt" data-format="date">March 2, 2026</td>
</tr>
```

| Markup | Shows |
| --- | --- |
| `data-sixb-field="number"` | A property of the object that holds it |
| `data-sixb-field="client.name"` | A property of what one of its links reaches |
| `data-sixb-field="scope.services[job-flow].amount"` | A list's item, by its `id` |
| `data-sixb-each="milestones"` | The element once per item of a list or a link; fields inside read the item |
| `data-sixb-each="query:past-work"` | The element once per row of `queries/past-work.json` |
| `data-sixb-field="query:past-work.total"` | How many rows the query matched |
| `data-sixb-each="query:by-status.facets.status"` | The element once per facet value; fields `value` and `count` |
| `data-format="money"`, `number`, `percent`, `date` | Formatted for `<html lang>`; `money` takes `data-currency="USD"` or `data-currency-field` |

- The object is the one of that type that holds the document, as the reader reads it. When none
  does, as with a template, or several do, its fields keep their written text, and so does
  anything the reader can't read. A value they are not cleared for shows `•••`.
- A query can start from that object: `{ "kind": "traverse", "input": { "kind": "holder" }, … }`.
- Values update as the objects change. While its words are edited in place, it shows the written
  text, and fields take no typing.
- Publishing warns `field_unknown` for a field that reads nothing the type holds, and refuses a
  document whose author can't read the type.
- [Creating a version](#versions-and-restore-points) writes the values in, as whoever creates it
  reads them, and leaves plain HTML: everyone who reads that version sees those values, including
  ones they could not read live. Its PDF shows the values whoever asks reads.
- Fields can't go on `<style>`, `<title>`, `<textarea>` and other elements whose text isn't markup.
- `sixb.artifacts.query(id, "holder")` reads the object, with what the links its fields read
  through reach.
- A document computes nothing: a total or an instalment is a property the object keeps.

### Print a document to PDF

A designed document downloads as a PDF: **Download** › **PDF** in the app. It prints in Chromium,
on the paper its `@page` rule sets, with its backgrounds, once its fonts and images have loaded.
Its `document.html` is not offered: without its stylesheets and pictures, it would not look like
the document.

```ts
const pdf = await sixb.artifacts.pdf(artifactId) // { status: "printing" }, then:
// { status: "ready", file: FileRef, pages: 6 }
```

- The first ask prints it, which takes a few seconds: ask again until it is `ready`. Over HTTP,
  `POST /api/artifacts/{id}/versions/{version}/pdf` answers the same, and `GET` on the same path
  downloads it.
- The [`render` worker](../cli/overview.md) prints it in a sandbox of the project, whose image needs
  Node.js and Playwright's Chromium, as the Sixb agent image has. `sixb dev` and
  `sixb worker-group` start the worker when the project has a sandbox provider. A sandbox without a
  browser is a failure that says so.
- A PDF is kept for what the version prints: a version restored or frozen as it was finds it, and
  a change to any of its files prints it anew.
- When it could not be printed, asking answers `{ status: "failed", reason }` until you ask with
  `{ retry: true }` (`?retry=true` over HTTP), which prints it again.
- A project without a [sandbox provider](../sandboxes/overview.md) prints nothing: asking fails
  with `pdf_unavailable`, and the app offers no download.
- Write the rules a phone lays it out by as `@media screen and (max-width: …)`: paper as narrow as A5
  would match a rule without `screen` when printed.

## Write a sheet

A sheet is `workbook.json` and one CSV per sheet under `sheets/`. The CSV holds raw values; the
workbook says how to read them:

```json
{
  "sheets": [
    {
      "name": "Regions",
      "frozenColumns": 1,
      "columns": {
        "Visits": "number",
        "Within SLA": { "type": "percent", "decimals": 1 },
        "Change": { "type": "percent", "decimals": 1, "signed": true },
        "Parts cost": { "type": "currency", "compact": true }
      },
      "descriptions": { "Within SLA": "Priority calls restored inside the agreed time." },
      "totals": { "Visits": "sum", "Within SLA": "average", "Parts cost": "sum" }
    }
  ],
  "charts": [{ "name": "sla", "type": "bar", "sheet": "Regions", "x": "Region", "y": "Within SLA" }]
}
```

```text
sheets/Regions.csv
Region,Visits,Within SLA,Change,Parts cost
North,1284,0.961,0.042,182400
Central,962,0.934,-0.013,141950
```

- A column is `text` unless the workbook gives it a type: `number`, `currency`, `percent` (written
  as a fraction, `0.961`), `date` (`2026-09-30`), `link` (a full `https://` or `http://` address),
  `image` (the path of an image file in the artifact), `boolean` (`true` or `false`, shown as a
  checkbox), or `tag` (a label shown as a chip, colored by `tones`: `positive`, `warning`,
  `negative`, `neutral`, or `chart-1` to `chart-5`).
- `highlight` shades a numeric column by value across the whole column: `bars`, a `scale` from
  light to dark, or `diverging` colors either side of zero.
- Values are formatted in the reader's locale, so write them without symbols or separators.
  `compact` shows a number or currency as `$182K` or `1.2M`; `signed` puts `+` on positive
  numbers, currencies, and percents.
- `totals` pins a row under the sheet with a column's `sum`, `average`, `min`, `max`, or `count`
  of the rows the reader sees, so a filter changes it; the first column without a total says
  "Total". Leave total rows out of the CSV. `descriptions` explain a column on its header, in at
  most 300 characters.
- A column with a `formula` computes each row from the others, as an Excel table's columns do:
  `"Margin": { "type": "percent", "formula": "([@Revenue]-[@Cost])/[@Revenue]" }`. `[@Name]` is
  this row's value, `[Name]` the whole column inside `SUM`, `AVERAGE`, `MIN`, `MAX`, or `COUNT`, and
  `IF`, `IFERROR`, `AND`, `OR`, `NOT`, `ISBLANK`, `ROUND`, `ABS`, `LEN`, `LOWER`, `UPPER`,
  `CONCAT`, `YEAR`, `MONTH`, and `DAYS` are there too. The CSV names the column and leaves its
  values empty. Publishing refuses a formula naming a column the sheet lacks, columns that compute
  from each other, and a result the column's type can't show, and warns of rows that compute to
  `#DIV/0!` or `#VALUE!`. The `.xlsx` keeps each cell's formula.
- `frozenRows` (default 1, the header) and `frozenColumns` (default 0) stay in view while the
  sheet scrolls; `widths` sets columns' widths in pixels.
- A chart is a `bar`, `line`, `area`, `pie`, or `scatter` chart of up to five `y` columns against
  an `x` column. Its `name` is its address, so keep it across versions and rename it by its
  `title`. Bar and area charts can be `stacked`; a pie has one `y` column and at most five rows.
  A bar chart's `line` columns draw over its bars, on a right axis when their type differs; a
  scatter places a point per row by two numbers; and `aggregate` charts raw rows by their `x`
  value: the `sum` or `average` of `y`, or the `count` of rows.

Publishing reads every typed cell and every chart against its sheet and refuses the version with
the file, row, and column to fix. A sheet holds at most 200 columns and 100,000 rows, and a
workbook 20 sheets and 10 charts.

A sheet opens as a workbook: the name box and the active cell's value above the grid, where typing
a cell or range such as `B4` or `A1:D12` in the name box goes there, and the sheet tabs with the
selection's figures below it. Each column's menu sorts by it, filters it, fits it to its values, freezes the columns up to it, or
hides it; these arrange the reader's view and change nothing in the artifact. A text or link column
filters by a checklist of its values, a number or date column by a condition such as greater than
or between, and the status bar counts the rows the filters keep. Readers fit a column by
double-clicking its edge too, select cells, rows,
or columns to see their sum, average, min, max, and count, read a cell's whole value above the
grid, find values with ⌘F or Ctrl+F, copy cells as a table that pastes into other spreadsheets, and
download each sheet as CSV or the whole workbook as an `.xlsx` file, with its column formats, frozen
panes, widths, links, checkboxes as booleans, highlights as conditional formats, and totals as
`SUBTOTAL` formulas. A CSV or TSV `file` artifact opens in the same grid.

### Live rows

A sheet can read its rows from one of the version's [queries](#declare-a-query) instead of a CSV,
so each reader sees the project's objects as they are when they open it:

```json
{
  "name": "Overdue",
  "query": "overdue",
  "columns": {
    "Invoice": { "from": "number" },
    "Customer": { "from": "customer.name" },
    "Amount": { "from": "amount", "type": "currency" },
    "Due": { "from": "dueDate" }
  },
  "totals": { "Amount": "sum" }
}
```

- `query` names `queries/<name>.json`, a query of rows; the sheet has no `sheets/<name>.csv`.
- Its columns are those `columns` lists, in order. Each shows a property in `from`, or
  `<link>.<property>` of a link the query expands, or computes with a `formula`.
- Without `type`, a column takes its property's: numbers, dates, booleans, an enum as a tag, the
  rest as text. Formats, totals, charts, and downloads work as on any sheet.
- A value the reader is not cleared for shows locked, as does a formula, total, or chart over it; a
  download leaves it empty. The sheet names the columns the reader lacks permission to see and
  tells them to ask an admin of the project. It shows up to 10,000 rows and says when there were
  more.
- A live sheet is read-only in the app. A document, deck, or canvas that shows its range or chart
  shows each reader their rows.
- Its rows follow the objects: when one the query reads is created, changed, deleted, or linked,
  the open sheet reads them again, about a second later.

## Write slides

A deck is `index.html` with one `<section class="slide">` per 1280×720 slide, and the CSS and
images it loads beside it by relative path. Sixb adds a kit and a small runtime to the page: they
scale the slides to fit, number them, apply your app's theme and dark mode, and give the reader
previous and next, an overview of every slide, and present, where the slide fills the page.

```html
<section class="slide title">
  <p class="eyebrow">Q3 2026</p>
  <h1>Restorations within SLA reached 94%</h1>
  <p>Up from 88% in Q2</p>
</section>
<section class="slide stat">
  <h2>Revenue grew 9.6%</h2>
  <div class="value">$2.14M</div>
  <div class="label">Service revenue, Q3</div>
  <p class="source">Field service records</p>
</section>
```

- A slide picks a layout by class: `title`, `section`, `stat`, `split`, `chart`, `table`, `quote`,
  or `image`. `.eyebrow` sits above a heading and `.source` at a slide's foot.
- The kit reads your theme's tokens as CSS variables (`--foreground`, `--primary`, `--chart-1` to
  `--chart-5`, `--font-sans`, …). A deck's own CSS overrides the kit and the theme.
- Slides open in a sandboxed frame from a short-lived link. A deck runs its own scripts, but it
  can't read the app's cookies or call the API as the reader, and it loads only its own files and a
  few public CDNs (jsDelivr, cdnjs, unpkg, and Google Fonts). It opens no windows and never leaves
  its frame: a link to a web page opens in a new tab when the reader follows it.
- A link to another artifact (`<a href="artifact:…">`) opens it where the reader is.
  `<sixb-embed src="artifact:…#chart=revenue">` shows another artifact on a slide: a chart, a
  range, a section, or a slide of another deck, drawn by the app over the slide at the size the
  deck gives the box, as documents show it. `<img src="artifact:…/figure.png">` shows an image
  file of another artifact. Either shows only what its reader can open; anything else is an empty
  box. Thumbnails and the overview show each box empty, with its `title`.
- `?part=4` opens a deck at slide 4, and `![…](artifact:…#4)` shows that slide in a document.
- When the Agent publishes a deck, it lays the deck out in its sandbox's headless browser and
  gets a warning for each slide with content past its edge or over the footer, overlapping or cut
  off text, text under 18px or under WCAG AA contrast in light or dark mode (only the mode a
  deck's `theme.json` pins, with its tokens), or a broken image,
  with a screenshot of every slide to look at before it revises. This needs the agent image (or a
  sandbox with Playwright for Node at `/opt/sixb/js/node_modules/playwright`); without a browser
  the deck still publishes, unchecked, and the Agent is told.

## Write a page

A page is `index.html` and the files it loads beside it by relative path: scripts, styles, images,
and data as JSON. Use one for what reads best as a small web app: a dashboard, a calculator, a
planner, an interactive explainer. It opens in the same sandboxed frame as slides, filling the
viewer and scrolling as a page does.

```text
fleet-planner/
├── index.html
├── app.js
├── style.css
└── data/units.json
```

```html
<!doctype html>
<html lang="en">
  <head>
    <title>Fleet planner</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <p class="eyebrow">Q4 2026</p>
      <h1>Fleet planner</h1>
      <p class="lede">Crews and vans needed for next quarter's service visits.</p>
      <div class="grid">
        <div class="card stat"><div class="label">Visits</div><div class="value">1,284</div></div>
      </div>
    </main>
    <script src="app.js"></script>
  </body>
</html>
```

- Sixb adds a kit and the runtime to the page, as it does to a deck. The kit makes plain HTML look
  finished in your app's theme: `<main>` is a centered column, and headings, tables, forms, and
  buttons are drawn like the app's. A page picks a few components by class: `.eyebrow`, `.lede`,
  `.card`, `.grid`, `.row`, `.stat` (with `.label`, `.value`, `.delta`), `.tag`, `.callout`,
  `.note`, and `.table-scroll`.
  The page's own CSS overrides the kit and the theme, and text takes the colour the page gives
  its body: a page with its own light background reads the same in dark mode.
- The page's `<title>`, else its first `<h1>`, names it in cards and lists.
- A page runs its own scripts, with the same limits as a deck: it can't read the app's cookies or
  call the API itself, and it loads only its own files and a few public CDNs (jsDelivr, cdnjs,
  unpkg, and Google Fonts). Data that isn't your project's, such as figures you were given, goes
  in JSON files published beside it, read with `fetch`. A chart drawn on a canvas redraws on the
  window's `sixb:theme` event, which fires when the app sends its theme, light or dark.
- `window.sixb.query(name)` reads one of the version's [queries](#declare-a-query) as the reader,
  with their rights, so the page shows your objects as they are when it opens:

  ```js
  const { objects, total, truncated } = await sixb.query("overdue")
  ```

  - It resolves to what `GET /api/artifacts/{artifactId}/versions/{version}/queries/{name}`
    returns: rows as `POST /api/objects/query` returns them, or `{ kind: "facets", total, facets }`.
    A query the reader can't run, or one the version doesn't hold, rejects with the API's error.
  - A value the reader isn't cleared for is missing from a row's `properties` and listed in its
    `redactions`. Show it as locked, as a live sheet does, and lock any total that reads it.
  - A query takes no parameters: the page filters and sorts its rows. Decks and canvas boards read
    queries the same way.
  - When the objects a query reads change, the app reads it again and fires `sixb:query` on the
    window, with the query's name in `detail.name`, for each query the page read. Read it again
    and draw:

    ```js
    addEventListener("sixb:query", (event) => {
      if (event.detail.name === "overdue") load()
    })
    ```
- `window.sixb.state` keeps JSON values for each reader, across the page's versions, so a
  planner opens where they left it: `await sixb.state.set("inputs", { rate: 450 })`, then
  `get`, `delete`, and `keys`. Each reader gets 100 keys, 64 KB a value, and 1 MB in all. A
  page has no other storage. *Reset page data* in the viewer's menu clears a reader's values,
  and on the server `sixb.artifacts.state(id)` reads and writes the caller's.
- A link to another artifact (`<a href="artifact:…">`) opens it where the reader is, and
  `<sixb-embed src="artifact:…#chart=revenue">` shows one on the page, as it does on a slide: the
  app draws the artifact over the box and keeps it there as the page scrolls.
- When the Agent publishes a page, its sandbox's headless browser loads it at 1280px and at a
  phone's 390px, as it checks a deck, and warns about content past the screen's right edge,
  overlapping or cut off text, text under 12px, a control under 24px, low contrast, a broken image,
  or a script error, with a screenshot at each width to look at before it revises. The page's
  queries run as whoever asked the Agent, so the check draws their rows.

## Write a canvas

A canvas is `canvas.json`, listing its items on an endless board, with the HTML files its boards
show beside it. Use one for what reads best laid out side by side: several screens of a flow, a
brainstorm or a retro, a diagram, a mood board.

```json
{
  "items": [
    { "id": "first-run", "type": "section", "x": 0, "y": -120, "w": 1020, "h": 964, "title": "First run" },
    { "id": "welcome", "type": "board", "file": "boards/welcome.html", "x": 0, "y": 0, "w": 390, "h": 844, "title": "Welcome" },
    { "id": "region", "type": "board", "file": "boards/region.html", "x": 630, "y": 0, "w": 390, "h": 844 },
    { "id": "next", "type": "arrow", "from": "welcome", "to": "region", "label": "Get started" },
    { "id": "ask", "type": "note", "x": 630, "y": 1010, "w": 300, "text": "Skip this screen with GPS?" },
    { "id": "title", "type": "text", "x": 0, "y": -300, "text": "Field app onboarding", "size": "xl" },
    { "id": "paid", "type": "shape", "shape": "diamond", "x": 1100, "y": 1010, "w": 200, "h": 140, "text": "Paid?" },
    { "id": "sla", "type": "embed", "src": "artifact:art_k3m9q2x7tp#chart=sla-trend", "x": 1500, "y": 0, "w": 640, "h": 400 }
  ]
}
```

| Item      | Is                                                                                   |
| --------- | ------------------------------------------------------------------------------------ |
| `board`   | An HTML file of the canvas, shown as a page `w` by `h`: a screen, a mockup, a poster |
| `section` | A group's heading, drawn at the top left of the region it names                      |
| `note`    | A sticky note of plain text that grows to hold it; `tone` picks its color            |
| `text`    | A label or a heading, `size` `s`, `m`, `l`, `xl`, or `xxl` (120 px, a title)          |
| `shape`   | A `rect`, `ellipse`, or `diamond`, with optional text                                |
| `arrow`   | From one item, or a point `{ "x", "y" }`, to another, with an optional `label`, `dashed` |
| `embed`   | Another artifact, or a part of one, at a size                                        |

- Each item has an `id` of lowercase letters, digits, and hyphens, and sits at `x` and `y` in
  pixels. Items draw in the order listed, and a canvas opens fitted to everything.
- Boards are pages: Sixb adds the page kit and runtime to each, and boards may share CSS and
  images beside them (`boards/shared.css`).
- `artifact:…#welcome` opens the canvas with that board open, or on that section; a document
  embeds a board with `![Welcome](artifact:…#welcome)`. A canvas holds at most 1,000 items and
  100 boards; sizes run from 40 to 8,000 pixels and positions within ±100,000.

Readers drag or scroll to pan, pinch or ⌘-scroll to zoom, fit everything with the controls, and
press the zoom to go to 100%. Boards and embeds run live once the view shows them at half their
size, or 360 pixels wide while a board has no preview yet, up to 8 at once, and keep running as
the reader zooms out. Double-click a board, press Enter on it, or press the button by its name to
open it: it opens at its own size and answers like a page, ← and → step through the boards in
order, and Esc goes back to the canvas. In an opened board, a button or a `#` link whose words are
the label of an arrow leaving it opens the board the arrow points to.

A running board is a page the reader uses in place, without opening it:

- Clicks, typing, and selecting text reach the page. The wheel pans the canvas unless the page
  scrolls under the pointer; on a touch screen a tap reaches the page and a drag pans. Pinches,
  ⌘-scroll, and ⌘ +, − and 0 zoom the canvas, and Space held drags it from anywhere.
- A button or a `#` link whose words are the label of an arrow leaving the board glides the canvas
  to the board the arrow points to.
- While the canvas is edited or a comment placed, boards take no clicks: dragging over one pans.

An opened board zooms as the canvas does, and its page takes the size the reader wants:

- It opens whole; a page taller than wide opens fitted to its width and scrolls, like a document.
- The zoom bar, a pinch or ⌘-scroll over the page, ⌘ +, − and 0, and a double-click beside it
  zoom the board, never the browser.
- Its right edge, bottom edge, and corner resize the page for the reader alone: it is laid out
  again at that size, a responsive mockup reflowing at a phone's width. Edges snap to the board's
  size, the full page, and common screens; Alt drags freely. The **Size** menu offers the same.
- A common screen's width carries to the boards the reader steps to, each at its own height or
  full page, so a flow is walked at a phone's width. **Back to board size** ends it.
- Nothing is saved. Whoever may change the canvas can press **Keep this size**: it starts
  editing if needed, the board takes that size on the canvas as resizing it there does, and Undo
  puts it back.

Publishing warns of boards that overlap and of notes or text on a board. When the Agent publishes a
canvas, its sandbox's browser opens each board at its own size, as it checks a page, and the Agent
gets each board's warnings and screenshot, and `overview.png`, the canvas as it opens.

Each board also gets a preview: a picture of it in light and dark, or in the mode `theme.json`
pins, shown in place of the board until it runs, in the reader's mode. Each comes in two sizes:
`full`, a PNG of the board at its own size, and `small`, a WebP at most 480 pixels wide, shown
while the board is drawn small. While it is rendered, the board shows its outline, or its last
preview when it changed, and the viewer shows the new one as soon as it is ready.

- The [`render` worker](../cli/overview.md) pictures them in a blank sandbox of the project, which
  reaches only the CDNs a board may load from, however the version was published: by the Agent,
  in the app, or over the API. Without sandboxes, boards have no preview. The worker waits until
  the canvas has not been written for 15 seconds, so a canvas edited live is pictured once, as it
  is when people pause.
- A preview is named by what the board shows: its HTML, the files it can load, and its size, in
  its canvas. Moving a board keeps its preview, whoever saves the canvas; resizing it or changing
  what it loads renders a new one. A board kept as it was keeps the picture it was first given.
- A board whose page does not load whole, a file or a font that fails, gets no preview and shows
  its outline: a broken picture would stay.
- A board that reads a query is pictured with the data its publisher could read when they
  published it, which everyone who can open the canvas then sees in its preview; publishing warns
  of it. In a canvas with queries, a change someone else saves renders the previews again,
  with their data, and a copy of the canvas, such as a forked conversation's, gets none of them.
- `GET /api/artifacts/{artifactId}/versions/{version}/boards/{board}/preview?theme=dark&size=small`
  serves one to whoever reads the version, and reading or publishing a version says which boards'
  previews are `ready`, `pending`, or `none`.

## Declare a query

A sheet, a page, a deck, a canvas, or a designed document can hold queries over your objects
rather than a copy of them. Each is a file `queries/<name>.json` holding what `sixb objects query
--file` runs, and each reader runs it with their own rights: they get the objects they can view,
without the marked properties they are not cleared for.

File: `queries/overdue.json`

```json
{
  "kind": "limit",
  "limit": 200,
  "input": {
    "kind": "filter",
    "input": { "kind": "start", "objectTypeId": "Invoice" },
    "predicate": { "op": "eq", "propertyId": "status", "value": "overdue" }
  }
}
```

- A file may also hold `{ "query": … }`, or `{ "query": …, "facets": [{ "propertyId": "status",
  "limit": 10 }] }` to count rows by value, as `sixb objects facets --file` takes it.
- Publishing runs each query once as its author and refuses one they could not run, naming the
  file and where in it. `page`, `vector`, and `rerank` are refused: Sixb pages the result, and a
  search would bill every reader who opens the artifact. A Markdown document holds no queries; a
  [designed one](#show-live-data-in-a-document) does.
- A query returns only what its author can read: one that would return a marked property they
  are not cleared for, on its rows or on an object an `expand` attaches, or member profiles they
  may not view, is refused. Use a `project` node to leave those properties out.
- A version holds up to 20 queries of 64 KB each. A query returns up to 10,000 rows, and
  `truncated` says when there were more.
- A sheet shows a query's rows as its [live rows](#live-rows), and a page, a deck, or a canvas
  board reads one with `sixb.query("overdue")` (see [Write a page](#write-a-page)). What an open
  artifact shows is read again when the objects its queries read change.
- The header of a version with queries says **Live**, with the time its data was last read, and
  **Refresh** reads every query again. An embed of live data says so under it.
- `sixb.artifacts.query(id, "overdue")` runs one as the caller, as does
  `GET /api/artifacts/{artifactId}/versions/{version}/queries/{name}`. Its `schema` gives the type
  of each property its rows and the links it expands hold, as the caller may view them. A query the
  ontology no longer admits fails with `query_invalid` (409 over HTTP).

From server code, pass query builders as `queries`; each is stored as its file:

```ts
const invoices = sixb.objects(Invoice).query()

await sixb.artifacts.create({
  kind: "page",
  title: "Overdue invoices",
  files: [{ path: "index.html", file: html }],
  queries: {
    overdue: invoices.where((invoice) => invoice.p.status.eq("overdue")).limit(200),
    statuses: { query: invoices, facets: [{ property: Invoice.p.status, limit: 10 }] },
  },
})
```

## Reference another artifact

A document, a sheet, a deck, a page, or an agent's reply can show another artifact, or a part of
it, by its address. A report that shows a sheet's chart stays current when the sheet changes. A
reply pins a created version it describes (`@2`), so that what it shows matches its words; an
address without a version follows the latest one.

```text
artifact:<id>[@<version>][/<file>][#<part>]
```

| Address                                       | Points at                                   |
| --------------------------------------------- | ------------------------------------------- |
| `artifact:art_k3m9q2x7tp`                     | The artifact, at its latest version         |
| `artifact:art_k3m9q2x7tp@2`                   | Version 2, created, which never changes     |
| `artifact:art_k3m9q2x7tp/figures/revenue.svg` | A file inside it                            |
| `artifact:art_k3m9q2x7tp#Regions`             | A sheet                                     |
| `artifact:art_k3m9q2x7tp#Regions!A1:D5`       | A range of a sheet; row 1 is its header row |
| `artifact:art_k3m9q2x7tp#chart=revenue`       | A chart in a workbook                       |
| `artifact:art_k3m9q2x7tp#methodology`         | A document's section, by its heading's slug |

In Markdown, an image alone in its paragraph shows the target in place, with the image's alt text
as its caption; a link opens it:

```md
![Revenue by quarter](artifact:art_k3m9q2x7tp#chart=revenue)

The [regional numbers](artifact:art_k3m9q2x7tp#Regions) explain the gap.
```

A range shows as a table formatted the way its sheet formats it, a chart as the chart, a section as
its text, an image file as the image, a deck as its first slide, a page live, as tall as it lays out
up to 800px and then scrolling, and any other whole artifact as a card. Under each, a line names the
source and whether it follows the latest version or a fixed one. Something shown inside a shown
artifact appears as a link. In a sheet, a `link` or `image` column cell can hold an address.

Publishing resolves every address in a version against what its author can read, and refuses one
that names nothing, saying what the target has instead, and one pinned to a version still open.
When a change renames or removes something another artifact shows, it publishes with a warning
naming that artifact. A reader who can't open a target sees it as unavailable.

## Hold an artifact in an object

An object can hold an artifact, such as the canvas a meeting is prepared in, in a
[`ref.artifact()` property](../ontology/properties.md#reference-an-artifact):

```ts
await sixb.objects(Meeting).upsert({
  properties: { id: "meeting-1", kickoffDoc: artifactRef(artifact.id) },
})
```

A writer can only give an object an artifact they can change. The artifact stays when the object
is deleted.

Whoever reads the object reads the artifact, and whoever may also edit the object changes it:

| | Reads the object | Also has `can.edit` on its type |
| --- | --- | --- |
| Read every version, comment, follow it live | ✓ | ✓ |
| Change it, create versions, restore it, keep page data with `sixb.state` | – | ✓ |
| Delete it | – | – |

- The reader must see the object and the property: a
  [view condition](../auth/authorization.md#grant-only-some-objects) that hides the object, or a
  [marking](../auth/markings.md) they are not cleared for, hides the artifact too.
- Access tokens reach it the same way, and so does a
  [shared link](../auth/shared-access.md#share-an-objects-artifacts) to the object, which reads
  it, follows it live, and comments as a guest.
- `/artifacts` does not list it: it opens from the object. `sixb.artifacts.holders(id)`, or
  `GET /api/artifacts/{artifactId}/holders`, lists the objects that hold it among those you read,
  with their titles.
- When the agent changes it for someone who may edit the object, the conversation shares it from
  then on.

## Open an artifact

Every artifact has a page at `/artifacts/{artifactId}` that fills the window, over your app's
navigation. Add `?v=2` for a version and `?part=revenue` to open at a document's section, a
sheet (`?part=Regions`), or a chart (`?part=chart=sla`). In an agent conversation, artifacts open
beside the chat.

`/artifacts` lists every artifact you can open, most recently updated first, each with a preview
of its latest version: a sheet's first chart, a document's title and lede, a deck's first slide,
an image. Filter it by kind with `?kind=document`, `sheet`, `slides`, or `file`; the list API
takes the same `kind`. The user menu, search (⌘K), and a conversation's artifact menu link to it.

The link button in an artifact's header copies a link to its page, and the one beside a heading a
link to that section. A link to the latest version keeps following the artifact as it changes; a
link copied from an earlier version stays on it.

An artifact belongs to its owner. Server code that runs as the system, outside any user's request,
reaches every artifact in the project.

### Shared in a conversation

When the agent publishes an artifact in a conversation, the conversation shares it: everyone who
reads the conversation reads the artifact, at its latest version, whatever published it.

| | Owner | [Participant](../models/overview.md#share-a-conversation) | [Observer](../apps/activity.md#read-a-conversation) |
| --- | --- | --- | --- |
| Read every version, list the conversation's artifacts | ✓ | ✓ | ✓ |
| Change it, create versions, restore it, keep page data with `sixb.state` | ✓ | ✓ | – |
| Delete it | ✓ | – | – |

- A change saved by anyone who can update it is seen by every reader of every conversation that
  shares the artifact. Its author is whoever saved it; the artifact stays its owner's.
- The agent revises someone else's artifact only in a conversation that already shares it, or
  when an object you may edit holds it. When it revises one you may change this way, or one of
  yours, in a conversation, that conversation shares it from then on, with its history.
- Retrying a turn takes back what it changed: an artifact it put back is no longer shared in a
  conversation only that turn shared it in. One someone changed since stays, and stays shared.
- The owner's other artifacts stay private. An embed or link to one is refused with 403
  `not_shared` for whoever cannot read it, so a page can say it is not shared in this
  conversation; an unknown id is a 404. The difference tells anyone whether an id exists, never
  what it holds.
- An observer's page runs, but keeps nothing: its `sixb.state` values last as long as the tab.
- Only a signed-in session reaches what a conversation shares: an access token reaches its own
  artifacts, and those an object it reads holds.
- `sixb.artifacts.access(id)` says what the caller may do: `owner`, `update`, `read`, or `none`.

## Theme an artifact

Artifacts use your app's theme, including dark mode. To style artifacts apart from the rest of
the app, scope token overrides in `app/globals.css`:

```css
[data-sixb-artifact] {
  --font-serif: "Source Serif 4", serif;
}
```

A document, a sheet, or a deck can carry its own `theme.json` at its root to pin a mode or override
tokens:

```json
{ "mode": "light", "tokens": { "--primary": "#0f766e", "--radius": "6px" } }
```

It can set colors (`--background`, `--foreground`, `--border`, `--chart-1` to `--chart-5`, and
`--card`, `--muted`, `--primary`, and `--accent` with their `-foreground` pairs), fonts
(`--font-sans`, `--font-serif`, `--font-mono`), and `--radius`. A `file` artifact holds one file,
so a `theme.json` there is that file, not a theme.
