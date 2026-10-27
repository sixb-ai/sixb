import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Check } from "lucide-react"
import { type ReactNode, useEffect, useRef } from "react"

/**
 * The anatomy the composer's menus share (permissions, model, Auto): rows of an icon, a title and
 * a line of description, the choice in medium weight with its check at the trailing edge.
 */
const COMPOSER_MENU_CLASS_NAME =
  "w-[19rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-[18px] border-black/[0.06] p-0 shadow-[0_18px_50px_-18px_rgb(0_0_0/0.28),0_2px_8px_-2px_rgb(0_0_0/0.06)] dark:border-white/[0.08] dark:shadow-[0_18px_50px_-18px_rgb(0_0_0/0.8)]"

export const COMPOSER_MENU_ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-3 rounded-[10px] px-3 py-2 text-left outline-none transition-colors duration-100 hover:bg-black/[0.045] focus-visible:bg-black/[0.045] disabled:opacity-50 dark:hover:bg-white/[0.07] dark:focus-visible:bg-white/[0.07]"

/** A composer control that opens one of these menus: quiet medium text, filled while open. */
export const COMPOSER_TRIGGER_CLASS_NAME = cn(
  "flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors",
  "hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
  "disabled:cursor-default disabled:opacity-60 aria-expanded:bg-muted/60 aria-expanded:text-foreground"
)

/** The chosen row's resting highlight, as when the pointer is over it. */
export const COMPOSER_MENU_ROW_SELECTED_CLASS_NAME = "bg-black/[0.045] dark:bg-white/[0.07]"

/** The thinking slider's section under a model menu's list. */
export const COMPOSER_MENU_SECTION_CLASS_NAME =
  "shrink-0 border-t border-black/[0.06] px-4 pt-3 pb-3.5 dark:border-white/[0.07]"

export function ComposerMenuHeader({ children }: { readonly children: ReactNode }) {
  return <div className="px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{children}</div>
}

/** A row's title, the choice in medium weight, over a line that says what it does. */
export function ComposerMenuRowText({
  title,
  description,
  descriptionId,
  selected = false,
}: {
  readonly title: string
  readonly description: string
  readonly descriptionId: string
  readonly selected: boolean
}) {
  return (
    <span className="min-w-0 flex-1">
      <span
        className={cn(
          "block break-words text-[13.5px] tracking-[-0.005em] text-foreground",
          selected && "font-medium"
        )}
      >
        {title}
      </span>
      <span id={descriptionId} className="block text-xs leading-snug text-muted-foreground">
        {description}
      </span>
    </span>
  )
}

export function ComposerMenuCheck({ checked }: { readonly checked: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {checked ? (
        <Check className="size-4 text-foreground" strokeWidth={2.2} aria-hidden="true" />
      ) : null}
    </span>
  )
}

export function ComposerMenuDivider() {
  return <div className="mx-2.5 my-1 h-px bg-border/70" />
}

/**
 * A composer menu above its trigger, or a bottom sheet on a phone. `trigger` is the button that
 * opens it.
 */
export function ComposerMenu({
  open,
  onOpenChange,
  trigger,
  title,
  align,
  className,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly trigger: ReactNode
  /** Names the menu to assistive technology. */
  readonly title: string
  readonly align: "start" | "end"
  readonly className?: string
  readonly children: ReactNode
}) {
  const mobile = useIsMobile()

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[85dvh]">
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          <DrawerDescription className="sr-only">{title}</DrawerDescription>
          <div className="flex min-h-0 flex-col px-2 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align={align}
        side="top"
        sideOffset={10}
        collisionPadding={12}
        aria-label={title}
        // Capped by the viewport, not Radix's available-height variable: a size that depends on a
        // value Radix rewrites loops its resize observer.
        className={cn(
          COMPOSER_MENU_CLASS_NAME,
          "flex max-h-[min(32rem,calc(100dvh-8rem))] flex-col",
          className
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

/**
 * A menu's scrolling list, fading out at the bottom while more is below, so a cut-off row reads as
 * "more" rather than broken.
 */
export function ComposerMenuScroll({ className, children, ...props }: React.ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const more = element.scrollTop + element.clientHeight < element.scrollHeight - 2
      element.toggleAttribute("data-more", more)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      element.removeEventListener("scroll", update)
    }
  }, [])

  return (
    <div
      ref={ref}
      {...props}
      className={cn(
        "scrollbar-thin min-h-0 overflow-y-auto data-[more]:[mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]",
        className
      )}
    >
      {children}
    </div>
  )
}
