# Sixb agent image

A Linux image that gives Sixb agents shell tools, data analysis, a browser, and document authoring
with visual verification. Any sandbox provider that boots an OCI image can use it.

```text
ghcr.io/sixb-ai/sixb-agent:<version>      linux/amd64, linux/arm64
```

`VERSION` holds the current release. Pin the published digest in production.

## Tools

| Work | Tools |
| --- | --- |
| Shell and files | Bash, coreutils, Git, ripgrep, jq, curl, zip/unzip, xz, bzip2, 7z, patch, rsync, SQLite |
| Runtimes | Node 24, Bun 1.4.2, Python 3.11 |
| Python tooling | pip, uv, pytest, ruff |
| Data and images | pandas, NumPy, PyArrow, matplotlib, Pillow, PyYAML, defusedxml |
| PDF | ReportLab, pypdf, pdfplumber, Poppler, qpdf |
| OCR | Tesseract (English), pytesseract, pdf2image |
| Office files | python-pptx, PptxGenJS, python-docx, openpyxl |
| Rendering | LibreOffice Writer/Calc/Impress, `sixb-render`; DejaVu, Liberation, and Noto fonts |
| Conversion | Pandoc (no TeX engine) |
| Web | Requests, Beautiful Soup, Playwright with Chromium headless shell |

Everything works offline. Network access is set by the provider's sandbox policy, not the image.

## Layout

```text
/workspace                   Default working directory
/opt/sixb/python             Python environment behind python, python3, pip, pip3
/opt/sixb/js/node_modules    pptxgenjs, playwright
/opt/sixb/browsers           Chromium headless shell ($PLAYWRIGHT_BROWSERS_PATH)
/etc/profile.d/sixb.sh       Image environment for login shells (bash -lc)
/usr/local/bin/sixb-render   Document preview helper
```

`/workspace` and `/opt/sixb/python` are writable by any user, because providers run commands as
different users. The image sets no `USER`.

Load the JavaScript libraries by absolute path from a `.cjs` script, so a workspace's
`package.json` is never involved:

```js
const pptxgen = require("/opt/sixb/js/node_modules/pptxgenjs")
const { chromium } = require("/opt/sixb/js/node_modules/playwright")
```

Use a separate environment when a project needs its own packages:

```bash
uv venv .venv
```

## Use with a sandbox provider

**Apple Container**

```ts
new AppleContainerSandboxFactory({ image: "ghcr.io/sixb-ai/sixb-agent:<version>" })
```

**SmolVM** boots a local archive. See [SmolVM setup](../smolvm/README.md#setup).

```bash
mkdir -p ~/.cache/sixb
docker pull ghcr.io/sixb-ai/sixb-agent:<version>
docker save ghcr.io/sixb-ai/sixb-agent:<version> -o ~/.cache/sixb/sixb-agent.tar
```

```ts
import { homedir } from "node:os"

new SmolvmSandboxFactory({ image: `${homedir()}/.cache/sixb/sixb-agent.tar` })
```

**Vercel** boots `linux/amd64` images from the project's own registry. Wait for Vercel to finish
preparing the image before creating a sandbox.

```bash
vercel vcr add sixb-agent --project <project> --scope <team>
vercel vcr login docker --project <project> --scope <team>
docker pull --platform linux/amd64 ghcr.io/sixb-ai/sixb-agent:<version>
docker tag ghcr.io/sixb-ai/sixb-agent:<version> vcr.vercel.com/<team>/<project>/sixb-agent:<version>
docker push vcr.vercel.com/<team>/<project>/sixb-agent:<version>
```

```ts
new VercelSandboxFactory({ image: "sixb-agent:<version>" })
```

**Azure** boots an imported disk image. See
[Pin a reusable image](../azure/README.md#pin-a-reusable-image).

```bash
aca sandboxgroup disk create --image ghcr.io/sixb-ai/sixb-agent:<version> --name sixb-agent-<version>
```

```ts
new AzureSandboxFactory({ /* ... */ image: { type: "disk", id: "<disk-image-id>" } })
```

## Skills

`skills/documents` and `skills/browser` teach agents to use these tools: author, render, inspect the
pages, and repair. Copy them into your project's `skills/` directory so the worker adds them to
its skill catalog:

```bash
cp -R path/to/sixb/sandboxes/agent-image/skills/. skills/
```

They reference this image's paths. Use them only with this image.

## Render documents

`sixb-render` converts a PDF, PPTX, DOCX, or XLSX into a PDF plus one PNG per page, so an agent can
look at what it made.

```bash
sixb-render deck.pptx --output-dir previews-1
sixb-render report.pdf --output-dir previews-2 --first-page 31 --last-page 40
```

```text
--output-dir   New directory for the output (required; must not exist)
--first-page   First page to preview (default 1)
--last-page    Last page to preview (default: last page)
--max-pages    Fail if the range is longer, 1–200 (default 30)
--size         Longest PNG side in pixels, 320–3000 (default 1600)
```

It prints the manifest it also writes to `manifest.json`:

```json
{
  "source": "/workspace/deck.pptx",
  "pdf": "/workspace/previews-1/document.pdf",
  "totalPages": 2,
  "firstPage": 1,
  "lastPage": 2,
  "complete": true,
  "pages": ["/workspace/previews-1/page-1.png", "/workspace/previews-1/page-2.png"]
}
```

`complete` is `false` when the page range leaves pages out. On failure it prints a `[SixbRender]`
error and removes its output directory; it never skips pages. LibreOffice output is a compatibility
check, not an exact match for Microsoft Office.

## Extend

```dockerfile
FROM ghcr.io/sixb-ai/sixb-agent:<version>
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
```

## Build and verify

From the repository root:

```bash
docker build -t sixb-agent:$(cat sandboxes/agent-image/VERSION) sandboxes/agent-image
bun sandboxes/agent-image/verify.ts
```

`verify.ts` mounts `tests/` into the image and runs them as an arbitrary non-root user with
networking disabled. It writes, renders, and checks every document format, and exercises OCR, PDF
tables, Parquet, Chromium, and offline package installs. Its output stays in
`.local/agent-image/verification` for inspection.

The same checks run as a gated test:

```bash
SIXB_AGENT_IMAGE_INTEGRATION=1 bun test ./sandboxes/agent-image/tests/image.e2e.ts
```

## Update dependencies

Python packages are pinned with hashes. Edit `requirements.in`, then regenerate the lock inside the
image's Python:

```bash
docker build --target base -t sixb-agent-base sandboxes/agent-image
docker run --rm -v "$PWD/sandboxes/agent-image:/src" -w /src sixb-agent-base sh -c \
  "/opt/sixb/python/bin/pip install pip-tools==7.5.0 && \
   /opt/sixb/python/bin/pip-compile --generate-hashes --strip-extras -o requirements.lock requirements.in"
```

JavaScript packages live in `tooling/`, outside the monorepo workspace. Edit
`tooling/package.json`, then update its lockfile:

```bash
docker run --rm -v "$PWD/sandboxes/agent-image/tooling:/tooling" -w /tooling oven/bun:1.4.2 \
  bun install --lockfile-only
```

Debian packages take Bookworm updates at build time, so two builds can differ. Deploy by digest.

## Release

Bump `VERSION` and merge to `main`. The `Agent image` workflow builds and verifies both
architectures, then publishes:

```text
ghcr.io/sixb-ai/sixb-agent:<version>          multi-platform
ghcr.io/sixb-ai/sixb-agent:<version>-amd64
ghcr.io/sixb-ai/sixb-agent:<version>-arm64
```

A published version is never overwritten. A merge without a `VERSION` bump only verifies.
