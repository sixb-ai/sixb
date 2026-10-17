import { isArtifactAddress } from "@sixb/core/artifacts"
import { defaultUrlTransform } from "@sixb/ui/components"

// The HTML tree react-markdown hands to rehype plugins, as far as this plugin reads it.
interface TreeText {
  readonly type: "text"
  readonly value: string
}
interface TreeElement {
  readonly type: "element"
  tagName: string
  properties: Record<string, unknown>
  children: TreeNode[]
}
interface TreeRoot {
  readonly type: "root"
  children: TreeNode[]
}
type TreeNode = TreeElement | TreeText | { readonly type: string }

/** The attribute that marks an embed in the tree, read back by the `div` that renders it. */
export const EMBED_ATTRIBUTE = "data-artifact-embed"

/**
 * Turns a paragraph that holds only an `artifact:` image into an embed block, so a table or chart
 * never lands inside a `<p>`. It runs before figures are shaped, so the image's alt text is its
 * caption. An `artifact:` image inside running text stays inline and shows as a link.
 */
export function rehypeArtifactEmbeds() {
  return (tree: TreeRoot) => visit(tree)
}

function visit(parent: TreeRoot | TreeElement): void {
  parent.children.forEach((child, index) => {
    if (!isElement(child)) return
    const embed = child.tagName === "p" ? loneArtifactImage(child) : undefined
    if (embed) {
      parent.children[index] = {
        type: "element",
        tagName: "div",
        properties: {
          [toProperty(EMBED_ATTRIBUTE)]: embed.address,
          dataCaption: embed.caption,
        },
        children: [],
      }
      return
    }
    visit(child)
  })
}

function loneArtifactImage(
  paragraph: TreeElement
): { readonly address: string; readonly caption: string } | undefined {
  const meaningful = paragraph.children.filter(
    (child) => !(child.type === "text" && !(child as TreeText).value.trim())
  )
  const [image] = meaningful
  if (meaningful.length !== 1 || !isElement(image) || image.tagName !== "img") return undefined
  const source = image.properties.src
  if (typeof source !== "string" || !isArtifactAddress(source)) return undefined
  const alt = image.properties.alt
  return { address: source.trim(), caption: typeof alt === "string" ? alt.trim() : "" }
}

function isElement(node: TreeNode | undefined): node is TreeElement {
  return node?.type === "element"
}

/** `data-artifact-embed` as hast names it: `dataArtifactEmbed`. */
function toProperty(attribute: string): string {
  return attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** Keeps `artifact:` URLs, which Markdown otherwise drops, and sanitizes the rest as before. */
export function artifactUrlTransform(url: string): string {
  return isArtifactAddress(url) ? url : defaultUrlTransform(url)
}

/** Embeds come first, so a lone `artifact:` image is an embed rather than a captioned figure. */
export const ARTIFACT_REHYPE_PLUGINS = [rehypeArtifactEmbeds]

/**
 * Keeps one section of a document: its heading and what follows, up to the next heading at its
 * depth or above. It runs after headings have their ids, which publishing named them by.
 */
export function rehypeKeepSection(slug: string) {
  return () => (tree: TreeRoot) => {
    const depth = (node: TreeNode) =>
      isElement(node) && /^h[1-6]$/.test(node.tagName) ? Number(node.tagName.slice(1)) : 0
    const start = tree.children.findIndex(
      (node) => depth(node) > 0 && isElement(node) && node.properties.id === slug
    )
    if (start === -1) {
      tree.children = []
      return
    }
    const level = depth(tree.children[start] as TreeNode)
    const end = tree.children.findIndex(
      (node, index) => index > start && depth(node) > 0 && depth(node) <= level
    )
    tree.children = tree.children.slice(start, end === -1 ? undefined : end)
  }
}
