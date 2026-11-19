# @sixb/render-worker

Queue worker for what Sixb renders in a sandbox: the pictures of a canvas's boards, a designed
document's PDF, what is derived of a video or a sound, and a video's stills and MP4. It consumes the `renders` queue, so a
render never waits behind an agent's run or takes its slot.

You normally do not import it. `sixb worker render` and `sixb worker-group` construct it for you,
and `sixb dev` starts it when the project has a sandbox provider.

## What it runs

`artifact.previews.requested`: the pictures a canvas version's boards miss, which a reader sees
until they open a board, whoever published it. Each write that asks replaces the artifact's job
still waiting, and it runs once the canvas has rested 15 seconds. One render:

- Does nothing when nothing is missing, or the version holds other content since it was asked
  for: the write that changed it asks for its own.
- Opens a blank sandbox of the project, which reaches only the CDNs a frame may load from, and
  writes the version there with each board as its frame serves it, and what its queries return as
  its publisher read them.
- Pictures each missing board with the image's Chromium, through Playwright, at its own size, in
  each mode the reader sees: full as PNG, and at most 480 pixels wide as WebP. A board whose
  page did not load whole is not pictured: a broken picture would stay. Without query answers, a
  board that reads a query is not pictured either. A board that fails costs only itself.
- Keeps what it pictured as the boards' previews. When a board stopped answering, or time ran out
  before every board, it tries again for what is still missing; after three attempts the boards it
  could not picture keep their outlines.

`artifact.pdf.requested`: a designed document's version printed to PDF, which
`sixb.artifacts.pdf()` asks for. One print:

- Does nothing when the PDF is kept already, or the version is gone or holds other content since
  it was asked for: asking again asks for what it holds now.
- Opens a blank sandbox of the project, which reaches only the CDNs a frame may load from, and
  writes the version there with the frame's stylesheets and runtime, as its frame serves it.
- Prints it there with the image's Chromium, through Playwright: it waits for the document's fonts
  and images, and prints on the paper its `@page` rule sets, with its backgrounds. When a file or a
  font did not load, it prints again on its second attempt, and keeps that PDF, which shows
  without it.
- Keeps the PDF under the version's render key.
- Keeps why it could not print instead: at once when the sandbox has no browser, else after its
  second attempt. Whoever waits for the PDF hears it.

`artifact.media.requested`: what is derived of a video or a sound, asked for when a version that
holds one is published, in any kind of artifact, and when `sixb.artifacts.media()` finds nothing
yet. One job per digest, so a file published again, anywhere, is derived once. One run:

- Does nothing for the parts already kept: it derives what is still pending, as an attempt cut
  short left it. It counts the attempt in what is kept before it starts.
- Opens a blank sandbox of the project that also reaches the API, where it fetches the original by
  a download URL (see Large files below).
- Runs `derive.cjs` there with the image's FFmpeg: the probe first, which gives the attempt its
  time (`mediaJobBudget` in core: the proxy by the pixels it decodes, the rest by the length, two
  hours at most), then each part on its own, so one that fails costs only itself and is kept failed
  with why. Media past 30 minutes get their probe alone.
  - The proxy: H.264, its shorter side at most 720 pixels, at most 30 frames a second, a keyframe
    every half second, AAC, its index first. A sound gets an AAC proxy only when browsers cannot
    play it, such as AIFF.
  - The poster: the first moment from one second on that is neither near-black nor flat.
  - The filmstrip, 90 pixels high, at the interval that keeps it to 120 thumbnails, and the cuts
    by scene detection: from the proxy, which seeks at once. The peaks, 50 a second.
  - The sound for the transcript: mono, 16 kHz MP3, small enough for the model.
- Streams what it wrote into blob storage and keeps each part, before the sandbox is destroyed.
- Transcribes the sound outside the sandbox with the project's transcription model, as the kernel
  operation `artifacts.transcribeMedia`, on the project's model budget, and keeps the transcript.
  Without a model, the transcript is unavailable, not failed.
- A sandbox without FFmpeg makes each part unavailable, lacking `sandbox_tools`, until a retry.
  When the script stops, the job tries again for what is pending; after the third attempt since the
  media was asked for, counted in what is kept, what is still pending is kept as failed.

`artifact.video.export.requested`: a video version's MP4, which `sixb.artifacts.video()` asks
for. It is joined from segments kept under their own keys, shared by every export that holds them
(`packages/core/src/artifacts/video/README.md`). One run:

- Does nothing once the MP4, or why it could not be made, is kept.
- While segments are missing, asks for each in a job of its own, then asks for itself again five
  seconds later and returns: no worker sleeps while scenes render. That later run only looks.
- A segment that failed fails the export, saying which scene.
- Once every segment is kept, opens a blank sandbox of the project that reaches the API, fetches
  them by download URL, and joins them with FFmpeg without encoding them again, with the sound,
  its index first. Its frame count is checked, and the MP4 is kept, named after the version's
  title. It gives up 12 hours after it was asked for.

`artifact.video.segment.requested`: one segment of an export, by its key. One run:

- Does nothing once the segment, or why it could not be rendered, is kept.
- Opens a blank sandbox of the project that reaches the API and lays the project out there: its
  HTML written by the worker, each `artifact:` address pointed at the file it resolved to, the rest
  fetched by the sandbox.
- A scene's project keeps the scenes on screen with it, moved earlier when it can so its first
  frame is frame 0. HyperFrames renders it, `--no-low-memory-mode` when the sandbox has 3 GiB or
  more, two browsers at once, H.264 at CRF 18 with a keyframe every two seconds; the sound is
  dropped. A crossfade from the scene before, or a root that moves, renders a range of the
  project instead.
- The sound is mixed once for the whole video: HyperFrames' distributed plan, which captures no
  frame, mixes it exactly as its render does.
- Each segment's time grows with its frames and their pixels: five minutes, then twenty seconds a
  second of 1080p.
- A sandbox without HyperFrames, FFmpeg or Node.js, or with another HyperFrames than the one every
  key names, keeps why at once. Another failure tries once more, then keeps why.

`artifact.video.stills.requested`: the stills of a version's scenes, asked for when it is
published, 15 seconds after the last write that asks. One sandbox snapshots each scene missing one
at its middle, with `hyperframes snapshot`, from a project that holds those scenes and the ones on
screen with them, as JPEGs at most 1,280 pixels wide. After three attempts, the scenes keep none.

How many renders run at once is the worker's concurrency, two by default
(`workerConcurrency.render`), for each worker process. The queue contract has no per-project group
limit, so a project renders as many segments at once as its render workers claim: four workers of
one, or two of two, render four. Each job's lease is renewed every 20 seconds while it runs, so a
render that takes an hour is never claimed twice; one whose worker died is delivered again a
minute later.

A footage-only scene could be cut by FFmpeg without a browser. It is not: measured on a 6-second
1080p scene at 4 vCPU, it is 1.6 times faster (12.7 s to 7.9 s, the encode dominating), its colours
differ from HyperFrames' render of the same footage (PSNR 34 dB), which a cut between the two
would show, and whether nothing else shows over the footage cannot be told from the HTML alone, as
a root stylesheet may style it.

Each render's steps are bounded by the time its job has left, and its sandbox is destroyed after,
waited for at most 30 seconds. What a render wrote in the sandbox comes back a piece at a time,
at most 720 KiB of it to a command, as some providers keep at most 1 MiB of a command's output.

## Large files

A render whose files are large, such as a film's media, keeps them out of the worker's memory both
ways (`src/sandbox.ts`):

- In: `downloadIntoSandbox` issues a download URL for each file, valid for as long as the fetch
  may take, and the sandbox fetches it with curl from the API's public origin, four files at a
  time; the URLs are revoked once the fetch is over. The sandbox must be opened to that origin: pass
  `renderApiOrigin(host)` as `reach` to `inRenderSandbox`. A worker of its own learns the origin
  from `SIXB_API_PUBLIC_ORIGIN`, and `sixb worker render` refuses to start without it.
- Out: `storeSandboxFile` streams a file the render wrote into blob storage, read back a piece at a
  time, a few pieces ahead.

The sandbox does not upload its output itself. It holds no credential for the API, and a blob
store's direct upload URLs are on an origin the contract does not name before the upload exists,
when the sandbox's network is already set. Both would have to change for that.

## The sandbox's tools

Renders need a sandbox image with Node.js and Playwright's Chromium, as the Sixb agent image has
(`/opt/sixb/js/node_modules/playwright`), FFmpeg and ffprobe on its path for media, and the
HyperFrames CLI of `VIDEO_ENGINE` for videos. `video-export.e2e.ts` runs in the agent image. A local
sandbox finds Playwright where `SIXB_PLAYWRIGHT` points, and FFmpeg on the host's path, as
`media.e2e.ts` does.
