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
  `data-composition-id`. A scene's id is its `data-composition-id`; a host's `id`, when written,
  must be the same, and no other element may take a scene's id, so both lookups find the scene.
  Ids start with a letter, so none reads as a number.
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

## Where it is stricter

- Frames are at most 3,840 pixels a side, in even numbers, as H.264 encodes them, at 24, 25, 30,
  50, or 60 fps: a frame rate every segment of an export cuts cleanly at. Both are written in
  digits alone, which HyperFrames' `parseInt` reads as `Number()` does.
- A root that plays something on its own timeline, a soundtrack or any element with `data-start`,
  writes its own `data-duration`. Without one, HyperFrames plays until the last of them ends, and a
  sound without `data-duration` lasts as long as its file: a length the HTML does not say.
- A scene host sits in the root composition itself, never in another composition.
- A scene file is one `<template>`, nothing beside it.

## Source positions

Each host keeps the span of its start tag and of every attribute it writes, and each file reference
the span of its attribute, as offsets into the text it was read from. An editor patches a
`data-start`, a `data-duration`, or a `src` in place with them, so a change stays one small text
edit, in the live document and in the Agent's diffs.

## Render keys

`publish/video.ts` names each scene by `sceneRenderKey`: its id and file, the frame kit, and the
digests of every file it could load. That is `index.html` (its place, its length, the frame), what
the root and the scene play, and the files no scene plays, such as stylesheets and fonts; not the
other scenes' HTML, nor what only they play, unless they are on screen with it, as when one fades
into the next. Changing one scene re-renders that scene and those it overlaps; changing
`index.html`, a shared stylesheet, or the soundtrack re-renders them all.

The key names no artifact: a segment is the scene's frames, rendered from these files alone, so a
copy shares it. An `artifact:` file a scene plays is in its HTML as an address, which follows its
target's latest version, so the key does not cover what it resolves to: whatever renders a segment
of such a scene adds that to the key it keeps the segment under.
