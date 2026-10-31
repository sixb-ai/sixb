# Slides

A deck is HTML: one `<section class="slide">` per 1280×720 slide. Sixb adds its kit and runtime to
the page, which lay the slides out, scale them to fit, number them, apply the app's theme and dark
mode, and give the reader previous and next, an overview, and present. Write slides;
do not write navigation, scaling, or slide numbers.

```text
work/q3-review/
├── index.html
├── deck.css          optional, for what the layouts don't cover
└── img/fleet.jpg     images, by relative path
```

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Q3 review</title>
  <link rel="stylesheet" href="deck.css">
</head>
<body>
  <section class="slide title">
    <p class="eyebrow"><span>Q3 2026</span><span>Operations review</span></p>
    <h1>Q3 review</h1>
    <p>Restorations within SLA reached 94% while calls rose 12%</p>
    <p class="source">October 22, 2026</p>
  </section>
</body>
</html>
```

## Layouts

Pick one per slide with a class beside `slide`. Use the layouts before writing CSS.

| Class | For | Holds |
| --- | --- | --- |
| `title` | The opening slide | `.eyebrow`, a short `<h1>` (2 or 3 words), a `<p>` with the takeaway, the date as `.source` |
| `section` | A divider between parts | `.eyebrow`, `<h2>` |
| `stat` | The numbers that matter | `<h2>`, then `<div class="stats">` holding up to 4 of `<div><div class="value">94%</div><div class="label">…</div></div>` |
| `split` | A list beside a figure, a callout, or a table | `<h2>`, then two blocks |
| `chart` | A chart | `<h2>`, `<figure>` with a `.legend` and an inline `<svg>` |
| `table` | Up to about 8 rows | `<h2>`, `<table>`; `class="num"` on number cells |
| `quote` | A customer's or a leader's words | `<blockquote>`, `<cite>` |
| `image` | A photo or a diagram | `<h2>`, `<img>`; `image bleed` fills the slide |

Without a layout class, a slide stacks its heading and content from the top.

Chrome on any slide: `<p class="eyebrow">` above the heading (two `<span>`s inside sit at either
end), and `<p class="source">` for where its numbers come from, in the footer. The footer is a rule
with the source on the left and the slide's number on the right; add `no-number` to a slide to drop
the number.

Inside a slide: `<div class="callout">` sets the one point to remember on a shaded panel,
`<span class="tag">` is a small pill label such as a status, and `class="note"` sets an aside in
smaller, muted text.

## Write

- One idea per slide. Its heading states the takeaway ("Restorations within SLA reached 94%"),
  not the topic ("SLA").
- At most about 40 words on a slide besides its heading. Put detail in a document and link to it.
- Every number has a period and a source: `<p class="source">Field service records, Q3 2026</p>`.
- Nothing smaller than 18px; the kit's sizes already are.
- No emoji as icons, no decorative gradients, glows, or drop shadows.
- 6 to 12 slides for most decks.

## Theme

Colors come from the theme, so a deck follows the app's light and dark mode. Use the variables, not
fixed colors: `--foreground`, `--muted-foreground`, `--background`, `--muted`, `--primary`,
`--border`, `--chart-1` to `--chart-5`, `--font-sans`, `--font-serif`, `--radius`. Only when the
user asks for a look, add `theme.json` (see `document.md`) or set the variables in `deck.css`.

## Charts

Draw a chart as an inline `<svg>` in the slide, colored with the theme's chart variables so it
follows the theme: `fill="var(--chart-1)"`. Draw the series that matters in `--chart-1` and the
others in `--chart-4`; light gridlines in `--border`; axis labels and values in
`--muted-foreground`, at 20px or more. Name two or more series in a legend above the chart:
`<ul class="legend"><li style="--swatch: var(--chart-1)">Restored within SLA</li>…</ul>`. Label the
axes or the bars and give the units.

## Show another artifact

When the numbers live in a published sheet, show its chart or range on the slide instead of
redrawing or retyping them: it is the same chart the sheet draws, and it cannot drift from it.

```html
<section class="slide chart">
  <p class="eyebrow">Service levels</p>
  <h2>Within-SLA rose every quarter, fastest in Q3</h2>
  <sixb-embed src="artifact:art_k3m9q2x7tp#chart=sla-trend" title="SLA trend"></sixb-embed>
  <p class="source">Source: Q3 service metrics</p>
</section>
```

- `<sixb-embed src="artifact:…">` shows a chart (`#chart=…`), a range (`#Regions!A1:D5`, the
  header row and up to a dozen rows fit a slide), a document's section (`#methodology`), or a slide
  of another deck (`#4`). It is a block as wide as its column, 16:9 unless the deck's CSS sizes it;
  in the `chart` layout it takes the slide's height. `title` names it where it is not drawn yet,
  such as in the slide thumbnails.
- `<img src="artifact:…/figures/map.png">` shows an image file of another artifact, laid out like
  any image.
- `<a href="artifact:…">the Q3 numbers</a>` opens the artifact beside the conversation.
- A deck reads the project's objects live with `sixb.query`, as a page does (`page.md`); for a
  chart a live sheet already draws, embed the sheet's chart instead.
- The layout check sees what a slide shows from another artifact as an empty box of its size, and
  the screenshots show it so: it is drawn when the reader opens the deck.

## Check

Publishing refuses a deck without `index.html` or without a `section.slide`.

Once a deck publishes, Sixb lays it out in the sandbox's browser as the reader will see it, with
its `theme.json`, in light and in dark mode or in the one mode it pins, and warns about each
slide that has something past its edge, running
into the footer, drawn over other text, or cut off; text under 18px; text under WCAG AA contrast;
an image that did not load; or an error while the deck loaded. Each warning names the slide, the
element as CSS names it (`p.kicker`), and where it is on the 1280×720 slide. The result names
the screenshots, one per slide, under `$SIXB_CONTEXT_DIR/checks/`.

1. Open the screenshots with `view_file`, at least the slides a warning names, and look at each
   as the reader will: is anything crowded, misaligned, or unreadable?
2. Fix what the warnings name and what you see, in the deck's files.
3. Publish the next version with `publish_artifact_version`, and check again.

Contrast that fails only in dark mode means a fixed color: use the theme's variables. When the
result says the check did not run, read `index.html` slide by slide instead.

## Examples

`examples/slides/` holds two finished decks built from the layouts and classes above, with no CSS
of their own: a quarterly review with a chart, a stat, and a table, and a launch plan with a
timeline, a callout, and a table of owners.
