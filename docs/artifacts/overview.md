# Artifacts

An artifact is a piece of finished work your project keeps: a report, a chart, a file someone
needs. Each one has an address, versions that never change once published, and a page in your
app where its owner reads it.

## Kinds

| Kind       | What it holds                                                 |
| ---------- | ------------------------------------------------------------- |
| `document` | A Markdown report in `document.md`, with its images beside it |
| `file`     | One file, shown as its type allows or offered for download    |

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
version first: a document's images must be files in that version, so it reads the same wherever
it opens.

From outside the server, use `POST /api/artifacts` and
`POST /api/artifacts/{artifactId}/versions` with files uploaded through `POST /api/files`.

## Write a document

A document is Markdown with tables, footnotes, and task lists. A few conventions shape its page:

- The first `#` heading is the title, and the paragraph after it is the lede.
- `## ` and `### ` headings form the outline beside the page.
- A quote that starts with `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`
  becomes a callout.
- An image with a title alone in its paragraph becomes a figure, and the title becomes its
  caption: `![Revenue by region](figures/revenue.png "Revenue by region, Q3")`.
- Table columns of figures align right.

## Open an artifact

Every artifact has a page at `/artifacts/{artifactId}`. Add `?v=2` for a version and
`?part=revenue` to open at a section. In an agent conversation, artifacts open beside the chat.

An artifact's address names it anywhere: `artifact:art_0123456789`, pinned to a version with
`@2` and to a section with `#revenue`. Copy it from the artifact's header.

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
