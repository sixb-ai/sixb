export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/"
  }

  try {
    const parsed = new URL(value, "http://sixb.local")
    if (parsed.origin !== "http://sixb.local") {
      return "/"
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return "/"
  }
}

export function returnToForRequest(request: Request): string {
  const url = new URL(request.url)
  return sanitizeReturnTo(`${url.pathname}${url.search}`)
}
