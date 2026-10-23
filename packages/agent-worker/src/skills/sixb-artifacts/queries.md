# Queries

A query reads the project's objects each time the artifact is opened, as whoever opens it: they see
the rows they may view, and a value they are not cleared for shows locked. Data from the project
goes in a query, not a copy, so the artifact stays current: a sheet shows its rows (`sheet.md`, Live
rows).

## Write one

A query is a file `queries/<name>.json` in the artifact's directory, holding what `sixb objects
query --file` runs. Read `sixb objects query --help` for the nodes and predicates, and a type's
file under `$SIXB_ONTOLOGY_DIR` for its properties, links, and which ones a query may filter or
sort by.

```text
work/overdue/
├── workbook.json
└── queries/
    └── overdue.json
```

```json
{
  "kind": "expand",
  "expansions": [{ "linkId": "customer", "direction": "outgoing" }],
  "input": {
    "kind": "filter",
    "input": { "kind": "start", "objectTypeId": "Invoice" },
    "predicate": { "op": "eq", "propertyId": "status", "value": "overdue" }
  }
}
```

- Name it for what it returns, in lowercase letters, digits, and hyphens: `overdue`,
  `open-cases`. A sheet names it in `"query"`.
- Run it before publishing: `sixb objects query --file work/overdue/queries/overdue.json`. It
  returns what the artifact will show you; a reader with other rights sees other rows.
- `expand` adds a linked object's properties to each row, such as the customer's name: a sheet's
  `"from": "customer.name"` reads it.
- Bound it with `limit`, `filter`, and `sort`, not `page`: Sixb pages it, up to 10,000 rows.
  `vector` and `rerank` are refused, since every reader would pay for the search.
- A version holds up to 20 queries. Publishing runs each one as the user who asked, and refuses
  one they could not run.

## When to copy instead

Write the values into the artifact, a CSV for a sheet, when they are not the project's live data:

- A snapshot the user asked for: "as of September 30", "the numbers we presented". Say in the
  title or a description that it is a snapshot, and of when.
- Data from the web, a file the user attached, or a tool's output.
- A computation a query and a sheet's formulas can't do, over more rows than you can copy: copy the
  result, and say what it was computed from.
