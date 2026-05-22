import type { ParioRuntimeConfig } from "./types"

export function injectParioRuntimeConfig(html: string, config: ParioRuntimeConfig): string {
  const runtimeConfig = JSON.stringify(config).replaceAll("<", "\\u003c")
  const script = [
    "<script>",
    "(function(){",
    "const current=window.__PARIO_RUNTIME__||{};",
    `const next=${runtimeConfig};`,
    "window.__PARIO_RUNTIME__=Object.assign({},current,next,{",
    "auth:Object.assign({},current.auth||{},next.auth||{}),",
    "api:Object.assign({},current.api||{},next.api||{})",
    "});",
    "})();",
    "</script>",
  ].join("")

  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${script}\n  </head>`)
  }

  return `${script}\n${html}`
}

export function htmlResponse(html: string, method: string, config?: ParioRuntimeConfig): Response {
  const body = config ? injectParioRuntimeConfig(html, config) : html
  return new Response(method === "HEAD" ? null : body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export async function htmlProxyResponse(
  request: Request,
  response: Response,
  config: ParioRuntimeConfig
): Promise<Response> {
  if (!isHtmlResponse(response)) {
    return response
  }

  const headers = new Headers(response.headers)
  headers.set("content-type", "text/html; charset=utf-8")
  headers.set("cache-control", "no-store")
  headers.delete("content-length")

  if (request.method === "HEAD") {
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  }

  const html = await response.text()
  return new Response(injectParioRuntimeConfig(html, config), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export function isHtmlResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false
}
