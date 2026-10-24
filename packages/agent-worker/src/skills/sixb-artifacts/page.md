# Pages

A page is a small web app the user opens beside the conversation: `index.html` and the files it
loads beside it. Sixb adds its kit and runtime to the page, which draw plain HTML in the app's
theme and dark mode. Publish one for what the reader works with, not just reads: a calculator, a
planner, a dashboard with filters, an explainer with controls.

| The deliverable | Publish |
| --- | --- |
| Read top to bottom | a `document` |
| Rows to sort, sum, chart, or download | a `sheet` |
| Presented in a meeting | `slides` |
| Changed by the reader to see what follows | a `page` |

```text
work/fleet-planner/
├── index.html
├── style.css         optional, for what the kit doesn't cover
├── app.js            optional; a short script can sit in index.html
├── queries/jobs.json the project's objects it reads live, with sixb.query
└── data/regions.json the data it was given, as a file
```

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Fleet planner</title>
</head>
<body>
  <main>
    <p class="eyebrow">Q4 2026 · Field service</p>
    <h1>Fleet planner</h1>
    <p class="lede">Crews and vans next quarter's visits need, by region.</p>
    <div class="grid">
      <div class="card stat"><div class="label">Crews needed</div><div class="value" id="crews">–</div></div>
    </div>
  </main>
  <script>
    fetch("data/regions.json").then((response) => response.json()).then(render)
  </script>
</body>
</html>
```

The `<title>`, else the first `<h1>`, names the page in cards and lists.

## The kit

Write plain HTML first: the kit already draws it like the app.

- `<main>` is a centered column, 1120px at most, with room around it, narrower on a phone.
- Headings, paragraphs, lists, links, `<code>`, and `<hr>` have a measured type scale.
- `<table>`: hairline rows and quiet headers; `class="num"` on number cells aligns them.
- `<label>`, `<input>`, `<select>`, `<textarea>`, and `<button>` look like the app's controls.
  `class="secondary"` and `class="ghost"` give quieter buttons; `class="button"` on a link draws it
  as one. Wrap a label and its field in `<div class="field">`.

| Class | Is |
| --- | --- |
| `eyebrow` | A small label above a heading: the period, the team |
| `lede` | The page's one-sentence summary under its heading |
| `card` | A panel on the page's surface, for a group of controls or a figure; cards stack 16px apart |
| `grid` | Cards in columns that wrap: 3 or 4 across on a laptop, 1 on a phone |
| `row` | Things side by side that wrap: buttons, tags |
| `stat` | A number that matters, in a card: `.label`, `.value`, `.delta` |
| `tag` | A small pill: a status, a category |
| `callout` | The one point to remember, on a shaded panel |
| `note` | An aside or a source, in smaller, muted text |
| `table-scroll` | A box a wide table scrolls in, so the page doesn't |

Colors come from the theme, so a page follows light and dark mode. Use the variables, not fixed
colors: `--foreground`, `--muted-foreground`, `--background`, `--card`, `--muted`, `--primary`,
`--border`, `--chart-1` to `--chart-5`, `--font-sans`, `--font-mono`, `--radius`. Only when the user
asks for a look, add `theme.json` (see `document.md`) or set the variables in your CSS. The page's
own CSS overrides the kit.

The theme is monochrome. For a status that needs a color, such as short or over, define your own
with a dark-mode value, and use it sparingly:

```css
:root { --over: #c2410c; --ok: #15803d; }
html.dark { --over: #fb923c; --ok: #4ade80; }
```

## Write

- Put the controls where the reader starts, and show the result change as they change them,
  without a submit button.
- Lead with the numbers that matter as `.stat` cards; put detail in tables below.
- Format numbers for the reader: `new Intl.NumberFormat().format(1284)`. Label units.
- Build controls the reader changes: segmented controls, sliders, switches, chips (radios and
  checkboxes drawn as the examples draw them), search, sortable tables.
- For one simple chart, an inline `<svg>` in the theme's chart variables is enough; for charts the
  reader hovers, zooms, or filters, use a library (below).
- No emoji as icons, no decorative gradients, glows, or drop shadows.

## What runs

The page runs its own scripts in a sandboxed frame. It loads only its own files and libraries from
cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, and Google Fonts; nothing else on the network.

- Read the project's objects live, not a copy: declare a query as `queries/<name>.json` beside
  `index.html` (`queries.md` says how to write one) and read it with `sixb.query("<name>")`. Each
  reader runs it with their own rights as the page opens, so its rows are current and hold only
  what that reader may see. The page can't reach the API any other way.

  ```js
  // In <script type="module">, which can await at its top.
  const status = document.querySelector("#status")
  status.textContent = "Loading invoices…"
  try {
    const { objects, total, truncated } = await sixb.query("overdue")
    // objects: [{ primaryId, objectTypeId, properties: { amount: 1200, … }, redactions? }, …]
    // A facets query resolves to { kind: "facets", total, facets }.
    render(objects)
    status.textContent = truncated ? `The first ${objects.length} of ${total}` : ""
  } catch (error) {
    status.textContent = `The invoices could not be read: ${error.message}`
  }
  ```

  Draw a loading state until it answers and an error state when it rejects: its message says why,
  such as a type the reader can't view. A query takes no parameters: filter, sort, and group its
  rows in the page as the reader changes the controls.

  A value the reader isn't cleared for is missing from `properties` and listed in the row's
  `redactions` (`{ amount: { reason: "missing_clearance" } }`): a permission they lack. Show it as
  locked, with that reason ("You don't have permission to see Amount"), never as 0 or empty, and
  never total, chart, or compare over it: a figure that reads it is locked too.
- Copy values into JSON files beside the page only when `queries.md` says to copy, such as a
  snapshot or figures the user gave you, and read them with `fetch("data/regions.json")`.
- Load a library from a CDN, by exact version, when it does real work: ECharts for interactive
  charts (`https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`), SortableJS for drag
  and drop (`https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js`). Say on the page what
  failed when `window.echarts` is missing, instead of showing nothing.
- A chart drawn on a canvas keeps the colors it was drawn in. Read the variables with
  `getComputedStyle(document.documentElement)` each time you draw, and draw again on
  `addEventListener("sixb:theme", draw)`, which fires when the app sends its theme and when the
  reader switches mode.
- Skip animations when `matchMedia("(prefers-reduced-motion: reduce)")` matches (ECharts:
  `animation: false`). The check measures with reduced motion, so its screenshots show charts drawn.
- Keep what the reader sets with `sixb.state`, so they come back to it: their inputs, filters,
  pinned scenarios, a checklist. It is kept for each reader, across the page's versions, and
  there is no other storage (`localStorage` throws in the sandbox). Values are JSON: at most 64 KB
  a key, 100 keys, and 1 MB in all. Give inputs sensible defaults for a first visit, and a Reset
  that deletes what it kept.

  ```js
  const kept = await sixb.state.get("inputs")      // the value, or undefined the first time
  await sixb.state.set("inputs", { rate: 450, occupancy: 84 })
  await sixb.state.delete("inputs")
  const keys = await sixb.state.keys()             // ["inputs", "pinned"]
  ```

  Write after the reader stops moving a control (a 300 ms pause), not on every step. The check
  keeps values in memory, so a page that uses them checks as it runs. The reader can clear them
  with *Reset page data* in the viewer.
- A link to another artifact (`<a href="artifact:…">`) opens it beside the conversation; a link to
  a web page opens in a new tab. Open pages with links: the frame can't open windows
  (`window.open`) or go to another address itself.
- `<sixb-embed src="artifact:…#chart=revenue"></sixb-embed>` shows another artifact on the page: a
  chart, a range, a section, a slide (see `references.md`). Size the box with CSS like any block;
  it is the column's width and 16:9 unless you say otherwise. The app draws the artifact over it,
  live, as the page scrolls. Use one instead of redrawing a chart a sheet already draws.

## Narrow screens

The reader may open the page on a phone, 390px wide. The kit's `<main>`, `.grid`, and `.row`
already reflow; make your own layout do the same.

- Lay out columns with CSS grid or flex that collapse under about 760px:
  `grid-template-columns: minmax(0, 1fr)`, so a wide table can't widen the column. Cards in your own
  grid take `margin: 0`; the gap spaces them.
- Put a wide table in `<div class="table-scroll">`.
- No fixed widths wider than 360px, and no text under 12px. Controls at least 24px each way; the
  kit's are 36px.

## Check

Publishing refuses a page without `index.html`.

Once a page publishes, Sixb loads it in the sandbox's browser at 1280px and at a phone's 390px, in
light and in dark mode or in the one mode its `theme.json` pins, and warns about anything past the
screen's right edge, drawn over other text, or cut off; text under 12px; a control under 24px;
text under WCAG AA contrast; an image that did not load; or a script error. Each warning names the
width, the element as CSS names it, and where it is on the page. The result names the screenshots,
`desktop.png` and `phone.png`, each the page's top 4000px, under `.sixb/agent/checks/`. The page's
queries run as the user who asked, so the screenshots show their rows; a query that fails for them
is a warning, and the page is checked with `sixb.query` rejecting.

1. Open both screenshots with `view_file` and look at them as the reader will: does the page read
   well, and do its numbers make sense?
2. Fix what the warnings name and what you see, in the page's files.
3. Publish the next version with `publish_artifact_version`, and check again.

A script error means the page may show nothing at all: fix it first.

## Examples

`examples/page/` holds four finished pages built on the kit:

- `fleet-planner`: scenarios, sliders, a switch, and region chips drive animated stats, an ECharts
  chart of crews needed against crews available, and a table with sparklines. It keeps the
  reader's settings with `sixb.state`.
- `service-explorer`: nine months of service as a calendar heatmap, a zoomable trend, causes, and
  a sortable table; a day picked anywhere fills a panel with every region that day.
- `dispatch-board`: work orders dragged between crews with SortableJS, live capacity meters, a
  skill check on each drop, a filter and search, and auto-assign.
- `collections-desk`: live overdue invoices from `queries/overdue.json`, read with `sixb.query`,
  with loading and error states, stats, and chips and a search that filter the rows in the page.
