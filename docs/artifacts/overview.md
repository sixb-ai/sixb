# Artifacts

An artifact is a piece of finished work your project keeps: a report, a chart, a file someone
needs. Each one has versions that never change once published, and a page in your app where its
owner reads it.

## Kinds

| Kind       | What it holds                                                          |
| ---------- | ---------------------------------------------------------------------- |
| `document` | A Markdown report in `document.md`, with its images beside it          |
| `sheet`    | Tables of data, one CSV per sheet, with typed columns and their charts |
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

From outside the server, use `POST /api/artifacts` and
`POST /api/artifacts/{artifactId}/versions` with files uploaded through `POST /api/files`.

## The Agent publishes

In a conversation, the Agent publishes what you ask it to make, such as a report, a brief, a table
of data, or a file in a format you name, as an artifact. Each artifact gets a card under the reply and opens beside the
conversation as soon as it is published, while the Agent is still working. Ask for a change and the
Agent publishes the next version of the same artifact; the version menu keeps the earlier ones. The
conversation's header lists every artifact it published.

A cancelled reply keeps what it already published. Retrying a reply that failed removes what it
published along with what it said.

The Agent learns the formats from a built-in skill, `sixb-artifacts`. To change how it writes, add a
skill with the same name under `skills/`: yours replaces the built-in one.

A file one of your tools returns stays with that tool's step in the conversation. The Agent publishes
it when it is what you asked for.

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
        "Parts cost": { "type": "currency", "currency": "USD" }
      }
    }
  ],
  "charts": [{ "name": "sla", "type": "bar", "sheet": "Regions", "x": "Region", "y": "Within SLA" }]
}
```

```text
sheets/Regions.csv
Region,Visits,Within SLA,Parts cost
North,1284,0.961,182400
Central,962,0.934,141950
```

- A column is `text` unless the workbook gives it a type: `number`, `currency`, `percent` (written
  as a fraction, `0.961`), `date` (`2026-09-30`), `link` (a full `https://` address), or `image`
  (the path of an image file in the artifact).
- Values are formatted in the reader's locale, so write them without symbols or separators.
- `frozenRows` (default 1, the header) and `frozenColumns` (default 0) stay in view while the
  sheet scrolls; `widths` sets columns' widths in pixels.
- A chart is a `bar`, `line`, `area`, or `pie` chart of up to five `y` columns against an `x`
  column. Its `name` is its address, so keep it across versions and rename it by its `title`. Bar and area charts can be `stacked`; a pie has one `y` column and at most five rows.

Publishing reads every typed cell and every chart against its sheet and refuses the version with
the file, row, and column to fix. A sheet holds at most 200 columns and 100,000 rows, and a
workbook 20 sheets and 10 charts.

Readers sort columns, select a range to see its sum, average, and count, copy cells, and download
each sheet as CSV. A CSV or TSV `file` artifact opens in the same grid.

## Reference another artifact

A document, a sheet, or an agent's reply can show another artifact, or a part of it, by its
address. A report that shows a sheet's chart stays current when the sheet changes. The Agent's
replies pin the version they describe (`@2`), so what a reply shows never changes under its words.

```text
artifact:<id>[@<version>][/<file>][#<part>]
```

| Address | Points at |
| --- | --- |
| `artifact:art_k3m9q2x7tp` | The artifact, at its latest version |
| `artifact:art_k3m9q2x7tp@2` | Version 2, which never changes |
| `artifact:art_k3m9q2x7tp/figures/revenue.svg` | A file inside it |
| `artifact:art_k3m9q2x7tp#Regions` | A sheet |
| `artifact:art_k3m9q2x7tp#Regions!A1:D5` | A range of a sheet; row 1 is its header row |
| `artifact:art_k3m9q2x7tp#chart=revenue` | A chart in a workbook |
| `artifact:art_k3m9q2x7tp#methodology` | A document's section, by its heading's slug |

In Markdown, an image alone in its paragraph shows the target in place, with the image's alt text
as its caption; a link opens it:

```md
![Revenue by quarter](artifact:art_k3m9q2x7tp#chart=revenue)

The [regional numbers](artifact:art_k3m9q2x7tp#Regions) explain the gap.
```

A range shows as a table formatted the way its sheet formats it, a chart as the chart, a section as
its text, an image file as the image, and a whole artifact as a card. Under each, a line names the
source and whether it follows the latest version or a fixed one. Something shown inside a shown
artifact appears as a link. In a sheet, a `link` or `image` column cell can hold an address.

Publishing resolves every address in a version against what its author can read, and refuses one
that names nothing, saying what the target has instead. When a new version renames or removes
something another artifact shows, it publishes with a warning naming that artifact. A reader who
can't open a target sees it as unavailable.

## Open an artifact

Every artifact has a page at `/artifacts/{artifactId}` that fills the window, over your app's
navigation. Add `?v=2` for a version and `?part=revenue` to open at a document's section, a
sheet (`?part=Regions`), or a chart (`?part=chart=sla`). In an agent
conversation, artifacts open beside the chat.

The link button in an artifact's header copies a link to its page, and the one beside a heading a
link to that section. A link to the latest version keeps following the artifact as new versions
are published; a link copied from an earlier version stays on it.

Only the artifact's owner can open it. Server code that runs as the system, outside any user's
request, reaches every artifact in the project.

## Theme an artifact

Artifacts use your app's theme, including dark mode. To style artifacts apart from the rest of
the app, scope token overrides in `app/globals.css`:

```css
[data-sixb-artifact] {
  --font-serif: "Source Serif 4", serif;
}
```

An artifact can carry its own `theme.json` at its root to pin a mode or override tokens:

```json
{ "mode": "light", "tokens": { "--primary": "#0f766e", "--radius": "6px" } }
```

It can set colors (`--background`, `--foreground`, `--card`, `--muted`, `--primary`, `--accent`,
`--border`, `--chart-1` to `--chart-5`, and their `-foreground` pairs), fonts (`--font-sans`,
`--font-serif`, `--font-mono`), and `--radius`.
