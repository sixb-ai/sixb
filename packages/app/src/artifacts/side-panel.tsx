import { cn } from "@sixb/ui/lib/utils"
import { X } from "lucide-react"
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react"

/**
 * A panel beside what the viewer shows, such as its comments or a video's chapters: a column on
 * its right once the nearest container is wide, a sheet over its foot while it is narrow, as on a
 * phone. `inline`, it fills the room it is given instead, as under a phone's video. Its title, how
 * many it holds, the actions it offers, and Close head it.
 */
export function SidePanel({
  label,
  title,
  count,
  actions,
  closeLabel,
  onClose,
  inline = false,
  className,
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<"aside">, "title"> & {
  readonly label: string
  readonly title: string
  /** Shown beside the title, unless none. */
  readonly count?: number
  readonly actions?: ReactNode
  readonly closeLabel: string
  readonly onClose: () => void
  readonly inline?: boolean
}) {
  return (
    <aside
      aria-label={label}
      className={cn(
        "flex flex-col bg-background text-foreground",
        inline
          ? "min-h-0 flex-1"
          : [
              "absolute inset-x-0 bottom-0 z-30 max-h-[68%] rounded-t-2xl border-t border-border shadow-[0_-12px_32px_-18px_rgb(0_0_0/0.35)]",
              "motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in-0",
              "@3xl:relative @3xl:inset-auto @3xl:z-auto @3xl:h-full @3xl:max-h-none @3xl:w-[22rem] @3xl:shrink-0 @3xl:rounded-none @3xl:border-t-0 @3xl:border-l @3xl:shadow-none @3xl:slide-in-from-right-4 @3xl:slide-in-from-bottom-0",
            ],
        className
      )}
      {...props}
    >
      {inline ? null : (
        <span
          aria-hidden="true"
          className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border @3xl:hidden"
        />
      )}
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        {count ? (
          <span className="rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
            {count}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <IconButton label={closeLabel} onClick={onClose}>
            <X />
          </IconButton>
        </div>
      </header>

      {children}
    </aside>
  )
}

/** A quiet icon button; a menu's trigger takes it as its own. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { readonly label: string }
>(function IconButton({ label, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted [&_svg]:size-4"
      {...props}
    >
      {children}
    </button>
  )
})
