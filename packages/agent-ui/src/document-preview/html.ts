import { type DefaultTreeAdapterTypes, parse, serialize } from "parse5"

const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

const NAVIGATION_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "target", "ping", "download"]),
  area: new Set(["href", "target", "ping", "download"]),
  form: new Set(["action", "target"]),
  button: new Set(["formaction", "formtarget"]),
  input: new Set(["formaction", "formtarget"]),
}

/** An empty capability list applies every iframe sandbox restriction. */
export const HTML_PREVIEW_SANDBOX = ""

/**
 * Parse without a browsing context, strip user-triggered navigation, and serialize a complete
 * document. The policy metadata precedes every untrusted token, while parse5 lets this work for
 * both fragments and full HTML without loading resources or executing scripts during preparation.
 */
export function buildSafeHtmlPreviewDocument(source: string): string {
  const policyPrefix = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`
  const document = parse(`${policyPrefix}${source}`)
  neutralizeNavigation(document)
  return serialize(document)
}

function neutralizeNavigation(parent: DefaultTreeAdapterTypes.ParentNode): void {
  parent.childNodes = parent.childNodes.filter((node) => !isNavigationalMetadata(node))

  for (const node of parent.childNodes) {
    if (!isElement(node)) continue

    const blockedAttributes = NAVIGATION_ATTRIBUTES[node.tagName]
    if (blockedAttributes) {
      node.attrs = node.attrs.filter((attribute) => !blockedAttributes.has(attribute.name))
    }
    neutralizeNavigation(node)
    if (node.tagName === "template" && "content" in node) neutralizeNavigation(node.content)
  }
}

function isNavigationalMetadata(node: DefaultTreeAdapterTypes.ChildNode): boolean {
  if (!isElement(node)) return false
  if (node.tagName === "base") return true
  if (node.tagName !== "meta") return false
  const httpEquiv = node.attrs.find((attribute) => attribute.name === "http-equiv")
  return httpEquiv?.value.trim().toLowerCase() === "refresh"
}

function isElement(
  node: DefaultTreeAdapterTypes.ChildNode
): node is DefaultTreeAdapterTypes.Element {
  return "tagName" in node
}
