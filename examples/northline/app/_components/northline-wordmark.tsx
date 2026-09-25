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
