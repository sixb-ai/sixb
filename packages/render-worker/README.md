# @sixb/render-worker

Queue worker for what Sixb renders in a browser: the pictures of a canvas's boards, and a designed
document's PDF. It consumes the `renders` queue, so a render never waits behind an agent's run or
takes its slot.

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

Each render's steps are bounded by the time its job has left, and its sandbox is destroyed after,
waited for at most 30 seconds. What a render wrote in the sandbox comes back a piece at a time,
at most 512 KiB of it to a command, as some providers keep at most 1 MiB of a command's output.

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

## The sandbox's browser

Renders need a sandbox image with Node.js and Playwright's Chromium, as the Sixb agent image has
(`/opt/sixb/js/node_modules/playwright`). A local sandbox finds Playwright where
`SIXB_PLAYWRIGHT` points.
