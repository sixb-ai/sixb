/**
 * Shown by Caddy for a page request while the app or Atlas cannot answer — during a deploy, or
 * an outage. It needs no assets or JavaScript and reloads itself every 10 seconds.
 */
export function renderUpdatePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>Updates in progress</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #fff; color: #111; --muted: #666; --line: #e8e8e8; --surface: #fafafa; --track: #d6d6d6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; min-height: 100svh; display: grid; place-items: center; padding: 48px 28px; -webkit-font-smoothing: antialiased; }
    main { width: 100%; max-width: 480px; }
    .status { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 28px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; font-weight: 500; line-height: 1.4; letter-spacing: 0.1em; text-transform: uppercase; }
    .loader { width: 12px; height: 12px; flex: none; border: 1.5px solid var(--track); border-top-color: currentColor; border-radius: 50%; animation: spin 1s linear infinite; }
    h1 { margin: 0 0 16px; font-size: clamp(28px, 5vw, 36px); font-weight: 500; letter-spacing: -0.045em; line-height: 1.2; text-wrap: balance; }
    .description { margin: 0; max-width: 380px; color: var(--muted); font-size: 15px; line-height: 1.8; text-wrap: pretty; }
    .footer { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px 20px; margin-top: 36px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); }
    .footer p { margin: 0; font-size: 12px; line-height: 1.6; }
    .footer .interval { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; letter-spacing: 0.02em; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .loader { animation: none; } }
    @media (prefers-color-scheme: dark) {
      :root { background: #0a0a0a; color: #f5f5f5; --muted: #999; --line: #262626; --surface: #111; --track: #444; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status"><span class="loader" aria-hidden="true"></span>Site update</div>
    <h1>Updates in progress</h1>
    <p class="description">We’re making a few updates. The site should be back soon. Thanks for your patience.</p>
    <div class="footer">
      <p>This page will reconnect automatically.</p>
      <p class="interval">Retrying every 10s</p>
    </div>
  </main>
</body>
</html>`
}
