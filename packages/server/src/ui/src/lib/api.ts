import { client } from "@pario/client"

client.setConfig({ baseUrl: window.location.origin })

const CSRF_COOKIE_NAME = "pario_csrf"
const CSRF_HEADER_NAME = "x-pario-csrf"
const CSRF_EXEMPT_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

client.interceptors.request.use((request) => {
  if (CSRF_EXEMPT_METHODS.has(request.method.toUpperCase())) {
    return request
  }

  if (request.headers.has(CSRF_HEADER_NAME)) {
    return request
  }

  const csrfToken = readCookie(CSRF_COOKIE_NAME)
  if (!csrfToken) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set(CSRF_HEADER_NAME, csrfToken)
  return new Request(request, { headers })
})

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
