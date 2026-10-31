# Sheets

A sheet is tabular data the reader explores: a grid with typed columns, one or more sheets, and
charts the app draws from them. The reader sorts columns, selects a range to see its sum and
average, copies cells, and downloads each sheet as CSV. Publish one for metrics, lists, trackers,
and exports. A column can compute from the others, as an Excel table's does. When the user asked for
an `.xlsx`, or needs formulas across cells rather than columns, publish a `file` instead.

## Layout

A sheet is a directory: `workbook.json`, and one CSV per sheet under `sheets/`, named for the sheet.
A sheet of the project's data reads its rows from a query instead, and has no CSV (Live rows).

```text
work/service-metrics/
├── workbook.json
└── sheets/
    ├── Quarters.csv
    └── Regions.csv
```

## Values

Each CSV is UTF-8. Its first line names the columns, and each name is unique. Quote a field that
holds a comma, a quote, or a line break, and double a quote inside one: `"Harbor Point, ""B"""`.

Write values raw. The workbook formats them in the reader's locale:

| Type | Write | Shows as |
| --- | --- | --- |
| `number` | `1284` or `-3.5` | 1,284 |
| `currency` | `182400` | $182,400 |
| `percent` | `0.961`, a fraction | 96.1% |
| `date` | `2026-09-30`, or an ISO 8601 date and time | Sep 30, 2026 |
| `link` | `https://example.com/cases/4182`, or an `artifact:` address | example.com/cases/4182 |
| `image` | `photos/unit-7.jpg`, a file in the artifact, or an `artifact:` address | A thumbnail |
| `boolean` | `true` or `false` | A checkbox |
| `tag` | A short label from a small set: `Late`, `On track` | A chip, in its tone |
| `text` | Anything | As written |

- No symbols, thousands separators, or units in numbers: `4120000`, not `$4.12M` or `4,120,000`.
  Put the unit in the column name: `Lead time (weeks)`.
- An empty cell is a gap; it is not drawn as zero.
- One row per record. Leave out total rows, notes, and blank rows: a chart would plot a total as
  one more record. Give the sheet `totals` instead.

A sheet holds at most 200 columns and 100,000 rows; a workbook, 20 sheets and 10 charts.

## workbook.json

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
        "Parts cost": { "type": "currency", "currency": "USD", "compact": true }
      },
      "widths": { "Region": 140 },
      "descriptions": { "Within SLA": "Priority calls restored inside the agreed time." },
      "totals": { "Visits": "sum", "Within SLA": "average", "Parts cost": "sum" }
    }
  ],
  "charts": [
    { "name": "sla", "type": "bar", "sheet": "Regions", "x": "Region", "y": "Within SLA", "title": "Within SLA by region" }
  ]
}
```

| Key | Means | Default |
| --- | --- | --- |
| `name` | The sheet's tab, and its file: `sheets/<name>.csv` | Required |
| `columns` | A type for each column by name, or `{ type, currency, decimals, compact, signed, tones, highlight }` | Text |
| `frozenRows` | Rows that stay in view while scrolling, header included, 0 to 10 | 1 |
| `frozenColumns` | Columns that stay in view while scrolling sideways, 0 to 5 | 0 |
| `widths` | Column widths in pixels, 40 to 800 | Fitted to the values |
| `descriptions` | What a column means, by name, at most 300 characters; shown on its header | None |
| `totals` | A row pinned under the sheet: `sum`, `average`, `min`, or `max` of a numeric column, or `count` of any column's values | None |

A tag column names its colors in `tones`, by value: `positive`, `warning`, `negative`, or
`neutral` for what a status means, or `chart-1` to `chart-5` for categories. A value not named is
neutral. Use a tag for a status or a category, not for free text.

`highlight` shades a number, currency, or percent column by value, across the whole column:
`bars` draws a bar in each cell from zero, for amounts to compare at a glance; `scale` shades from
light to dark, for rates and scores; `diverging` shades positive values green and negative ones
red, for changes and variances. Highlight the one or two columns the reader should scan, not
every column.

```json
"Status": { "type": "tag", "tones": { "Late": "negative", "At risk": "warning", "On track": "positive" } },
"Revenue": { "type": "currency", "highlight": "bars" },
"Change": { "type": "percent", "signed": true, "highlight": "diverging" }
```

`currency` is an ISO 4217 code and defaults to USD. `decimals` is 0 to 6; without it a column shows
the decimals its values need. `compact: true` shows a number or currency short, `$4.1M` or `12K`,
for large amounts read at a glance. `signed: true` shows `+` on positive values, for changes and
variances. Sheets appear in the order listed. Freeze the first column when it names each row and
the sheet is wider than a screen.

Totals cover the rows the reader sees, so a filter changes them, and the first column without a
total reads "Total". Describe a column whose name alone could be read two ways: how it is
counted, what it includes, its source.

## Computed columns

A column with a `formula` computes each row from the others, as a column of an Excel table does.
Name it in the CSV header and leave its values empty: the formula fills them, and the reader sees
the formula in the formula bar.

```json
"Margin": { "type": "percent", "decimals": 1, "formula": "([@Revenue]-[@Cost])/[@Revenue]" }
```

| Write | Means |
| --- | --- |
| `[@Revenue]` | This row's Revenue |
| `[@[Lead time (weeks)]]` | A name with spaces, brackets, or symbols, bracketed again |
| `[Revenue]` | The whole column, only inside `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`: `[@Revenue]/SUM([Revenue])` |
| `"Late"`, `12.5`, `TRUE` | Text in double quotes, numbers, booleans |

- Operators: `+ - * / ^`, `&` joins text, and `= <> < <= > >=` compare.
- Functions: `IF`, `IFERROR`, `AND`, `OR`, `NOT`, `ISBLANK`, `ROUND`, `ABS`, `MIN`, `MAX`, `SUM`,
  `AVERAGE`, `COUNT`, `LEN`, `LOWER`, `UPPER`, `CONCAT`, `YEAR`, `MONTH`, `DAYS`. Nothing that
  changes by itself, such as `TODAY`: a version computes the same values forever.
- It computes as Excel does, and the `.xlsx` download keeps each cell's formula: an empty cell
  reads as 0, or as empty text with `&`. Use `IF(ISBLANK([@Cost]),"",…)` where a blank should stay
  blank.
- A division by zero shows `#DIV/0!` and text where a number belongs `#VALUE!`. Publishing warns
  with the rows that do; `IFERROR([@Cost]/[@Revenue],"")` gives them a value.
- The formula's result must fit the column's type: a number in a number, currency, or percent
  column, a date in a date column (`[@Opened]+30`), true or false in a boolean one; anything in
  text.

Compute what follows from other columns: margins, shares, ratios, differences, days between dates,
flags. Write values the source gives, and totals in `totals`, not in a computed column.

## Charts

The app draws each chart from its sheet, in the theme's colors, beside the grid and in its own tab.
Do not draw chart images for a sheet.

| Key | Means |
| --- | --- |
| `name` | Lowercase letters, digits, and hyphens: `revenue`. It is the chart's address: keep it in every version, and change `title` to rename the chart |
| `type` | `line` for a trend over time, `bar` to compare categories, `area` for parts of a total over time, `pie` for the share of a whole, `scatter` for how two numbers move together, a point per row |
| `sheet` | The sheet it plots |
| `x` | The column along the x axis, or a pie's slice labels; a number column for a scatter |
| `y` | A column to plot, or a list of up to five; each is a number, currency, or percent column |
| `line` | A bar chart's columns drawn as lines over its bars: a rate over amounts. A line of another type than the bars reads on a right axis |
| `aggregate` | `sum` or `average` of `y` for each `x` value, or `count` of rows with no `y`: charts raw rows, such as one per job, by region |
| `title` | What it shows, at most 120 characters: `Service revenue by quarter` |
| `stacked` | `true` stacks a bar or area chart's series |

A pie has one `y` column and at most five rows, or five `x` values when it aggregates. Series in one
chart share an axis, so plot columns of the same type and scale together; a bar chart's `line`
columns of another type share one right axis, so give them one type. Bars and lines together plot at
most five columns.

```json
{ "name": "revenue-margin", "type": "bar", "sheet": "Quarters", "x": "Quarter", "y": "Revenue", "line": "Margin" },
{ "name": "jobs-by-region", "type": "bar", "sheet": "Jobs", "x": "Region", "aggregate": "count" },
{ "name": "cost-visits", "type": "scatter", "sheet": "Regions", "x": "Visits", "y": "Parts cost" }
```

## Live rows

A sheet of the project's objects reads its rows from one of the artifact's queries
(`queries.md`), each time it is opened, as whoever opens it. Make a sheet of project data live
unless the user asked for a snapshot. A live sheet has no `sheets/<name>.csv`: it names its query in
`"query"`, and each column the property it shows in `"from"`.

```json
{
  "name": "Overdue",
  "query": "overdue",
  "columns": {
    "Invoice": { "from": "number" },
    "Customer": { "from": "customer.name" },
    "Amount": { "from": "amount", "type": "currency" },
    "Paid": { "from": "paid", "type": "currency" },
    "Due": { "from": "dueDate" },
    "Outstanding": { "type": "currency", "formula": "[@Amount]-[@Paid]" }
  },
  "totals": { "Amount": "sum" }
}
```

- The columns are those `columns` lists, in its order. Each has `from`, a property of the rows, or
  `<link>.<property>` of a link the query expands, or a `formula`; not both. Name columns with a
  letter first: JSON puts a name of digits, such as `2024`, before the others.
- Without `type`, a column takes its property's: numbers, dates, true or false, an enum as a tag,
  anything else as text. Give `type` for what the property doesn't say, such as `currency` or
  `percent`, and any format key a CSV sheet's column takes.
- Totals, charts, highlights, and formulas work as on any sheet. A link that reaches several objects
  shows their values joined by commas.
- A value the reader is not cleared for shows locked, as does a total over it. A live sheet is not
  edited in the app: change its query or columns, and publish its next version.
- The sheet shows up to 10,000 rows, and says when there were more: filter or limit the query.
- Publishing refuses a `from` its query's rows don't hold, such as a link the query doesn't
  expand, and a facets query: a sheet shows rows.

## Check before publishing

Open each CSV and check its header and a few rows. A refusal names the file, row, and column to fix:

```text
'sheets/Regions.csv' row 3, column 'Within SLA': "93.4%" is not a number: write a percent as a fraction, such as 0.351 for 35.1%.
```

## Examples

`examples/sheet/` holds three finished workbooks to start from: service metrics with two sheets,
totals, descriptions, compact and signed numbers, a computed margin, and line, bar, bar-and-line,
and scatter charts; a parts
inventory with a frozen first column, a status tag, bars, a checkbox, dates, links, a pie, and a
chart that counts rows by category; and overdue invoices, a live sheet of the project's invoices
with their customer, a computed balance, and a chart that sums it by customer.
