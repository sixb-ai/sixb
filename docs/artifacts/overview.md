# Artifacts

An artifact is a piece of finished work your project keeps: a report, a chart, a file someone
needs. Each one has versions that never change once published, and a page in your app where its
owner reads it.

## Kinds

| Kind       | What it holds                                                          |
| ---------- | ---------------------------------------------------------------------- |
| `document` | A Markdown report in `document.md`, with its images beside it          |
| `sheet`    | Tables of data, one CSV per sheet, with typed columns and their charts |
| `slides`   | A deck: `index.html` with one `<section class="slide">` per slide      |
| `page`     | A web page: `index.html` and its scripts, styles, images, and data     |
| `canvas`   | An endless board of boards, sections, notes, shapes, and arrows        |
| `file`     | One file, shown as its type allows or offered for download             |

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

`sixb.artifacts.publish(artifact.id, input)` adds the next version. Publishing checks the whole
version first: a document's images must be files in that version or another artifact's address, so
it reads the same wherever it opens.

Pass `baseVersion`, the version your change was made from, when someone else may publish in
between. If another version was published since, the publish fails with `artifact_moved` (409 over
HTTP) and names the latest version and its author, rather than replace changes you never saw:

```ts
await sixb.artifacts.publish(artifact.id, { ...input, baseVersion: 3 })
```

From outside the server, use `POST /api/artifacts` and
`POST /api/artifacts/{artifactId}/versions` with files uploaded through `POST /api/files`.

## The Agent publishes

In a conversation, the Agent publishes what you ask it to make, such as a report, a brief, a table
of data, or a file in a format you name, as an artifact. Each new artifact gets a card under the
reply. The first one a reply publishes opens beside the conversation as soon as it is published,
while the Agent is still working; on a phone, where it would open over the conversation, it waits
on its card instead.

Ask for a change and the Agent publishes the next version of the same artifact. The reply shows it
as a line with the version number and what changed, such as a sheet or section added, and the
version menu keeps the earlier versions. The conversation's header lists every artifact it
published.

A cancelled reply keeps what it already published. Retrying a reply that failed removes what it
published along with what it said.

The Agent learns the formats from a built-in skill, `sixb-artifacts`.

A file one of your tools returns stays with that tool's step in the conversation. The Agent
publishes it when it is what you asked for.

## Edit in the app

Sheets and canvases are edited where they open. Press **Edit** on the latest version: the header
becomes a draft bar with Undo, Redo, Discard, and **Save as version N**. Saving publishes your
draft as the next version; the earlier ones stay in the version menu. ⌘S saves, and leaving with
changes asks first.

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

Boards' pages are the Agent's to change; on the canvas you arrange them. If someone published a
version while you were editing, the save stops and says so: open the new version, or save yours
over it. The next time the Agent works on the artifact, it starts from your version and keeps your
changes.

## Write a document

A document is Markdown with tables, footnotes, and task lists. A few conventions shape its page:

- The first `#` heading is the title, and the paragraph after it is the lede.
- `## ` and `### ` headings form the outline beside the page.
- A quote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`
  becomes a callout.
- An image with a title alone in its paragraph becomes a figure, and the title becomes its
  caption: `![Revenue by region](figures/revenue.png "Revenue by region, Q3")`.
- Table columns of figures align right.

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
  few public CDNs (jsDelivr, cdnjs, unpkg, and Google Fonts).
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
  The page's own CSS overrides the kit and the theme.
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
  - A query takes no parameters: the page filters and sorts its rows. Decks and canvas boards read
    queries the same way.
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
| `text`    | A label or a heading, `size` `s`, `m`, `l`, or `xl`                                  |
| `shape`   | A `rect`, `ellipse`, or `diamond`, with optional text                                |
| `arrow`   | From one item, or a point `{ "x", "y" }`, to another, with an optional `label`, `dashed` |
| `embed`   | Another artifact, or a part of one, at a size                                        |

- Each item has an `id` of lowercase letters, digits, and hyphens, and sits at `x` and `y` in
  pixels. Items draw in the order listed, and a canvas opens fitted to everything.
- Boards are pages: Sixb adds the page kit and runtime to each, and boards may share CSS and
  images beside them (`boards/shared.css`).
- `artifact:…#welcome` opens the canvas with that board open, or on that section; a document
  embeds a board with `![Welcome](artifact:…#welcome)`. A canvas holds at most 500 items and 40
  boards; sizes run from 40 to 8,000 pixels and positions within ±100,000.

Readers drag or scroll to pan, pinch or ⌘-scroll to zoom, fit everything with the controls, and
press the zoom to go to 100%. Boards run live once they're on screen, up to 12 at once, and keep
running as the reader zooms out; on the canvas they're pictures, so dragging over one pans.
Double-click a board, press Enter on it, or press the button by its name to open it: it fills the
viewer and answers like a page, ← and → step through the boards in order, and Esc goes back to the
canvas.

Publishing warns of boards that overlap and of notes or text on a board. When the Agent publishes a
canvas, its sandbox's browser opens each board at its own size, as it checks a page, and the Agent
gets each board's warnings and screenshot.

## Declare a query

A sheet, a page, a deck, or a canvas can hold queries over your objects rather than a copy of
them. Each is a file `queries/<name>.json` holding what `sixb objects query --file` runs, and each
reader runs it with their own rights: they get the objects they can view, without the marked
properties they are not cleared for.

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
  search would bill every reader who opens the artifact. A document holds no queries.
- A query returns only what its author can read: one that would return a marked property they
  are not cleared for, on its rows or on an object an `expand` attaches, or member profiles they
  may not view, is refused. Use a `project` node to leave those properties out.
- A version holds up to 20 queries of 64 KB each. A query returns up to 10,000 rows, and
  `truncated` says when there were more.
- A sheet shows a query's rows as its [live rows](#live-rows), and a page, a deck, or a canvas
  board reads one with `sixb.query("overdue")` (see [Write a page](#write-a-page)).
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
it, by its address. A report that shows a sheet's chart stays current when the sheet changes. The Agent is
told to pin the version a reply describes (`@2`), so that what the reply shows matches its words;
an address it writes without a version follows the latest one.

```text
artifact:<id>[@<version>][/<file>][#<part>]
```

| Address                                       | Points at                                   |
| --------------------------------------------- | ------------------------------------------- |
| `artifact:art_k3m9q2x7tp`                     | The artifact, at its latest version         |
| `artifact:art_k3m9q2x7tp@2`                   | Version 2, which never changes              |
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
that names nothing, saying what the target has instead. When a new version renames or removes
something another artifact shows, it publishes with a warning naming that artifact. A reader who
can't open a target sees it as unavailable.

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
link to that section. A link to the latest version keeps following the artifact as new versions
are published; a link copied from an earlier version stays on it.

An artifact belongs to its owner. Server code that runs as the system, outside any user's request,
reaches every artifact in the project.

### Shared in a conversation

When the agent publishes an artifact in a conversation, the conversation shares it: everyone who
reads the conversation reads the artifact, at its latest version, whatever published it.

| | Owner | [Participant](../models/overview.md#share-a-conversation) | [Observer](../apps/activity.md#read-a-conversation) |
| --- | --- | --- | --- |
| Read every version, list the conversation's artifacts | ✓ | ✓ | ✓ |
| Publish a version, keep page data with `sixb.state` | ✓ | ✓ | – |
| Delete it | ✓ | – | – |

- A version saved by anyone who can update it is seen by every reader of every conversation that
  shares the artifact. Its author is whoever saved it; the artifact stays its owner's.
- The agent revises someone else's artifact only in a conversation that already shares it. When
  it revises one of yours in a conversation, that conversation shares it from then on, with its
  history.
- Retrying a turn takes back what it published: an artifact only that turn shared in the
  conversation is no longer shared there.
- The owner's other artifacts stay private. An embed or link to one is refused with 403
  `not_shared` for whoever cannot read it, so a page can say it is not shared in this
  conversation; an unknown id is a 404. The difference tells anyone whether an id exists, never
  what it holds.
- An observer's page runs, but keeps nothing: its `sixb.state` values last as long as the tab.
- Only a signed-in session reaches shared artifacts: an access token reaches only its own.
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
