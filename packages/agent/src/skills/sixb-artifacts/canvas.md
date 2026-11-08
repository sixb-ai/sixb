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
  poster, a diagram, with the words the viewer would see on it, such as an end card's title.
  A label and a one-sentence caption go in `text` items beside or under it, a
  `section` groups each set, and arrows give the order. Never put small explanatory text inside a
  board.
- **Titles and pictures read as it opens.** A canvas opens fitted to everything, so what must
  read at that zoom is its titles and its pictures: size headings for it, `xxl` over each group
  when boards are full-size screens or frames, `xl` on a small canvas, and check `overview.png`.
  Notes and captions are read when the reader zooms in to a row: keep them short, beside their
  board. Rows of four or five wide boards at most.
- **Real visuals, or a clean placeholder.** Show real images: one made with
  `sixb models image "…" --model <id> --output work/storyboard/boards/images/03.png`, or a file the
  user attached or the workspace holds, copied into the folder (a copy costs nothing: files are
  stored by their content). Reference it relatively, `<img src="images/03.png">`. When the project
  has an image model, every scene, shot, or product shown gets its image: a storyboard of seven
  shots is seven images, the work the user asked for. A placeholder is for a project without one,
  or a wireframe the user asked for: the frame's area in a neutral tone with one line saying what
  it shows. Never draw people, products, or scenes as hand-made SVG shapes. Make one image per
  picture, each on its own board, never a grid or contact sheet of several in one image: the
  reader opens each, and its notes sit beside it.
- **One visual direction.** For creative work (a storyboard, a poster, a landing page, a
  moodboard), choose one direction you can name: a type pairing (Google Fonts load in boards), a
  ground, and no more than two accents, in `shared.css`. Screens of the project's own app keep the
  kit's look. No filler: a fact you don't have is a visible placeholder, such as `[PRICE]`.

## Craft

A canvas is judged as a keynote slide is: in the first second, from far out. Make what a senior
product designer would present.

- **One grid.** Choose a column and a gutter and set everything on them: the boards of a row share
  a size and a top edge, captions start on their board's left edge, groups align left. The same
  gap means the same relation everywhere.
- **A whole shaped for the screen.** The canvas opens fitted to everything in a wide window: lay it
  out as one wide block, about 16 by 10, not a tall column, and leave nothing alone in a corner.
- **Three levels of words.** The title (`xxl`), and under it, clear of it by half its height, one
  line a size down (`xl`) saying what the canvas is for; a short label per board (`l`), such as
  `01  Dawn at the depot`; a caption (`m`) of one sentence. The first row starts one title height
  below that line, not further. Anything longer, such as specs, a shot list, or guidelines, is a board of its
  own designed as a page, never a long note or paragraph on the canvas.
- **Notes are working material.** Sticky notes are for a brainstorm, open questions, review. A
  finished piece is annotated with `text`: coloured notes make a deliverable look like a draft.
  When notes are there, a tone means one thing across the canvas, or they all keep one.

Boards:

- Typography carries the design: one family or a deliberate pairing, a scale with clear steps,
  display sizes set tight (-0.02em to -0.04em), body at 1.5. Size words for the board: a 1280-wide
  frame's title is 72 to 120 px and its smallest words 20 px; a phone screen's body 15 to 17 px.
- Margins of at least a twentieth of the board's width, and room around every group.
- Restraint: a quiet ground and one accent with one job. No colour bands, decorative gradients,
  boxes around everything, drop shadows, or emoji.
- Images fill their frame (`object-fit: cover`), never letterboxed or stretched; words over an
  image sit on its quiet part, with a scrim only when they must.

Images, as one set: write one look line (camera and lens, light, grade, palette, mood) and end
every prompt with it; describe a recurring person, place, or product in the same words each time;
ask for the frame's aspect and no text or logos, since words are set in HTML.

## Items

Every item has an `id` (lowercase letters, digits, and hyphens; it is the item's address, so keep it
across versions) and sits at `x`, `y` in pixels from the canvas's origin, y growing down.

| Type | Keys | For |
| --- | --- | --- |
| `board` | `file`, `w`, `h`, `title` | A screen, a frame, a poster: an HTML file shown live at `w` by `h` |
| `section` | `w`, `h`, `title` | A group's heading: the title draws at the region's top left, and the region is what `#id` frames |
| `note` | `w`, `h`, `text`, `tone` | A sticky note; it grows to hold its text, `h` its least height |
| `text` | `text`, `size`, `w` | A heading, a caption, or a label: `size` `s`, `m`, `l`, `xl`, or `xxl`; `w` wraps it |
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
  pixels apart. A heading (`text`, `xxl` over full-size boards, `xl` on a small canvas) above
  everything says what the canvas is, and a line under it (`m`) what it is for; `s` is small
  print, read close up.
- Arrows for the order of a flow, labeled with what moves the user on: the button, the choice.
  Dashed arrows for asides: a note about a board. An arrow joins neighbours in a row; a sequence
  that wraps reads on from the start of the next row, with no arrow crossing back over the notes.
- Notes and captions beside or below a board, never on it: a note over a board covers its page.
- Size boards as their screens are: 390 by 844 for a phone, 1280 by 800 for a laptop, 1440 by 900
  for a wide screen, 1280 by 720 for a video or presentation frame. A board's `w` and `h` are its
  page's size, never smaller to fit the layout: the canvas zooms out to show it small, and a page
  larger than its board is cut off.

## Boards are pages

Each board is a page, run in its own frame: Sixb adds the page kit and the runtime, so `page.md`
applies to it. Its `<title>` is not shown; the board's `title` is. On the canvas a board is a
picture; the reader opens it to scroll and click.

- Design the board for its size: a phone screen fills 390 by 844 and puts its main action at the
  bottom. What runs past the board's height is cut off on the canvas.
- The kit's `<main>` is a column with room around it. A board that is a picture edge to edge, such
  as a film frame or a poster's photograph, puts it straight in `<body>`, not in `<main>`:

  ```html
  <body style="margin:0"><img src="images/03.png" alt="Maya opens the rooftop unit"
    style="display:block;width:100vw;height:100vh;object-fit:cover"></body>
  ```
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
   `overview.png` to see whether the canvas reads at the zoom it opens at, and judge it as a
   designer would: one composition on one grid, words at three levels, nothing that looks like a
   default or a draft.
2. Fix what the warnings name and what you see, in the boards' files or `canvas.json`.
3. Update the artifact with `update_artifact`, and check again.

## Examples

`examples/canvas/` holds two finished canvases: `onboarding-flow`, three phone screens of an app
with arrows and notes under them, and `retro`, three sections of notes with no boards.
