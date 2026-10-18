// The HTML tree react-markdown hands to rehype plugins, typed only as far as the artifact plugins
// read and reshape it.

export interface TreeText {
  readonly type: "text"
  value: string
}

export interface TreeElement {
  readonly type: "element"
  tagName: string
  properties: Record<string, unknown>
  children: TreeNode[]
}

export type TreeNode = TreeElement | TreeText | { readonly type: string; children?: TreeNode[] }

export interface TreeRoot {
  readonly type: "root"
  children: TreeNode[]
}

export function isElement(node: TreeNode | undefined): node is TreeElement {
  return node?.type === "element"
}

/** An element's children without the whitespace between them, as a lone image's paragraph has. */
export function meaningfulChildren(element: TreeElement): TreeNode[] {
  return element.children.filter(
    (child) => !(child.type === "text" && !(child as TreeText).value.trim())
  )
}
