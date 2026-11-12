import {
  defaultTreeAdapter as adapter,
  type DefaultTreeAdapterTypes,
  parse,
  serialize,
} from "parse5"
import {
  type DocumentMark,
  type DocumentSources,
  type DocumentTree,
  documentData,
} from "./frames/document-data"

// A designed document's live data on the server, over parse5: the fields and repeated elements of
// its `document.html`, and that markup with the values a reader read written in, as a frozen or
// printed version keeps it. The frame shows the same values the same way: both walk the markup
// with `documentData`.

type Element = DefaultTreeAdapterTypes.Element
type ChildNode = DefaultTreeAdapterTypes.ChildNode

const isElement = (node: DefaultTreeAdapterTypes.Node): node is Element => "tagName" in node

const tree: DocumentTree<Element> = {
  children: (node) => node.childNodes.filter(isElement),
  attribute: (node, name) => node.attrs.find((each) => each.name === name)?.value ?? null,
  setAttribute(node, name, value) {
    const found = node.attrs.find((each) => each.name === name)
    if (found) found.value = value
    else node.attrs.push({ name, value })
  },
  removeAttribute(node, name) {
    node.attrs = node.attrs.filter((each) => each.name !== name)
  },
  setText(node, text) {
    for (const child of [...node.childNodes]) adapter.detachNode(child)
    adapter.insertText(node, text)
  },
  clone: (node) => copy(node) as Element,
  replace(node, nodes) {
    const parent = node.parentNode
    if (!parent) return
    for (const each of nodes) adapter.insertBefore(parent, each, node)
    adapter.detachNode(node)
  },
}

function copy(node: ChildNode): ChildNode {
  if (!isElement(node)) return { ...node, parentNode: null }
  const element = adapter.createElement(
    node.tagName,
    node.namespaceURI,
    node.attrs.map((each) => ({ ...each }))
  )
  for (const child of node.childNodes) adapter.appendChild(element, copy(child))
  return element
}

function bodyOf(html: string) {
  const document = parse(html)
  const root = document.childNodes.find(isElement)
  const body = root?.childNodes.find(
    (child): child is Element => isElement(child) && child.tagName === "body"
  )
  return { document, root, body }
}

/** The fields and repeated elements of a designed document's markup. */
export function documentMarks(html: string): DocumentMark[] {
  const { body } = bodyOf(html)
  return body ? documentData().marks(body, tree) : []
}

/**
 * A designed document's markup with the values `sources` hold written in. `plain` leaves no field
 * marked, as a frozen version is plain HTML. Markup with no field or repeated element is returned
 * as it is.
 */
export function fillDocumentHtml(
  html: string,
  sources: DocumentSources,
  options: { readonly plain?: boolean } = {}
): string {
  const { document, root, body } = bodyOf(html)
  if (!body || documentData().marks(body, tree).length === 0) return html

  const lang = root ? (tree.attribute(root, "lang") ?? undefined) : undefined
  documentData().fill(body, tree, {
    sources,
    ...(lang ? { lang } : {}),
    ...(options.plain ? { plain: true } : {}),
  })
  return serialize(document)
}
