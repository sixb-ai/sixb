# @sixb/render-worker

Queue worker for what Sixb renders in a browser: a designed document's PDF. It consumes the
`renders` queue, so a render never waits behind an agent's run or takes its slot.

You normally do not import it. `sixb worker render` and `sixb worker-group` construct it for you,
and `sixb dev` starts it when the project has a sandbox provider.

## What it runs

`artifact.pdf.requested`: a designed document's version printed to PDF, which
`sixb.artifacts.pdf()` asks for. One print:

- Does nothing when the PDF is kept already, or the version is gone or holds other content since
  it was asked for: asking again asks for what it holds now.
- Opens a blank sandbox of the project, which reaches only the CDNs a frame may load from, and
  writes the version there with the frame's stylesheets and runtime, as its frame serves it.
- Prints it there with the image's Chromium, through Playwright: it waits for the document's fonts
  and images, and prints on the paper its `@page` rule sets, with its backgrounds.
- Keeps the PDF under the version's render key, then destroys the sandbox.
- Keeps why it could not print instead: at once when the sandbox has no browser, else after its
  second attempt. Whoever waits for the PDF hears it.

## The sandbox's browser

Renders need a sandbox image with Node.js and Playwright's Chromium, as the Sixb agent image has
(`/opt/sixb/js/node_modules/playwright`). A local sandbox finds Playwright where
`SIXB_PLAYWRIGHT` points.
