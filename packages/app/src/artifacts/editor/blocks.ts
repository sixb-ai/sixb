import type { Editor, Range } from "@tiptap/core"
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
import type { EditorMessages } from "./messages"

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
  const chain = (editor: Editor, range?: Range) => {
    const start = editor.chain().focus()
    return range ? start.deleteRange(range) : start
  }
  return [
    {
      id: "paragraph",
      icon: Type,
      ...messages.paragraph,
      keywords: ["text", "plain", "p"],
      turnsInto: true,
      make: (editor, range) => chain(editor, range).setParagraph().run(),
      isActive: (editor) =>
        editor.isActive("paragraph") &&
        !editor.isActive("bulletList") &&
        !editor.isActive("orderedList") &&
        !editor.isActive("taskList") &&
        !editor.isActive("blockquote") &&
        !editor.isActive("callout"),
    },
    ...([1, 2, 3] as const).map(
      (level): BlockType => ({
        id: `heading${level}`,
        icon: [Heading1, Heading2, Heading3][level - 1] as LucideIcon,
        ...messages[`heading${level}`],
        keywords: ["title", "heading", `h${level}`],
        shortcut: `${"#".repeat(level)} `,
        turnsInto: true,
        make: (editor, range) => chain(editor, range).setHeading({ level }).run(),
        isActive: (editor) => editor.isActive("heading", { level }),
      })
    ),
    {
      id: "bulletList",
      icon: List,
      ...messages.bulletList,
      keywords: ["bullet", "unordered", "list", "ul"],
      shortcut: "- ",
      turnsInto: true,
      make: (editor, range) => chain(editor, range).toggleBulletList().run(),
      isActive: (editor) => editor.isActive("bulletList"),
    },
    {
      id: "orderedList",
      icon: ListOrdered,
      ...messages.orderedList,
      keywords: ["number", "ordered", "list", "ol"],
      shortcut: "1. ",
      turnsInto: true,
      make: (editor, range) => chain(editor, range).toggleOrderedList().run(),
      isActive: (editor) => editor.isActive("orderedList"),
    },
    {
      id: "taskList",
      icon: CheckSquare,
      ...messages.taskList,
      keywords: ["todo", "task", "check", "checkbox"],
      shortcut: "[] ",
      turnsInto: true,
      make: (editor, range) => chain(editor, range).toggleTaskList().run(),
      isActive: (editor) => editor.isActive("taskList"),
    },
    {
      id: "quote",
      icon: Quote,
      ...messages.quote,
      keywords: ["quote", "blockquote", "citation"],
      shortcut: "> ",
      turnsInto: true,
      make: (editor, range) => chain(editor, range).toggleBlockquote().run(),
      isActive: (editor) => editor.isActive("blockquote"),
    },
    {
      id: "callout",
      icon: Info,
      ...messages.callout,
      keywords: ["callout", "note", "info", "tip", "aside"],
      turnsInto: true,
      make: (editor, range) => chain(editor, range).wrapIn("callout", { kind: "note" }).run(),
      isActive: (editor) => editor.isActive("callout", { kind: "note" }),
    },
    {
      id: "warning",
      icon: AlertTriangle,
      ...messages.warning,
      keywords: ["callout", "warning", "caution", "alert"],
      turnsInto: true,
      make: (editor, range) => chain(editor, range).wrapIn("callout", { kind: "warning" }).run(),
      isActive: (editor) => editor.isActive("callout", { kind: "warning" }),
    },
    {
      id: "codeBlock",
      icon: Code2,
      ...messages.codeBlock,
      keywords: ["code", "snippet", "pre", "monospace"],
      shortcut: "``` ",
      turnsInto: true,
      make: (editor, range) => chain(editor, range).toggleCodeBlock().run(),
      isActive: (editor) => editor.isActive("codeBlock"),
    },
    {
      id: "table",
      icon: Table2,
      ...messages.table,
      keywords: ["table", "grid", "rows", "columns"],
      turnsInto: false,
      make: (editor, range) =>
        chain(editor, range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
      isActive: (editor) => editor.isActive("table"),
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
              chain(editor, range).run()
              options.pickImage?.()
            },
            isActive: (editor: Editor) => editor.isActive("image"),
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
      make: (editor, range) => chain(editor, range).setHorizontalRule().run(),
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
