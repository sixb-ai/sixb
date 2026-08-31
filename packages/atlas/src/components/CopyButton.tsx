import { Button } from "@sixb/ui/components"
import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // Clipboard access can be denied; fail silently.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      onClick={onCopy}
      aria-label={label}
      title={label}
      className="shrink-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy />}
    </Button>
  )
}
