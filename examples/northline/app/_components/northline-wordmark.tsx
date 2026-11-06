import { cn } from "@sixb/ui/lib/utils"

export function NorthlineWordmark({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/brand/northline-wordmark.svg"
        alt="Northline Mechanical"
        className={cn("mx-auto block w-auto dark:hidden", className)}
      />
      <img
        src="/brand/northline-wordmark-light.svg"
        alt="Northline Mechanical"
        className={cn("mx-auto hidden w-auto dark:block", className)}
      />
    </>
  )
}

/** The Northline mark alone, for small, quiet places such as an empty conversation. */
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
