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
axes or the bars and give the units. When the
numbers live in a published sheet, also link to it: `<a href="artifact:…">the Q3 numbers</a>`
opens it beside the conversation. A deck cannot show another artifact in place yet.

## Check

Publishing refuses a deck without `index.html` or without a `section.slide`. Open `index.html`
and read each slide before you publish.

## Examples

`examples/slides/` holds two finished decks built from the layouts alone: a quarterly review with a
chart, a stat, and a table, and a launch plan with a timeline and a quote.
