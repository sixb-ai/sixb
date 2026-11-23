import {
  AlertTriangle,
  CheckSquare,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  ImageIcon,
  Info,
  Lightbulb,
  List,
  ListOrdered,
  type LucideIcon,
  Minus,
  Quote,
  Table2,
  Type,
} from "lucide-react"
import {
  type Command,
  insertContentAt,
  isNodeActive,
  setNode,
  toggleList,
  toggleNode,
  toggleWrap,
  wrapIn,
} from "./core/commands"
import type { Editor } from "./core/editor"
import type { MarkType, NodeType } from "./core/model"
import { NodeSelection, TextSelection } from "./core/state"
import type { EditorMessages } from "./messages"
import { documentSchema } from "./schema"

// The blocks a person can make, as the `/` menu lists them and "Turn into" offers them: each with
// its icon, its words, what to type to find it, its Markdown shortcut, and how it is made.

export type BlockTypeId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "quote"
  | "callout"
  | "warning"
  | "codeBlock"
  | "table"
  | "image"
  | "divider"

/** A range of the document: what the `/` and its query span. */
export interface Range {
  readonly from: number
  readonly to: number
}

export interface BlockType {
  readonly id: BlockTypeId
  readonly icon: LucideIcon
  readonly label: string
  readonly description: string
  /** Words besides its label it is found by. */
  readonly keywords: readonly string[]
  /** What typed at the start of a line makes it. */
  readonly shortcut?: string
  /** Whether a block of text may be turned into it, keeping its words. */
  readonly turnsInto: boolean
  /** Makes it, in place of `range` when given (the typed `/` and query). */
  readonly make: (editor: Editor, range?: Range) => void
  /** Whether the block the selection is in is one. */
  readonly isActive: (editor: Editor) => boolean
}

/** A kind of block as the menus show it, whichever editor makes it. */
export type BlockChoice = Pick<
  BlockType,
  "icon" | "label" | "description" | "keywords" | "shortcut" | "turnsInto"
> & { readonly id: string }

/**
 * The blocks a person can make. `pickImage` is how an image is chosen, which the `/` menu offers
 * where the editor can upload one.
 */
export function blockTypes(
  messages: EditorMessages["blocks"],
  options: { readonly pickImage?: () => void } = {}
): readonly BlockType[] {
  const nodes = documentSchema.nodes as Record<string, NodeType>
  const isList = (type: NodeType) => type.isInGroup("list")
  // Makes a block in place of the typed `/` and query, and puts the focus back.
  const make = (editor: Editor, range: Range | undefined, command: Command) => {
    editor.run((tr) => {
      if (range) tr.deleteRange(range.from, range.to)
      command(tr)
      return true
    })
    editor.focus()
  }
  const active = (editor: Editor, type: string, attrs: Record<string, unknown> = {}) =>
    isNodeActive(editor.state.tr, nodes[type] as NodeType, attrs)
  return [
    {
      id: "paragraph",
      icon: Type,
      ...messages.paragraph,
      keywords: ["text", "plain", "p"],
      turnsInto: true,
      make: (editor, range) => make(editor, range, setNode(nodes.paragraph as NodeType)),
      isActive: (editor) =>
        active(editor, "paragraph") &&
        !active(editor, "bulletList") &&
        !active(editor, "orderedList") &&
        !active(editor, "taskList") &&
        !active(editor, "blockquote") &&
        !active(editor, "callout"),
    },
    ...([1, 2, 3] as const).map(
      (level): BlockType => ({
        id: `heading${level}`,
        icon: [Heading1, Heading2, Heading3][level - 1] as LucideIcon,
        ...messages[`heading${level}`],
        keywords: ["title", "heading", `h${level}`],
        shortcut: `${"#".repeat(level)} `,
        turnsInto: true,
        make: (editor, range) => make(editor, range, setNode(nodes.heading as NodeType, { level })),
        isActive: (editor) => active(editor, "heading", { level }),
      })
    ),
    {
      id: "bulletList",
      icon: List,
      ...messages.bulletList,
      keywords: ["bullet", "unordered", "list", "ul"],
      shortcut: "- ",
      turnsInto: true,
      make: (editor, range) =>
        make(
          editor,
          range,
          toggleList(nodes.bulletList as NodeType, nodes.listItem as NodeType, isList)
        ),
      isActive: (editor) => active(editor, "bulletList"),
    },
    {
      id: "orderedList",
      icon: ListOrdered,
      ...messages.orderedList,
      keywords: ["number", "ordered", "list", "ol"],
      shortcut: "1. ",
      turnsInto: true,
      make: (editor, range) =>
        make(
          editor,
          range,
          toggleList(nodes.orderedList as NodeType, nodes.listItem as NodeType, isList)
        ),
      isActive: (editor) => active(editor, "orderedList"),
    },
    {
      id: "taskList",
      icon: CheckSquare,
      ...messages.taskList,
      keywords: ["todo", "task", "check", "checkbox"],
      shortcut: "[] ",
      turnsInto: true,
      make: (editor, range) =>
        make(
          editor,
          range,
          toggleList(nodes.taskList as NodeType, nodes.taskItem as NodeType, isList)
        ),
      isActive: (editor) => active(editor, "taskList"),
    },
    {
      id: "quote",
      icon: Quote,
      ...messages.quote,
      keywords: ["quote", "blockquote", "citation"],
      shortcut: "> ",
      turnsInto: true,
      make: (editor, range) => make(editor, range, toggleWrap(nodes.blockquote as NodeType)),
      isActive: (editor) => active(editor, "blockquote"),
    },
    {
      id: "callout",
      icon: Info,
      ...messages.callout,
      keywords: ["callout", "note", "info", "tip", "aside"],
      turnsInto: true,
      make: (editor, range) =>
        make(editor, range, wrapIn(nodes.callout as NodeType, { kind: "note" })),
      isActive: (editor) => active(editor, "callout", { kind: "note" }),
    },
    {
      id: "warning",
      icon: AlertTriangle,
      ...messages.warning,
      keywords: ["callout", "warning", "caution", "alert"],
      turnsInto: true,
      make: (editor, range) =>
        make(editor, range, wrapIn(nodes.callout as NodeType, { kind: "warning" })),
      isActive: (editor) => active(editor, "callout", { kind: "warning" }),
    },
    {
      id: "codeBlock",
      icon: Code2,
      ...messages.codeBlock,
      keywords: ["code", "snippet", "pre", "monospace"],
      shortcut: "``` ",
      turnsInto: true,
      make: (editor, range) =>
        make(editor, range, toggleNode(nodes.codeBlock as NodeType, nodes.paragraph as NodeType)),
      isActive: (editor) => active(editor, "codeBlock"),
    },
    {
      id: "table",
      icon: Table2,
      ...messages.table,
      keywords: ["table", "grid", "rows", "columns"],
      turnsInto: false,
      make: (editor, range) => make(editor, range, insertTable),
      isActive: (editor) => active(editor, "table"),
    },
    ...(options.pickImage
      ? [
          {
            id: "image",
            icon: ImageIcon,
            ...messages.image,
            keywords: ["image", "picture", "photo", "upload", "figure"],
            turnsInto: false,
            make: (editor: Editor, range?: Range) => {
              make(editor, range, () => true)
              options.pickImage?.()
            },
            isActive: (editor: Editor) => active(editor, "image"),
          } satisfies BlockType,
        ]
      : []),
    {
      id: "divider",
      icon: Minus,
      ...messages.divider,
      keywords: ["divider", "rule", "line", "separator", "hr"],
      shortcut: "--- ",
      turnsInto: false,
      make: (editor, range) => make(editor, range, setHorizontalRule),
      isActive: () => false,
    },
  ]
}

/** The icon a callout of `kind` shows. */
export function calloutIcon(kind: string): LucideIcon {
  if (kind === "warning" || kind === "caution") return AlertTriangle
  if (kind === "tip") return Lightbulb
  return Info
}

/** A table of three rows and three columns, its first row headers, the caret in its first cell. */
const insertTable: Command = (tr) => {
  const nodes = documentSchema.nodes as Record<string, NodeType>
  const row = (cell: NodeType) =>
    (nodes.tableRow as NodeType).create(
      null,
      [0, 1, 2].map(() => cell.createAndFill() as import("./core/model").Node)
    )
  const table = (nodes.table as NodeType).create(null, [
    row(nodes.tableHeader as NodeType),
    row(nodes.tableCell as NodeType),
    row(nodes.tableCell as NodeType),
  ])
  const offset = tr.selection.from + 1
  tr.replaceSelectionWith(table).scrollIntoView()
  tr.setSelection(TextSelection.near(tr.doc.resolve(offset)))
  return true
}

/** A rule where the caret is, and a paragraph after it to go on typing in. */
const setHorizontalRule: Command = (tr) => {
  const nodes = documentSchema.nodes as Record<string, NodeType>
  const { selection } = tr
  const rule = (nodes.horizontalRule as NodeType).create()
  if (selection instanceof NodeSelection) insertContentAt(selection.$to.pos, rule)(tr)
  else insertContentAt({ from: selection.from, to: selection.to }, rule)(tr)
  const { $to } = tr.selection
  const posAfter = $to.end()
  if ($to.nodeAfter) {
    if ($to.nodeAfter.isTextblock) tr.setSelection(TextSelection.create(tr.doc, $to.pos + 1))
    else if ($to.nodeAfter.isBlock) tr.setSelection(NodeSelection.create(tr.doc, $to.pos))
    else tr.setSelection(TextSelection.create(tr.doc, $to.pos))
  } else {
    tr.insert(posAfter, (nodes.paragraph as NodeType).create())
    tr.setSelection(TextSelection.create(tr.doc, posAfter + 1))
  }
  tr.scrollIntoView()
  return true
}

export type { MarkType }
