import { cn } from "@sixb/ui/lib/utils"
import type { LanguageModel } from "../types"
import { providerLogoPath } from "./provider-logos"

export function ProviderLogo({ model, className }: { model: LanguageModel; className?: string }) {
  const path = providerLogoPath(model.publisher.id)
  if (path) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        className={cn("shrink-0 text-foreground", className)}
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    )
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center text-xs font-bold text-foreground",
        className
      )}
    >
      {model.publisher.name.charAt(0).toUpperCase()}
    </span>
  )
}
