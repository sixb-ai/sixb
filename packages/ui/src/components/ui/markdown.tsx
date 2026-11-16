import { badgeLabel, getCachedHighlight, highlightCode, isPlainCodeLang } from "@sixb/ui/lib/shiki"
import { cn } from "@sixb/ui/lib/utils"
import { Check, Copy } from "lucide-react"
import {
  type ComponentProps,
  type ComponentType,
  type Context,
  createContext,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useUiMessages } from "../../lib/i18n/ui"

// GitHub-flavored markdown: tables, strikethrough, task lists, footnotes, and autolinks — matching
// the docs site's `Bun.markdown` options so both surfaces render the same constructs.
const REMARK_PLUGINS = [remarkGfm]

// Lazy-initialized so barrel imports of @sixb/ui/components never evaluate side effects or pull
// Shiki into apps that do not render Markdown.
let insidePreContext: Context<boolean> | null = null
let memoizedCodeBlock: ComponentType<{ lang: string; code: string }> | null = null

function getInsidePreContext(): Context<boolean> {
  insidePreContext ??= createContext(false)
  return insidePreContext
}

function getMemoizedCodeBlock(): ComponentType<{ lang: string; code: string }> {
  memoizedCodeBlock ??= memo(CodeBlock)
  return memoizedCodeBlock
}

// react-markdown builds a React element tree (no `dangerouslySetInnerHTML`) and never renders raw
// HTML unless a rehype-raw plugin is added, so untrusted content cannot inject markup. URLs go
// through react-markdown's default transform, which strips unsafe schemes like `javascript:`.
const COMPONENTS: Components = {
  a({ node: _node, href, ...props }) {
    const external = typeof href === "string" && !href.startsWith("#")
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
        {...props}
      />
    )
  },
  // Fenced and indented blocks are rendered by `CodeBlock`; `pre` is unwrapped so the block's
  // `<figure>` isn't nested inside a `<pre>`, while `InsidePreContext` distinguishes block code
  // without a language tag from inline backticks.
  pre({ children }) {
    const PreContext = getInsidePreContext()
    return <PreContext.Provider value={true}>{children}</PreContext.Provider>
  },
  // A wide table scrolls inside its own box instead of squeezing a narrow column, and a short
  // cell (an id, an amount, a date) stays on one line.
  table({ node: _node, children, ...props }) {
    return <ScrollTable {...props}>{children}</ScrollTable>
  },
  th({ node: _node, children, className, ...props }) {
    return (
      <th
        className={cn(textLength(children) <= SHORT_CELL && "whitespace-nowrap", className)}
        {...props}
      >
        {children}
      </th>
    )
  },
  td({ node: _node, children, className, ...props }) {
    return (
      <td
        className={cn(textLength(children) <= SHORT_CELL && "whitespace-nowrap", className)}
        {...props}
      >
        {children}
      </td>
    )
  },
  code({ node: _node, ...props }) {
    return <MarkdownCode {...props} />
  },
}

const SHORT_CELL = 24

function MarkdownCode({ className, children, ...props }: ComponentProps<"code">) {
  const insidePre = useContext(getInsidePreContext())
  const match = /language-([^\s]+)/.exec(className ?? "")
  if (!insidePre && !match) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  }
  const MemoCodeBlock = getMemoizedCodeBlock()
  return <MemoCodeBlock lang={match?.[1] ?? ""} code={codeText(children).replace(/\n$/, "")} />
}

/** A table that scrolls sideways, its edges fading only where columns are scrolled out of view. */
function ScrollTable({ children, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState({ start: false, end: false })

  useEffect(() => {
    const box = ref.current
    if (!box) return
    const update = () => {
      const start = box.scrollLeft > 1
      const end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1
      setHidden((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    update()
    box.addEventListener("scroll", update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(box)
    return () => {
      box.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [])

  return (
    <div
      ref={ref}
      className="prose-table"
      data-hidden-start={hidden.start ? "" : undefined}
      data-hidden-end={hidden.end ? "" : undefined}
    >
      <table {...props}>{children}</table>
    </div>
  )
}

function codeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(codeText).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) return codeText(node.props.children)
  return ""
}

function textLength(node: ReactNode): number {
  if (typeof node === "string" || typeof node === "number") return String(node).length
  if (Array.isArray(node))
    return node.reduce((total: number, child) => total + textLength(child), 0)
  if (isValidElement<{ children?: ReactNode }>(node)) return textLength(node.props.children)
  return 0
}

export interface MarkdownProps extends Omit<ComponentProps<"div">, "children"> {
  /** The markdown source to render. */
  readonly children: string
  /** Element renderers that replace the defaults, such as an `img` that resolves relative paths. */
  readonly components?: Components
  /** HTML-tree plugins run after the built-in ones, such as heading ids or callouts. */
  readonly rehypePlugins?: Options["rehypePlugins"]
  /**
   * Rewrites each link and image URL. The default keeps only safe schemes; a host that renders its
   * own scheme passes a transform that keeps it and defers the rest to `defaultUrlTransform`.
   */
  readonly urlTransform?: Options["urlTransform"]
}

/**
 * Render a markdown string with the shared `.prose` style (see `@sixb/ui/globals.css`) and
 * Shiki-highlighted code blocks. Safe for untrusted input — no raw HTML, sanitized link targets.
 */
function Markdown({
  children,
  className,
  components,
  rehypePlugins,
  urlTransform,
  ...props
}: MarkdownProps) {
  const mergedComponents = useMemo(
    () => (components ? { ...COMPONENTS, ...components } : COMPONENTS),
    [components]
  )
  return (
    <div data-slot="markdown" className={cn("prose", className)} {...props}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
        {...(urlTransform ? { urlTransform } : {})}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const messages = useUiMessages()
  const plain = isPlainCodeLang(lang)
  const cached = plain ? null : getCachedHighlight(code, lang)
  const [asyncHtml, setAsyncHtml] = useState<string | null>(cached)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestRef = useRef({ code, lang })
  const busyRef = useRef(false)
  const mountedRef = useRef(false)
  latestRef.current = { code, lang }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Coalesce rapid streaming updates so at most one Shiki pass runs at a time, always catching up
  // to the latest code snapshot without queuing intermediate token deltas. Only unmounting stops a
  // pass: code that arrives while one runs is left to that pass, which highlights it next.
  useEffect(() => {
    if (plain) {
      setAsyncHtml(null)
      return
    }
    const immediate = getCachedHighlight(code, lang)
    if (immediate !== null) {
      setAsyncHtml(immediate)
      return
    }
    if (busyRef.current) return

    const drain = async () => {
      busyRef.current = true
      try {
        while (mountedRef.current) {
          const target = latestRef.current
          if (isPlainCodeLang(target.lang)) break
          const result = await highlightCode(target.code, target.lang)
          if (!mountedRef.current) break
          setAsyncHtml(result)
          if (target.code === latestRef.current.code && target.lang === latestRef.current.lang) {
            break
          }
        }
      } finally {
        busyRef.current = false
      }
    }
    void drain()
  }, [code, lang, plain])

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); ignore.
    }
  }

  const html = cached ?? (plain ? null : asyncHtml)
  const badge = badgeLabel(lang)
  const copyButton = (
    <button
      type="button"
      className={cn("code-copy", !badge && "code-copy-floating", copied && "is-copied")}
      onClick={copy}
      aria-label={copied ? messages.status.copied : messages.status.copyCode}
    >
      <Copy className="code-copy-copy" aria-hidden="true" />
      <Check className="code-copy-check" aria-hidden="true" />
    </button>
  )

  return (
    <figure className={cn("code-block", !badge && "code-block-bare")}>
      {badge ? (
        <figcaption className="code-bar">
          <span className="code-bar-left">
            <span className="code-badge">{badge}</span>
          </span>
          {copyButton}
        </figcaption>
      ) : (
        copyButton
      )}
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

export { defaultUrlTransform, Markdown }
