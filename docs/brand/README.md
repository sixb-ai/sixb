# README artwork

| File | What it is |
| --- | --- |
| `hero-{light,dark}.svg` | The header animation: a project is created, a `Quote` is defined, and the same quote shows up in the app, the agent and the CLI, over the homepage hero's mosaic (`src/components/hero/` on the website) |
| `how-it-works-{light,dark}.png` | The stack from the Why Sixb page (`src/components/why/stack/`), beside the four steps |

The header is an animated SVG: CSS keyframes on one 10.5-second loop, so it stays sharp at any
size and weighs about 70 KB. The mosaic sharpens once while the model is written; everything else
loops. Text uses the reader's system fonts, and with reduced motion it shows the finished frame. Its
code and terminal output are real: the `Quote` definition type-checks, and the terminal shows what
`bun create sixb` prints.

The stack is exported at 1280 CSS pixels wide and 1.5× density, set in ABC Diatype. It follows the
README's code: its proposal is a quote, and it shows systems Sixb has connectors for, Pipedrive where
the website draws Salesforce and PandaDoc where it writes back to DocuSign.

Dark images are transparent so they sit on any of GitHub's dark themes; light ones are white,
because readers that ignore `<picture>` show them on any background. Keep the filenames when
replacing either, so the README continues to follow the reader's theme.

The wordmarks are the Sixb logo in black and white, as SVG and PNG.
