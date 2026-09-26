---
name: browser
description: Inspect web pages, test local web apps, capture screenshots, or render HTML to PDF with the installed Playwright browser.
---

Use a Node `.cjs` script with `require("/opt/sixb/js/node_modules/playwright")`. The matching
Chromium headless shell is already installed at `$PLAYWRIGHT_BROWSERS_PATH`; use
`chromium.launch({ headless: true })`. Do not download another browser or select an uninstalled
Chrome channel. Close the browser in `finally` and set bounded navigation/action timeouts.

Local HTML can be loaded with `page.setContent(html)` or a file URL without external network access.
External pages, images, fonts, and API calls depend on the sandbox network policy. Report a blocked
source instead of repeatedly reinstalling tools. Requests and Beautiful Soup are also available for
fetching permitted static pages and parsing HTML. Neither provides a search index.

Save screenshots and PDFs inside the workspace. Use `view_file` to inspect screenshots when image
input is supported; check the resulting page state after interaction. Before printing a PDF, wait for
fonts and relevant images, set print styles/page size, and inspect the resulting PDF page previews
with `sixb-render`. A successful navigation or screenshot does not prove the page meets the task.

Publish only requested final files using the worker's output instructions. Browser traces, temporary
HTML, and screenshots used for verification are working files unless requested.
