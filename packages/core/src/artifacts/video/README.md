# A video's composition

A `video` artifact's version is a [HyperFrames](https://hyperframes.heygen.com) project, unchanged:

```text
index.html          the root composition, and one host per scene
scenes/<id>.html    a <template> holding the scene's composition
media/<name>        what the scenes play
```

`composition.ts` reads it the way HyperFrames resolves it. Publishing checks a version with it
(`publish/validate/video.ts`), and the app's player and editor will read it in the browser, so it
runs on parse5 alone: no `HTMLRewriter`, no Node or Bun API. `browser-entries.e2e.ts` holds it to
that.

## Reading it

1. `parseVideoRoot(index.html)` finds the root composition: the first element with
   `data-composition-id`, or the one with `data-root="true"`. Its hosts are the elements with
   `data-composition-src` whose nearest composition is the root. Each host writes its scene's start
   and length, so the whole timeline resolves here, from `index.html` alone.
2. `parseVideoScene(file)` reads one scene file: a `<template>` and the composition in it.
3. `composeVideo` checks that each file holds its host's composition, and adds what each plays.

`readVideoComposition` runs the three over a reader of the version's files. Every refusal is a
sentence naming the file, the scene, and what to write instead.

## Where it agrees with HyperFrames

Checked against `hyperframes timeline --json` (0.9.68, in the agent image):

```bash
docker run --rm --network none -v "$PWD":/w sixb-agent:1.4.0 \
  bash -lc 'cd /w && hyperframes timeline --json'
```

- **Starts.** `data-start` is seconds when `Number()` reads it as finite; else a scene's name when
  it matches `[A-Za-z0-9_.:-]+`; else `<name> + n` or `<name> - n`, the number trailing. So
  `intro-2` names a scene, and `intro - 2` is two seconds before `intro` ends.
- **Names.** HyperFrames finds what `data-start` names by element `id` first, then by
  `data-composition-id`, and so does `resolveStarts`. A host's own `id` may differ, as
  HyperFrames' templates write `id="intro-layer" data-composition-id="intro"`, so a start may name
  the scene either way. A name that could read two ways is refused: two hosts of one `id`, a
  host's `id` that is another scene's id, or another element taking either name. Ids start with a
  letter, so none reads as a number.
- **A scene's identity** is its `data-composition-id` alone, never its host's `id`: the outline,
  `artifact:…#<scene>` addresses, and comments name it by that.
- **Lengths.** HyperFrames' timeline reads a scene's length from its host alone, and a host
  without `data-duration` is 0 seconds long there, whatever its file says. Every host needs one.
- **Refused where HyperFrames would guess.** It clamps a negative start to 0 and plays a cycle of
  starts somehow: both are refusals here.
- **Files a scene plays.** `videoFilePath` resolves as HyperFrames' compiler rebases a scene's
  paths: `../` climbs from the scene's folder, a path beside the scene is used when the version
  holds it, anything else is read from the project's root. `?query` and `#fragment` are dropped.
- **Template content** is not in the page until HyperFrames puts it there, so roots, hosts and ids
  are looked for outside templates; the files a template plays still count.
- `data-label` is HyperFrames' own name for a scene (its runtime's scene list reads it).
- **Nested compositions.** A scene's composition may host others by `data-composition-src`,
  loaded from the project's root as `index.html`'s scenes are (HyperFrames' lint reports one
  missing there). Publishing reads each, all the way down: its file must exist and hold a
  `<template>`, none may nest itself, and what it plays is the scene's.

## Where it is stricter

- Frames are at most 3,840 pixels a side, in even numbers, as H.264 encodes them, at 24, 25, 30,
  50, or 60 fps: a frame rate every segment of an export cuts cleanly at. Both are written in
  digits alone, which HyperFrames' `parseInt` reads as `Number()` does.
- A root that plays something on its own timeline, a soundtrack or any element with `data-start`,
  writes its own `data-duration`. Without one, HyperFrames plays until the last of them ends, and a
  sound without `data-duration` lasts as long as its file: a length the HTML does not say.
- A scene ends by the root's `data-duration`, where HyperFrames would cut it, or less than a frame
  after it: a rounded start or length, which cuts nothing a frame shows.
- A scene host sits in the root composition itself, never in another composition.
- The root's `data-poster`, which HyperFrames does not read (its lint passes it), is the instant
  that shows the video before it plays, in seconds from 0 to before its end. The app's player
  opens on it; without one, 70% into the first scene, where an opening has come in.
- A scene file is one `<template>`, nothing beside it.

## Source positions

Each host, and the root, keeps the span of its whole element, of its start tag, and of every
attribute it writes, and each file reference the span of its attribute, as offsets into the text it
was read from. An editor patches a `data-start`, a `data-duration`, or a `src` in place with them,
so a change stays one small text edit, in the live document and in the Agent's diffs.

## Render keys

`publish/video.ts` names each scene by `sceneRenderKeys`, a hash of what its frames are made of:

- the frame kit;
- `index.html` without its scene hosts, the root's `data-duration` and `data-poster`, and its
  `<audio>` elements, which show nothing: the frame, the root's styles, and what it shows itself.
  A soundtrack trimmed with the video spares the scenes before the cut;
- the scene's host and those of the scenes on screen with it, as one fades into the next, with
  their times resolved and their order in `index.html`, which stacks them;
- the scene's start in the video, only when the root plays or animates something of its own: a
  timed element, a recording, a script that may build a timeline, or CSS that moves;
- every other file, but two kinds: the other scenes' HTML, and the videos and sounds neither the
  root, the scene, nor a scene beside it plays, the heavy files a version mostly changes.

`rootTimeline` reads `index.html` alone; publishing then reads what it links. An inline script
counts, as it may build the root's timeline, and so does a script of the version that registers
one (`__timelines`); a library, from a CDN or the version, only loads. A stylesheet of the version
counts when its CSS moves, Google Fonts never, and any other stylesheet from elsewhere always,
since it cannot be read.

A scene's own motion does not count. HyperFrames runs a scene's CSS animations and its registered
GSAP timeline from the scene's start, wherever it plays. Measured on 0.9.68: one scene, a box
moved by a 2 s CSS animation, then by a GSAP timeline, placed at 0 s and at 2 s, each range
rendered with `--crf 0 --workers 1 --start/--end`; the 60 frames' `framemd5` are identical, all 60
distinct. The control, the same box animated in the root, differs on all 60 frames.

So trimming a scene re-renders it and the scenes it overlaps, and those after it only when the
root has a timeline of its own. An image, a stylesheet, a font, a script, or a nested composition
is in every key, whatever loads it: CSS `url()`, `srcset`, or a script. The one blind spot is a
video or a sound a scene loads by script alone, which no HTML attribute names: changing it keeps
the scene's segment. So a recording a script plays is named in HTML too, by a `<video>` or an
`<audio>` it drives, as the Agent's guide asks.

The key names no artifact: a segment is the scene's frames, rendered from these files alone, so a
copy shares it. An `artifact:` file a scene plays is in its HTML as an address, which follows its
target's latest version, so the key does not cover what it resolves to: whatever renders a segment
of such a scene adds that to the key it keeps the segment under.
