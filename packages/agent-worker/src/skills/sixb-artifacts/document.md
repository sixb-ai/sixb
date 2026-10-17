# Documents

A document is Markdown in `document.md`, with its images beside it. The app renders it as a page:
a title and lede, a measured column, an outline of its sections, and figures, callouts, and tables
set for reading.

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
URLs and `data:` URIs are refused. SVG and PNG work best. Draw charts in fixed colors that read on
both light and dark pages, and label the axes and units.

## Numbers

- Give units and periods: "$2.14M in Q3", "94% of priority visits".
- Show negatives one way per table, either `-3.2%` or `(3.2%)`.
- Say where each figure comes from, in the text or a footnote.

## Theme

A document takes the app's theme, light and dark. Only when the user asks for a look, add
`theme.json` at the artifact's root:

```json
{ "mode": "light", "tokens": { "--primary": "#0f766e", "--font-serif": "Georgia, serif" } }
```

`mode` pins light or dark. `tokens` may set `--background`, `--foreground`, `--card`,
`--card-foreground`, `--muted`, `--muted-foreground`, `--primary`, `--primary-foreground`,
`--accent`, `--accent-foreground`, `--border`, `--chart-1` to `--chart-5`, `--font-sans`,
`--font-serif`, `--font-mono`, and `--radius`. Colors are hex, `rgb()`, `hsl()`, or `oklch()`;
fonts are family names; `--radius` is a length such as `6px`.

## Examples

`examples/document/` holds two finished documents to start from: an operations review with a figure
and a table, and an incident report with a timeline and follow-ups.
