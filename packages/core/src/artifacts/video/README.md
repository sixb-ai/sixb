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
  or 60 fps: the rates HyperFrames renders a range of a film at, as an export renders a scene that
  overlaps another. Both are written in digits alone, which HyperFrames' `parseInt` reads as
  `Number()` does.
- A root that plays something on its own timeline, a soundtrack or any element with `data-start`,
  writes its own `data-duration`. Without one, HyperFrames plays until the last of them ends, and a
  sound without `data-duration` lasts as long as its file: a length the HTML does not say.
- A scene ends by the root's `data-duration`, where HyperFrames would cut it, or less than a frame
  after it: a rounded start or length, which cuts nothing a frame shows.
- A scene host sits in the root composition itself, never in another composition.
- The root's `data-poster`, which HyperFrames does not read (its lint passes it), is the instant
  that shows the video before it plays, in seconds from 0 to before its end. The app's player
  opens on it, and its card shows it; without one, both show the first scene's still, the middle
  of its segment, where an opening has come in (`videoPosterMs`).
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
  `<audio>` elements, which show nothing: the frame, the root's styles, and what it shows itself;
- the scene's host and those of the scenes on screen during its segment, from the frame it starts
  on up to the one the next scene starts on, as one fades into it, with their times resolved and
  their order in `index.html` and their `z-index`, which stack them. A scene that fades in after
  the segment ends shows in none of its frames, and is not in its key;
- the scene's start in the video, only when the root shows something that moves of its own: a
  timed element, a video, a script that may build a timeline, or CSS that moves;
- every other file, but four kinds: the other scenes' HTML, the videos neither the root nor a
  scene on screen during the segment plays, the heavy files a version mostly changes, every
  sound, and HyperFrames' own project state in `.hyperframes/`, its edit history, which no frame
  loads. A version published from a folder HyperFrames worked in holds it, and the Agent's next
  publish, which leaves out every dot folder, drops it: kept in the keys, that would render every
  scene again.

A segment is pictures alone. The export mixes the whole video's sound once, apart, so a soundtrack
changed, trimmed or moved renders no scene again (see Export below).

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

So trimming a scene re-renders it and the scene it fades into, and those after it only when the
root moves on its own, or when the trim moves them by part of a frame, which the editor's cuts
never do (see Editing). An image, a stylesheet, a font, a script, or a nested composition
is in every key, whatever loads it: CSS `url()`, `srcset`, or a script. The one blind spot is a
video or a sound a scene loads by script alone, which no HTML attribute names: changing it keeps
the scene's segment. So a recording a script plays is named in HTML too, by a `<video>` or an
`<audio>` it drives, as the Agent's guide asks.

The key names no artifact: a segment is the scene's frames, rendered from these files alone, so a
copy shares it. An `artifact:` file a scene plays is in its HTML as an address, which follows its
target's latest version, so the key does not cover what it resolves to: the export adds that to
the key it keeps the segment under (see Export below).

## Export

A version exports to one MP4 joined from segments kept apart from it under keys that hash what
each is made of (`export.ts`), in `ArtifactStorage`'s video renders, which no artifact owns:

| Segment | Its key holds |
| --- | --- |
| A scene's frames, from the frame it starts on up to the one the next scene starts on (the first from frame 0), silent | the scene's render key, where it starts from the scene's start and how many frames, the engine (`VIDEO_ENGINE`), the encoder settings, and what the `artifact:` addresses played by the root and the scenes on screen during it resolve to |
| The whole video's sound | every file, the frame rate and count, the engine, and what every address resolves to |
| The MP4 | its segments' keys, in order |

So a version that changes one scene renders that scene's segment again, and the segment of the
scene it fades into, and mixes the sound again, which takes seconds; a copy shares every segment.
Scenes that start on one frame render in the first one's segment, and its scene's key covers every
scene on screen during it (`scenesOnScreen`).

```text
sixb.artifacts.video()   keys from the outline alone: what is kept, or ask
  → artifact.video.export.requested   one job per export, carrying the version as it was asked for
      asks for each missing segment, then for itself again, VIDEO_EXPORT_JOB.recheckMs later
  → artifact.video.segment.requested  one job per segment key, shared by exports
      a scene: `index.html` keeping the scenes on screen during it (project.ts), in a sandbox
      once kept, asks the export that asked for it to look again at once
      the sound: HyperFrames' own mix, through its distributed plan, which captures no frame,
      from the version less the footage no unmuted video plays (`videoSoundProject`)
  → the export, once every segment is kept: joined without encoding again, the sound muxed
```

- **A scene's project.** `videoSegmentRender` keeps the scenes on screen during the segment
  and moves them earlier by as many whole frames as none of them starts before, up to the
  segment's start, so each keeps its place between frames. When nothing starts before the segment
  and the root does not move, the segment starts at frame 0 of its project, and HyperFrames renders
  it whole, in parallel browsers. Otherwise, a crossfade from the scene before or a root that moves
  on its own, it renders the range `--start`/`--end` of the project, which HyperFrames captures in
  short chunks one after the other, about twice slower.
- **Joining.** Every segment is H.264 at one quality, `VIDEO_SEGMENT_SETTINGS`, and starts on a
  keyframe, so the MP4 is the segments as they are, with the sound, index first. Its frame count is
  checked against the plan's.
- **The sound** is one mix of the whole video, so music that crosses a cut never breaks: the
  `audio.m4a` of HyperFrames' distributed plan (`planV2`), the very track its own render muxes,
  bit for bit (measured on 0.9.68). A video with no sound gets silence, so every MP4 has a track.
  No package export reaches the plan: `video.cjs` finds the module of the CLI's `dist` that
  exports `planV2` and the request helpers beside it. That holds only because every key pins
  `VIDEO_ENGINE`, which a sandbox must run: it names `HYPERFRAMES_VERSION`, which a unit test holds
  to the agent image's release. When the module is gone, or its manifest moved, the sound fails at
  once, kept with what changed, and `video-export.e2e.ts`, run against the agent image, fails by
  name on an image that upgrades HyperFrames.
- **Waiting** is a job, not a worker: the export looks again a few seconds later in a job it asks
  for in its own place, asking for nothing then. Each segment it asked for makes it look at once,
  once kept or failed, carrying the export's payload; the later look is a backstop, for an export
  whose segment another asked for first. A segment job always keeps its file or why not,
  so asking again for a segment never strands an export; a retry forgets the failures and asks
  anew with `replace`, in a job apart from the export's, since a segment that finishes takes the
  export's place with the payload it was asked with, which asks for nothing. A segment found kept
  still makes its export look, so the last look carries the latest ask's `askedAt`.
- **Failures.** A segment that fails after `VIDEO_SEGMENT_JOB.attempts` fails the export, naming
  the scene by its label, else its id. An export asked for by a Sixb whose keys differ from the
  worker's, as while a deploy rolls out, tries again until its attempts are spent, then keeps why.
  A sandbox without HyperFrames, or with another version than `VIDEO_ENGINE`, keeps why at once,
  with `lacks: "sandbox_tools"`, which the app reads as export not being available rather than
  offering a retry: rendering there would keep frames under a key that does not name what made
  them.
- **Stills** (`stills.ts`): the middle of each scene's segment, what its chapter plays until the
  next scene starts, snapshotted with `hyperframes snapshot` when a version is published, once it
  rests, and kept under the scene's key. The poster is the instant the root's `data-poster` names,
  else the first scene's still.

### What to ask HyperFrames for

The scan goes once HyperFrames exports a way to mix a project's sound alone, which its CLI has
internally (`processCompositionAudio`, run by `planV2` and by every render). Any of these would do:

- `hyperframes render --audio-only -o mix.m4a`, the render's own delivery mix, no frame captured;
- an `audio` mode on `hyperframes/api`: `mixAudio(projectDir, { fps, signal }) → { path, durationMs }`;
- `planV2` and its request helpers on `hyperframes/api`, with the manifest's layout documented.

The first is the one to ask for: a CLI flag keeps the render worker on the same contract as its
segments, and the sandbox needs nothing else.

## Editing

The app's editor changes a video in its live document: `index.html` and each scene file are
`Y.Text`, each recording a reference. It never writes a file whole. `timeline.ts` reads what an
editor touches, and `edit.ts` turns each operation into changes to the text.

- **Clips** (`readSceneTimeline`, `readRootTimeline`): the timed elements of one composition,
  anything with `data-start` and every `<video>` and `<audio>`, with their timing as written and the
  span of each attribute. A clip is named by its `id`, else by its place among the file's clips
  (`#2`). Its track follows from what it is: picture, text, or sound.
- **Targets** (`videoTarget`): how the editor names an element in an operation. One without an id
  carries its tag, words and file with its place: someone else's edit in between may shift the
  place, and the operation then takes the one element still alike, or refuses when none or several
  are. It never edits another element than the one the reader chose.
- **Texts**: the elements holding words alone, timed or not, which an editor types over.
- **Operations** take the files as they are and return an edit or a refusal: a scene's length,
  label, place, copy and removal; a clip's timing, trim, move, split, removal, sound and words; an
  import; a range cut from the video, each scene it spans losing its share; stretches of a
  recording cut wherever it plays.

How an operation works:

1. It changes a working copy step by step, reading the files again between steps, so each step
   finds what the one before left.
2. A step that moves a scene first gives the root room for any length (`openRoot`), so every
   step in between reads as a video. The last step writes the root's real length, and moves a
   soundtrack that ran to the end, what the root plays during a scene, and the poster, with it
   (`fitRoot`).
3. The result is read as publishing reads a video (`readVideoComposition`); anything else is
   refused, with the reason.
4. The edit is the difference from the files it started from: the live layer's line diff, each
   line written again narrowed to the attributes and words that changed. Two people changing
   different values change different text, which Yjs merges, and the Agent's next diff reads as an
   edit. Two writing one attribute at once leave it twice; the first counts, as in a browser, and
   the next write keeps it alone. Its changes are `BoardChange`s, applied to a `Y.Text` by
   `applyBoardEditToText`.

What moves with what:

- Scenes chained by `data-start` follow as HyperFrames moves them. A scene at a number of seconds
  after the change moves as much. A reorder or a removal chains the scenes whose predecessor
  changed, each keeping its own overlap or gap.
- A reorder writes starts, never a host's line: Yjs cannot move text, so a line moved is deleted
  and copied, and someone's concurrent edit of it would be left as stray text. HyperFrames paints
  scenes on screen together in `index.html`'s order, unless a `z-index` says otherwise. After a
  reorder, scenes on screen together stack in play order, the later on top, as a crossfade shows
  it: a scene that must sit above one later in the file writes the least `z-index` that puts it
  there, and drops it once the file's order does. What the root paints over the scenes, the
  elements after its first host such as a captions bar, then writes one above the highest scene's,
  and drops it with the last.
- A ripple trim moves what starts after the edge, the scene's end included. A cut (a ripple
  delete, a marked range, words of a transcript) takes stretches out of a scene: a recording cut
  through is split around them, each part playing on from where its file was cut; any other clip
  is shortened; a clip with nothing left goes; the scene ends as much sooner. A marked range
  across scenes cuts from each its share, from its start up to the next scene's, so a crossfade
  is cut once, and removes a scene it covers whole.
- A cut and a scene's new length go by frame steps, the shortest stretch that is whole frames and
  whole milliseconds: 100 ms at 30 fps, a frame at 25. Each stretch cut from a scene grows to the
  whole steps that cover it, so nothing marked to go is heard again: into its `room` first, the
  pauses up to the words kept either side of a transcript's cut, then as much on each side. A
  scene's length is the nearest number of steps (`videoSceneLength`), which its field shows. The
  scenes after then move by whole frames, show the same frames, and keep their segments: an
  export renders only the edited scene again. Removing a whole scene moves them by its length,
  whatever it is.
- A clip whose `data-start` names another clip follows it, and a ripple does not move it. Once
  that clip is split, it follows the last part; once it is removed or cut, it starts at the time
  it did, which the ripple then moves as any other's.
- A copied scene's recordings take new ids, and every `#id` naming them in the file follows, as
  HyperFrames plays each recording by its id.
- What `index.html` plays during one scene, a line of voice-over at a number of seconds, belongs
  to the scene it plays most during, when it lasts no longer than that scene: it keeps its time
  into the scene as the scene moves, and goes with it. A soundtrack under every scene belongs to
  none. The Agent's guide puts a voice-over in its scene's file, where it moves with no rule.
- The poster keeps its time into the scene on top at its instant, within that scene's length.
- A write merged into the live document keeps every recording the merged HTML still plays, even
  one the writer's copy no longer did: someone else may have just added a clip of it.

Not covered: motion a scene's script writes (`gsap.timeline` positions) keeps its own times, and a
recording a script plays without an element is not seen.
