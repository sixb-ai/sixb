# References

An artifact can show or link to another one by its address, so a report shows the chart its sheet
draws and stays current when the sheet changes.

```text
artifact:<id>[@<version>][/<file>][#<part>]
```

| Address | Points at |
| --- | --- |
| `artifact:art_k3m9q2x7tp` | The artifact, at its latest version |
| `artifact:art_k3m9q2x7tp@2` | Version 2, which never changes |
| `artifact:art_k3m9q2x7tp/figures/revenue.svg` | A file inside it |
| `artifact:art_k3m9q2x7tp#Summary` | A sheet |
| `artifact:art_k3m9q2x7tp#Summary!A1:D6` | A range of a sheet; row 1 is the header row |
| `artifact:art_k3m9q2x7tp#chart=revenue` | A chart in a workbook |
| `artifact:art_k3m9q2x7tp#methodology` | A document's section |
| `artifact:art_k3m9q2x7tp#4` | A deck's slide 4 |

Copy addresses from `$SIXB_ARTIFACTS`: each artifact lists its `address` and the `parts` it has,
each with two addresses written out:

- `address` follows the artifact's latest version. Use it in a document, a sheet, or a deck, which
  you revise as the artifact changes.
- `pinned` names the version you read, such as `artifact:art_k3m9q2x7tp@2#chart=revenue`. Use it in
  a reply: a reply's words describe that version, so what it shows must stay that version.

In a Markdown link, write a space as `%20`: `artifact:art_k3m9q2x7tp#Q3%20numbers!A1:D6`.

## Show or link

| In | Show it in place | Link to it |
| --- | --- | --- |
| A document | `![Revenue by quarter](artifact:…#chart=revenue)` | `[the methodology](artifact:…#methodology)` |
| A reply | `![Revenue by quarter](artifact:…@2#chart=revenue)` | `[the methodology](artifact:…@2#methodology)` |
| A deck or a page | `<sixb-embed src="artifact:…#chart=revenue"></sixb-embed>`, or `<img src="artifact:…/figure.png">` for a file | `<a href="artifact:…#methodology">the methodology</a>` |
| A sheet | An `image` column cell holding the address | A `link` column cell holding the address |

- Show a chart or a range when the reader needs to see it there. Link when they only need to know
  where it is.
- When the numbers are in a published sheet, show its range instead of retyping them in a Markdown
  table: the range cannot drift from the sheet. A live sheet's chart or range shows each reader
  their own rows, so a document that shows it stays current too. Asked for "the first three regions as a table",
  show `artifact:…@2#Regions!A1:D4`, the header row and three rows.
- The text in `![…]` is the caption under what it shows. Say what the figure shows, not "Chart".
- In a reply, show at most one chart or a range of about a dozen rows. Publish anything larger and
  link to it.
- A page shown in a document or a reply (`![Fleet planner](artifact:…)`) runs live at the width of
  the text, as tall as it lays out up to 800px, then scrolls. Show one the reader works with there,
  such as a small calculator; link to a page that needs the whole window.
- Something shown inside a shown artifact appears as a link: one level shows in place.

## Keep addresses working

An address names a sheet, a chart, or a section by name, so a new version that renames one moves
its address:

- A chart's `name` is its address. Keep it the same in every version; to rename what readers see,
  change its `title`.
- Renaming a sheet or editing a heading moves its address too. Do it only when the user asks.

## When an address breaks

Publishing refuses an address that resolves to nothing and says what the target has instead: fix
the address and publish again. When a new version renames or removes something another artifact
shows, it publishes with a warning naming that artifact: publish that artifact's next version with
an address that resolves.
