/** Served only by development browser servers; the CLI marks a generation ready last. */
export function devReloadResponse(request: Request): Response {
  const generation = process.env.SIXB_DEV_GENERATION
  const headers = new Headers({
    "content-type": "text/javascript; charset=utf-8",
    "cache-control": "no-store",
  })
  if (generation && process.env.SIXB_DEV_READY === "1") {
    headers.set("x-sixb-dev-generation", generation)
  }
  if (request.method === "HEAD") return new Response(null, { headers })
  const script = generation
    ? `(() => {
    if (window.__sixbDevReload) return;
    window.__sixbDevReload = true;
    const generation = ${JSON.stringify(generation).replaceAll("<", "\\u003c")};
    let timer;
    let checking = false;
    let finished = false;
    let failures = 0;
    const hidden = () => document.visibilityState === "hidden";
    function schedule(delay) {
      clearTimeout(timer);
      timer = setTimeout(poll, delay);
    }
    async function poll() {
      if (checking || finished) return;
      if (hidden()) { schedule(15000); return; }
      checking = true;
      try {
        const response = await fetch("/__sixb/dev-reload.js", {
          method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(3000)
        });
        const next = response.headers.get("x-sixb-dev-generation");
        if (response.ok && next && next !== generation) {
          finished = true;
          document.removeEventListener("visibilitychange", visible);
          location.reload();
          return;
        }
        failures = response.ok && next ? 0 : Math.min(failures + 1, 4);
      } catch { failures = Math.min(failures + 1, 4); }
      finally { checking = false; }
      schedule(Math.min(1000 * 2 ** failures, 10000));
    }
    function visible() {
      if (!hidden()) { clearTimeout(timer); void poll(); }
    }
    document.addEventListener("visibilitychange", visible);
    void poll();
  })();`
    : ""
  return new Response(script, { headers })
}
