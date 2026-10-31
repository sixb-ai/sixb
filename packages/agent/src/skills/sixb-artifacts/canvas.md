# Canvases

A canvas is an endless board the user pans and zooms: screens side by side with arrows between
them, sections of sticky notes, a diagram. Publish one when the work reads best laid out in two
dimensions.

| The deliverable | Publish |
| --- | --- |
| Several screens or variants of a design, a flow from one to the next | a `canvas` of boards |
| A brainstorm, an affinity map, a retro | a `canvas` of sections and notes |
| A process or a decision drawn as boxes and arrows | a `canvas` of shapes and arrows |
| One web app or dashboard | a `page` |
| A report, a deck, a table | a `document`, `slides`, a `sheet` |

```text
work/onboarding-flow/
├── canvas.json
└── boards/
    ├── welcome.html     a board: a page shown at its size on the canvas
    ├── region.html
    └── shared.css       styles every board links to
```

```json
{
  "items": [
    { "id": "heading", "type": "text", "x": 0, "y": -300, "text": "Field app onboarding", "size": "xl" },
    { "id": "first-run", "type": "section", "x": 0, "y": -120, "w": 1020, "h": 964, "title": "First run" },
    { "id": "welcome", "type": "board", "file": "boards/welcome.html", "x": 0, "y": 0, "w": 390, "h": 844, "title": "Welcome" },
    { "id": "region", "type": "board", "file": "boards/region.html", "x": 630, "y": 0, "w": 390, "h": 844, "title": "Choose a region" },
    { "id": "to-region", "type": "arrow", "from": "welcome", "to": "region", "label": "Get started" },
    { "id": "skip", "type": "note", "x": 630, "y": 1010, "w": 300, "text": "Skip this screen when GPS finds a depot?" }
  ]
}
```

## Items

Every item has an `id` (lowercase letters, digits, and hyphens; it is the item's address, so keep it
across versions) and sits at `x`, `y` in pixels from the canvas's origin, y growing down.

| Type | Keys | For |
| --- | --- | --- |
| `board` | `file`, `w`, `h`, `title` | A screen, a mockup, a poster: an HTML file shown live at `w` by `h` |
| `section` | `w`, `h`, `title` | A group's heading: the title draws at the region's top left, and the region is what `#id` frames |
| `note` | `w`, `h`, `text`, `tone` | A sticky note; it grows to hold its text, `h` its least height |
| `text` | `text`, `size`, `w` | A heading or a label: `size` `s`, `m`, `l`, or `xl`; `w` wraps it |
| `shape` | `shape`, `w`, `h`, `text`, `tone` | A `rect`, `ellipse`, or `diamond`, for a diagram's steps and decisions |
| `arrow` | `from`, `to`, `label`, `dashed` | From an item's id, or a point `{ "x": 0, "y": 0 }`, to another |
| `embed` | `src`, `w`, `h`, `title` | Another artifact or a part of one: a chart, a range, a slide, a section |

`tone` is `positive`, `warning`, `negative`, `neutral`, or `chart-1` to `chart-5`; a note without
one is amber, as a note pad's, and a `neutral` one is plain paper. Items draw in the order listed.
A canvas opens fitted to everything, so lay it out to read whole.

A canvas holds at most 500 items and 40 boards; sizes run from 40 to 8,000 pixels.

## Lay it out

- Boards in a row 80 to 160 pixels apart, 240 when a labeled arrow joins them, so the label reads
  without covering its arrow; rows 160 pixels apart.
- A section for each flow or group, its left edge on the group's: boards and embeds start 120
  pixels below its top, since their names sit above them, and notes or shapes 80. Sections 160
  pixels apart. A heading (`text`, `xl`) above everything says what the canvas is, and a line
  under it (`m`) what it is for; `s` is small print, read close up.
- Arrows for the order of a flow, labeled with what moves the user on: the button, the choice.
  Dashed arrows for asides: a note about a board.
- Notes beside or below a board, never on it: a note over a board covers its page.
- Sizes boards as their screens are: 390 by 844 for a phone, 1280 by 800 for a laptop, 1440 by 900
  for a wide screen.

## Boards are pages

Each board is a page, run in its own frame: Sixb adds the page kit and the runtime, so `page.md`
applies to it. Its `<title>` is not shown; the board's `title` is. On the canvas a board is a
picture; the reader opens it to scroll and click.

- Design the board for its size: a phone screen fills 390 by 844 and puts its main action at the
  bottom. What runs past the board's height is cut off on the canvas.
- Link a stylesheet the boards share, `<link rel="stylesheet" href="shared.css">`, beside them, so
  every screen of an app looks like one app.
- Show what the screen would hold: real labels, names, and numbers, not lorem ipsum or gray boxes.
  A board reads the project's objects live with `sixb.query`, as a page does; for a chart a live
  sheet already draws, embed it.
- Boards don't link to each other; arrows show the flow.

## Check

Publishing refuses a board whose file is not in the canvas, an arrow to an item that does not
exist, and a key it does not know, naming the item. It warns of boards that overlap and of notes or
text on a board.

Once a canvas publishes, Sixb opens each board at its own size in the sandbox's browser, in light
and dark mode or the one its `theme.json` pins, and warns as it does for a page, naming the board.
The result names each board's screenshot, `<id>.png`, under `$SIXB_CONTEXT_DIR/checks/`.

1. Open the screenshots with `view_file` and look at each board as the reader will.
2. Fix what the warnings name and what you see, in the boards' files or `canvas.json`.
3. Publish the next version with `publish_artifact_version`, and check again.

## Examples

`examples/canvas/` holds two finished canvases: `onboarding-flow`, three phone screens of an app
with arrows and notes under them, and `retro`, three sections of notes with no boards.
