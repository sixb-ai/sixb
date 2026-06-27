import { badgeLabel, highlightCode } from "@sixb/ui/lib/shiki"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Copy } from "lucide-react"
import type * as React from "react"
import { useEffect, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

// GitHub-flavored markdown: tables, strikethrough, task lists, and autolinks — matching the docs
// site's `Bun.markdown` options so both surfaces render the same constructs.
const REMARK_PLUGINS = [remarkGfm]

// react-markdown builds a React element tree (no `dangerouslySetInnerHTML`) and never renders raw
// HTML unless a rehype-raw plugin is added, so untrusted content cannot inject markup. URLs go
// through react-markdown's default transform, which strips unsafe schemes like `javascript:`.
const COMPONENTS: Components = {
  a({ node: _node, ...props }) {
    return <a {...props} target="_blank" rel="noreferrer noopener" />
  },
  // Fenced blocks are rendered by `CodeBlock`; `pre` is unwrapped so the block's `<figure>` isn't
  // nested inside a `<pre>`. Inline code falls through to a plain `<code>` (styled by `.prose`).
  pre({ children }) {
    return <>{children}</>
  },
  code({ node: _node, className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? "")
    if (!match) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return <CodeBlock lang={match[1]} code={String(children).replace(/\n$/, "")} />
  },
}

export interface MarkdownProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** The markdown source to render. */
  readonly children: string
}

/**
 * Render a markdown string with the shared `.prose` style (see `@sixb/ui/globals.css`) and
 * Shiki-highlighted code blocks. Safe for untrusted input — no raw HTML, sanitized link targets.
 */
function Markdown({ children, className, ...props }: MarkdownProps) {
  return (
    <div data-slot="markdown" className={cn("prose", className)} {...props}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Re-highlight when the code changes (e.g. while a code block streams in).
  useEffect(() => {
    let active = true
    void highlightCode(code, lang).then((result) => {
      if (active) setHtml(result)
    })
    return () => {
      active = false
    }
  }, [code, lang])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); ignore.
    }
  }

  return (
    <figure className="code-block">
      <figcaption className="code-bar">
        <span className="code-bar-left">
          <span className="code-badge">{badgeLabel(lang)}</span>
        </span>
        <button
          type="button"
          className={cn("code-copy", copied && "is-copied")}
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          <Copy className="code-copy-copy" aria-hidden="true" />
          <Check className="code-copy-check" aria-hidden="true" />
        </button>
      </figcaption>
      {html ? (
        // Shiki output: the code text is escaped by Shiki, so this is safe to inject.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted Shiki-generated markup
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki">
          <code>{code}</code>
        </pre>
      )}
    </figure>
  )
}

export { Markdown }
