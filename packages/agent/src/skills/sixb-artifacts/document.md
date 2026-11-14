# Documents

A document is Markdown in `document.md`, with its images beside it. The app renders it as a page:
a title and lede, a measured column, an outline of its sections, and figures, callouts, and tables
set for reading.

A document that needs a design of its own, such as a proposal, a contract, a letter on letterhead,
or a report in a company's style, is HTML in `document.html` instead: see Designed documents below.
Everything else is Markdown.

## Structure

- Start with one `#` heading: the title. The paragraph after it is the lede. State the conclusion
  there in one or two sentences.
- Use `##` for sections and `###` for subsections; together they form the outline. Do not skip a
  level, and do not use a heading for emphasis.
- When a section has one point, its heading states it ("Costs held flat while volume rose 12%")
  rather than naming a topic ("Costs").
- Keep paragraphs short. Lead with the finding, then the evidence.

## Markdown

GitHub-flavored Markdown: tables, task lists, strikethrough, autolinks, footnotes (`[^1]`), and
fenced code blocks with a language. Raw HTML is not rendered.

| Write | It renders as |
| --- | --- |
| `> [!NOTE]` as the first line of a quote | A callout. Also `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` |
| `![Alt text](figures/chart.svg "Figure 1. Caption")` alone in a paragraph | A figure with its caption |
| A table column of numbers | Right-aligned, with tabular figures |
| `[the risks](#risks)` | A link to that section |

Use one or two callouts in a document, for what the reader must not miss.

## Images

An image is a file in the artifact, referenced by its relative path: `figures/revenue.svg`. Remote
URLs and `data:` URIs are refused. To show a chart or a table that lives in a sheet, show it by its
address instead of drawing a copy: `![Revenue by quarter](artifact:…#chart=revenue)`. It stays
current when the sheet changes; `references.md` has the addresses. SVG and PNG work best. Draw charts in fixed colors that read on
both light and dark pages, and label the axes and units.

## Numbers

- Give units and periods: "$2.14M in Q3", "94% of priority visits".
- Show negatives one way per table, either `-3.2%` or `(3.2%)`.
- Say where each figure comes from, in the text or a footnote.

## Theme

A Markdown document takes the app's theme, light and dark. Only when the user asks for a look, add
`theme.json` at the artifact's root:

```json
{ "mode": "light", "tokens": { "--primary": "#0f766e", "--font-serif": "Georgia, serif" } }
```

`mode` pins light or dark. `tokens` may set `--background`, `--foreground`, `--card`,
`--card-foreground`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`,
`--accent`, `--accent-foreground`, `--border`, `--chart-1` to `--chart-5`, `--font-sans`,
`--font-serif`, `--font-mono`, and `--radius`. Colors are hex, `rgb()`, `hsl()`, or `oklch()`;
fonts are family names; `--radius` is a length such as `6px`.

## Designed documents

Write one when the user asks for a document that should look like a business's own, or a project
skill gives you a design or a template for it. It renders exactly as its stylesheets say, on white
paper, in the app and as the pages it prints on.

```text
work/proposal/
├── document.html     the document: semantic HTML, no document.md beside it
├── design.css        its design, linked with <link rel="stylesheet" href="design.css">
├── fonts/            @font-face files, when the design names a font
└── images/           logos, figures, screenshots
```

- **Paper.** Give the stylesheet an `@page` rule with a size and the margins:
  `@page { size: letter; margin: 0.75in 0.85in; }` (or `A4`, or two lengths). That is what makes
  pages: the reader sees them, and the layout check shoots each one. Keep the margins there, not on
  `<body>`, and give `<body>` no width, margin, or padding of its own.
- **Markup.** Any HTML that lays out text, tables, figures, and pictures, styled by any CSS: grids,
  columns, `::before` numbering, `<svg>`. No scripts, `on…` handlers, `<iframe>`, `<form>`, or
  `<base>`: publishing refuses them. Images are files in the artifact (or another artifact's,
  `artifact:<id>/<path>`); stylesheets are files in the artifact or Google Fonts.
- **Style by class**, not by `body > …`: as pages, the body's content is moved into the flow that
  is cut into pages, so a selector on the body's children stops matching.
- **Pages break where you say.** `break-before: page` starts a section on a new page;
  `break-inside: avoid` keeps a table row, a figure, or the signature block whole; `thead { display:
  table-header-group; }` repeats a table's header on each page it runs onto. Nothing may be wider
  than the space between the margins.
- **Phones.** On a phone it shows as one sheet at the screen's width, with your CSS. Stack every
  multi-column grid in `@media (max-width: 600px) { … }`, and size images with `max-width: 100%`,
  so nothing runs off the side; print never reaches that width.
- **Type in points**, as print is: body text around 10pt, labels no smaller than 6.5pt.
- **Headings** `h1`–`h3` make the outline and the sections an address can name, as in Markdown.
- **A project's design** comes as files in a project skill: copy its stylesheet, fonts, and images,
  or its template, into your directory, and write the content into it. Never link to the skill's
  folder: a version holds everything it shows, so a later change to the design never changes a
  document already sent.

After publishing, open each `page-NN.png` the check returns: look at where each page breaks, for
anything cut off at a page's edge, and for a page left nearly empty. Open `phone.png` too, for
anything running off the side, then fix and update.

## Examples

`examples/document/` holds three finished documents to start from: an operations review with a
figure and a table, an incident report with a timeline and follow-ups, and `service-proposal`, a
designed document on Letter paper: a cover, sections that each start a page, a timeline, pricing
tables, and a signature block.
