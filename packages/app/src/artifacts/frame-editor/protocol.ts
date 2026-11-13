// What the app and a designed document's editor in its frame say to each other, through the port
// the app hands the frame with the `editor` request, where the page's own scripts never post.
//
//   app ── start ────▶ frame   the live document's state, the page's path, the blocks it offers
//       ── update ───▶         what changed in the live document, from others or the Agent
//       ── awareness ▶         where everyone else's carets are
//       ── run ──────▶         what the reader chose in the app's menus and toolbar
//       ◀─ update ───          what the reader changed
//       ◀─ cursor ───          where the reader's caret is, for everyone else
//       ◀─ selection, slash, hover, drop   what the app draws over the frame, in its coordinates
//       ◀─ upload ───          pictures the reader pasted or dropped, for the app to store
//
// The frame keeps a copy of the live document and edits it with TipTap, as a Markdown document is
// edited, so the two stay in step by Yjs updates alone. Everything the reader sees around the
// page, menus and toolbars and the block handle, the app draws, in its own design.

/** The kinds of block the editor makes, as the `/` menu and "Turn into" offer them. */
export type PageBlockId =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulletList"
  | "orderedList"
  | "quote"
  | "table"
  | "image"
  | "divider"
  | "pageBreak"

/** A kind of block, as the frame finds it by what the reader types after `/`. */
export interface PageBlockChoice {
  readonly id: PageBlockId
  readonly label: string
  readonly keywords: readonly string[]
}

/** A rectangle in the frame's viewport, which is where the app's overlay draws. */
export interface EditorRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The marks of selected words the toolbar shows. */
export type PageMark = "bold" | "italic" | "underline" | "strike" | "code"

export type EditorCommand =
  | { readonly name: "mark"; readonly mark: PageMark }
  | { readonly name: "link"; readonly href: string | null }
  | { readonly name: "turnInto"; readonly block: PageBlockId; readonly pos?: number }
  /** Chooses the `/` menu's item at `index`, as Enter does. */
  | { readonly name: "choose"; readonly index: number }
  /** Points the `/` menu at its item at `index`, as the arrows do. */
  | { readonly name: "point"; readonly index: number }
  | { readonly name: "closeMenu" }
  /** Adds a paragraph below the block at `pos` and opens the `/` menu in it. */
  | { readonly name: "addBelow"; readonly pos: number }
  | { readonly name: "duplicate"; readonly pos: number }
  | { readonly name: "remove"; readonly pos: number }
  | { readonly name: "move"; readonly pos: number; readonly by: -1 | 1 }
  /** Picks the block at `pos` whole, as its handle's menu acts on it. */
  | { readonly name: "pick"; readonly pos: number }
  /** A drag of the block at `pos` by its handle, the pointer at `x`, `y`. */
  | { readonly name: "drag"; readonly pos: number; readonly x: number; readonly y: number }
  | { readonly name: "drop"; readonly pos: number; readonly x: number; readonly y: number }
  | { readonly name: "endDrag" }
  /**
   * A picture the app stored for the reader, at the path its source names; `preview` shows it
   * until a version of the document holds it.
   */
  | {
      readonly name: "image"
      readonly src: string
      readonly alt: string
      readonly at?: number
      readonly preview?: Blob
    }
  | { readonly name: "focus" }

export type AppToEditor =
  | {
      readonly type: "start"
      /** The live document, as `Y.encodeStateAsUpdate` encodes it. */
      readonly state: Uint8Array
      readonly path: string
      readonly editable: boolean
      readonly blocks: readonly PageBlockChoice[]
      /** Words the editor shows itself, in the reader's language. */
      readonly words: EditorWords
    }
  | { readonly type: "update"; readonly update: Uint8Array }
  | { readonly type: "awareness"; readonly update: Uint8Array }
  | { readonly type: "editable"; readonly editable: boolean }
  | { readonly type: "run"; readonly command: EditorCommand }

export interface EditorWords {
  readonly placeholder: string
  readonly listItem: string
  /** An empty heading's placeholder, by level from 1. */
  readonly headings: readonly string[]
  readonly pageBreak: string
}

/** What the toolbar over selected words shows; null when no words are selected. */
export interface SelectionState {
  readonly rect: EditorRect
  readonly marks: Readonly<Record<PageMark, boolean>>
  readonly link: string | null
  readonly block: PageBlockId | null
  /** Whether the words' block may be turned into another kind: not a cell or a caption. */
  readonly turnable: boolean
}

/** The `/` menu: where the `/` is, the kinds of block that match what follows it, the one pointed at. */
export interface SlashState {
  readonly rect: EditorRect
  readonly items: readonly PageBlockId[]
  readonly index: number
}

/** The block the pointer is over, which the handle sits beside. */
export interface HoverState {
  readonly pos: number
  readonly rect: EditorRect
  /** Whether "Turn into" changes it: words that stand where any block may. */
  readonly textual: boolean
}

export type EditorToApp =
  | { readonly type: "ready" }
  /** The page is no longer one the editor holds: the live document holds it as text now. */
  | { readonly type: "gone" }
  | { readonly type: "update"; readonly update: Uint8Array }
  | { readonly type: "cursor"; readonly cursor: unknown }
  | { readonly type: "focus"; readonly focused: boolean }
  | { readonly type: "selection"; readonly selection: SelectionState | null }
  | { readonly type: "slash"; readonly slash: SlashState | null }
  | { readonly type: "hover"; readonly hover: HoverState | null }
  /** Where a block dragged by its handle would land: a line across the page. */
  | { readonly type: "drop"; readonly line: EditorRect | null }
  /** ⌘K over selected words: the app opens the toolbar's link field. */
  | { readonly type: "linkRequest" }
  /** Pictures the reader pasted or dropped, to add at the block at `at`. */
  | { readonly type: "upload"; readonly files: readonly File[]; readonly at: number | null }
  /** The reader chose a picture from the `/` menu: the app asks them for the file. */
  | { readonly type: "pickImage"; readonly at: number | null }

/** The global the editor's script sets as it runs, which the frame's runtime takes at once. */
export const FRAME_EDITOR_GLOBAL = "__sixbFrameEditor"
