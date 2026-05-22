import { client } from "@pario/client"

declare global {
  interface Window {
    __PARIO_RUNTIME__?: {
      readonly api?: {
        readonly baseUrl?: string
      }
      readonly auth?: {
        readonly csrfCookieName?: string
      }
    }
  }
}

client.setConfig({ baseUrl: window.__PARIO_RUNTIME__?.api?.baseUrl ?? window.location.origin })

const DEFAULT_CSRF_COOKIE_NAME = "pario_csrf"
const CSRF_HEADER_NAME = "x-pario-csrf"
const CSRF_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

client.interceptors.request.use((request) => {
  if (CSRF_EXEMPT_METHODS.has(request.method.toUpperCase())) {
    return request
  }

  if (request.headers.has(CSRF_HEADER_NAME)) {
    return request
  }

  const csrfToken = readCookie(resolveCsrfCookieName())
  if (!csrfToken) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set(CSRF_HEADER_NAME, csrfToken)
  return new Request(request, { headers })
})

function resolveCsrfCookieName(): string {
  return window.__PARIO_RUNTIME__?.auth?.csrfCookieName ?? DEFAULT_CSRF_COOKIE_NAME
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`
  for (const part of document.cookie.split(";")) {
    const cookie = part.trim()
    if (cookie.startsWith(prefix)) {
      return decodeURIComponent(cookie.slice(prefix.length))
    }
  }

  return null
}
