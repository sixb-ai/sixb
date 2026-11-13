// What the editor adds to a page's own styles while it is edited: as little as typing needs, and
// nothing the page's stylesheets do not override, so the page looks as it reads.

export const PAGE_EDITOR_CSS = `
body.ProseMirror { outline: none; white-space: pre-wrap; word-wrap: break-word; }
body.ProseMirror :where([data-sixb-raw]) { white-space: normal; cursor: default; }
body.ProseMirror .ProseMirror-selectednode { outline: 2px solid #0a84ff; outline-offset: 2px; border-radius: 2px; }
body.ProseMirror ::selection { background: rgba(10, 132, 255, 0.22); }
body.ProseMirror .ProseMirror-selectednode::selection,
body.ProseMirror .ProseMirror-selectednode ::selection { background: transparent; }
body.ProseMirror :where([data-sixb-field]) {
  border-radius: 3px;
  background: rgba(10, 132, 255, 0.08);
  box-shadow: 0 0 0 1px rgba(10, 132, 255, 0.28);
}
body.ProseMirror .is-empty[data-placeholder]::before {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  color: currentColor;
  opacity: 0.38;
  pointer-events: none;
}
body.ProseMirror .sixb-page-break { position: relative; user-select: none; }
body.ProseMirror .sixb-page-break::after {
  content: attr(data-label);
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #71717a;
  font: 500 10px/1 system-ui, -apple-system, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.sixb-caret {
  position: relative;
  margin-inline: -1px;
  border-left: 2px solid var(--caret);
  word-break: normal;
  pointer-events: none;
}
.sixb-caret-label {
  position: absolute;
  bottom: 100%;
  left: -2px;
  padding: 1px 6px;
  border-radius: 6px 6px 6px 0;
  background: var(--caret);
  color: #fff;
  font: 600 11px/1.5 system-ui, -apple-system, sans-serif;
  font-style: normal;
  white-space: nowrap;
  user-select: none;
}
.sixb-caret-selection { background: color-mix(in oklab, var(--caret) 22%, transparent); }
`
