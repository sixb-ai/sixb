# Canvases

A canvas is an endless board the user pans and zooms: screens side by side with arrows between
them, sections of sticky notes, a diagram. Publish one when the work reads best laid out in two
dimensions.

| The work | Publish |
| --- | --- |
| Visuals side by side: screens, frames, posters, variants, a flow from one to the next | a `canvas` of boards |
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

## Principles

- **A board shows; the canvas annotates.** A board holds the visual alone: a screen, a frame, a
  poster, a diagram. Captions, specs, voice-over, and rationale go in `text` and `note` items
  beside or under it, a `section` groups each set, and arrows give the order. Never put small
  explanatory text inside a board.
- **It reads as it opens.** A canvas opens fitted to everything, so its headings, notes, and
  labels must read at that zoom: an `xl` heading over each group, `l` within it. Lay boards out in
  rows, four or five wide boards at most, so the fitted view isn't tiny. The reader opens a board
  for its detail.
- **Real visuals, or a clean placeholder.** Show real images: one made with
  `sixb models image "…" --model <id> --output work/storyboard/boards/images/03.png`, or a file the
  user attached or the workspace holds, copied into the folder (a copy costs nothing: files are
  stored by their content). Reference it relatively, `<img src="images/03.png">`. Without one, fill
  the frame's area in a neutral tone with one line saying what it shows. Never draw people,
  products, or scenes as hand-made SVG shapes. Make one image per picture, each on its own board,
  never a grid or contact sheet of several in one image: the reader opens each, and its notes sit
  beside it.
- **One visual direction.** For creative work (a storyboard, a poster, a landing page, a
  moodboard), choose one direction you can name: a type pairing (Google Fonts load in boards), a
  ground, and no more than two accents, in `shared.css`. Screens of the project's own app keep the
  kit's look. No filler: a fact you don't have is a visible placeholder, such as `[PRICE]`.

## Items

Every item has an `id` (lowercase letters, digits, and hyphens; it is the item's address, so keep it
across versions) and sits at `x`, `y` in pixels from the canvas's origin, y growing down.

| Type | Keys | For |
| --- | --- | --- |
| `board` | `file`, `w`, `h`, `title` | A screen, a frame, a poster: an HTML file shown live at `w` by `h` |
| `section` | `w`, `h`, `title` | A group's heading: the title draws at the region's top left, and the region is what `#id` frames |
| `note` | `w`, `h`, `text`, `tone` | A sticky note; it grows to hold its text, `h` its least height |
| `text` | `text`, `size`, `w` | A heading, a caption, or a label: `size` `s`, `m`, `l`, or `xl`; `w` wraps it |
| `shape` | `shape`, `w`, `h`, `text`, `tone` | A `rect`, `ellipse`, or `diamond`, for a diagram's steps and decisions |
| `arrow` | `from`, `to`, `label`, `dashed` | From an item's id, or a point `{ "x": 0, "y": 0 }`, to another |
| `embed` | `src`, `w`, `h`, `title` | Another artifact or a part of one: a chart, a range, a slide, a section |

`tone` is `positive`, `warning`, `negative`, `neutral`, or `chart-1` to `chart-5`; a note without
one is amber, as a note pad's, and a `neutral` one is plain paper. Items draw in the order listed.

A canvas holds at most 1,000 items and 100 boards; sizes run from 40 to 8,000 pixels. A version
holds at most 500 files, boards and images included.

## Lay it out

- Boards in a row 80 to 160 pixels apart, 240 when a labeled arrow joins them, so the label reads
  without covering its arrow; rows 160 pixels apart.
- A section for each flow or group, its left edge on the group's: boards and embeds start 120
  pixels below its top, since their names sit above them, and notes or shapes 80. Sections 160
  pixels apart. A heading (`text`, `xl`) above everything says what the canvas is, and a line
  under it (`m`) what it is for; `s` is small print, read close up.
- Arrows for the order of a flow, labeled with what moves the user on: the button, the choice.
  Dashed arrows for asides: a note about a board.
- Notes and captions beside or below a board, never on it: a note over a board covers its page.
- Size boards as their screens are: 390 by 844 for a phone, 1280 by 800 for a laptop, 1440 by 900
  for a wide screen, 1280 by 720 for a video or presentation frame.

## Boards are pages

Each board is a page, run in its own frame: Sixb adds the page kit and the runtime, so `page.md`
applies to it. Its `<title>` is not shown; the board's `title` is. On the canvas a board is a
picture; the reader opens it to scroll and click.

- Design the board for its size: a phone screen fills 390 by 844 and puts its main action at the
  bottom. What runs past the board's height is cut off on the canvas.
- Link a stylesheet the boards share, `<link rel="stylesheet" href="shared.css">`, beside them, so
  every board looks like one piece of work.
- Show what the screen would hold: real labels, names, and numbers, not lorem ipsum or gray boxes.
  A board reads the project's objects live with `sixb.query`, as a page does; for a chart a live
  sheet already draws, embed it.
- Arrows' labels make an opened board clickable: a button, or a `#` link, whose words are the
  label of an arrow leaving the board opens the board it points to. Give the button and the arrow
  the same words, and don't link boards to each other with `href`.

## Check

Publishing refuses a board whose file is not in the canvas, an arrow to an item that does not
exist, and a key it does not know, naming the item. It warns of boards that overlap and of notes or
text on a board.

Once a canvas publishes, Sixb opens each board at its own size in the sandbox's browser, in light
and dark mode or the one its `theme.json` pins, and warns as it does for a page, naming the board.
The result names each board's screenshot, `<id>.png`, and `overview.png`, the whole canvas as it
opens, under `$SIXB_CONTEXT_DIR/checks/`. The check also takes each board's preview, the picture
readers see until they open it, so a board that looks wrong there looks wrong on the canvas too.

1. Open the screenshots with `view_file` and look at each board as the reader will. Open
   `overview.png` to see whether the canvas reads at the zoom it opens at.
2. Fix what the warnings name and what you see, in the boards' files or `canvas.json`.
3. Publish the next version with `publish_artifact_version`, and check again.

## Examples

`examples/canvas/` holds two finished canvases: `onboarding-flow`, three phone screens of an app
with arrows and notes under them, and `retro`, three sections of notes with no boards.
