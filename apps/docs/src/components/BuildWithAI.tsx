"use client"

import { ArrowUpRight, Check, Copy, X } from "lucide-react"
import { useId, useRef } from "react"

import { starterPrompt } from "../docs/starterPrompt"
import { useClipboard } from "./useClipboard"

export function BuildWithAI() {
  const dialog = useRef<HTMLDialogElement>(null)
  const prompt = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const { status, copy, reset } = useClipboard(starterPrompt)

  async function copyPrompt() {
    if ((await copy()) === false && dialog.current?.open) {
      prompt.current?.focus()
      prompt.current?.select()
    }
  }

  return (
    <>
      <button
        type="button"
        className="framework-example-link"
        aria-haspopup="dialog"
        onClick={() => {
          reset()
          dialog.current?.showModal()
        }}
      >
        Build with AI <ArrowUpRight size={14} aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className="framework-ai-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="framework-ai-heading">
          <h2 id={titleId}>Start with your coding agent</h2>
          <button
            type="button"
            className="framework-ai-close"
            aria-label="Close prompt"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p id={descriptionId}>Paste this into your agent, then tell it what you want to build.</p>
        <textarea
          ref={prompt}
          className="framework-ai-prompt"
          aria-label="Sixb starter prompt"
          value={starterPrompt}
          readOnly
          spellCheck={false}
        />
        <div className="framework-ai-footer">
          <span role="status">
            {status === "error"
              ? "Copy unavailable. The prompt is selected for manual copying."
              : status === "copied"
                ? "Copied. Ready for your agent."
                : "Works with your preferred coding agent."}
          </span>
          <button type="button" className="framework-start" onClick={copyPrompt}>
            {status === "copied" ? <Check size={15} /> : <Copy size={15} />}
            {status === "copied" ? "Copied" : "Copy prompt"}
          </button>
        </div>
      </dialog>
    </>
  )
}
