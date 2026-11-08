import { cn } from "@sixb/ui/lib/utils"

/** The Northline mark, with a light variant for dark mode. */
export function NorthlineMark({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/brand/northline-mark.svg"
        alt="Northline"
        className={cn("mx-auto block dark:hidden", className)}
      />
      <img
        src="/brand/northline-mark-light.svg"
        alt="Northline"
        className={cn("mx-auto hidden dark:block", className)}
      />
    </>
  )
}
