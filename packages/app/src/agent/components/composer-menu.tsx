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
import { type ReactNode, useEffect, useRef } from "react"

/**
 * The anatomy the composer's menus share (`+`, the model and permissions): frosted glass, rows of
 * an icon and a title, the choice marked by a resting highlight rather than a check.
 */
export const COMPOSER_MENU_ROW_CLASS_NAME =
  "flex w-full min-w-0 items-center gap-[11px] rounded-xl px-2.5 py-1.5 min-h-9 text-left text-[13.5px] tracking-[-0.005em] outline-none transition-colors duration-100 hover:bg-black/[0.04] focus-visible:bg-black/[0.04] disabled:opacity-50 dark:hover:bg-white/[0.07] dark:focus-visible:bg-white/[0.07]"

/** The chosen row's resting highlight. */
export const COMPOSER_MENU_ROW_SELECTED_CLASS_NAME = "bg-black/[0.05] dark:bg-white/[0.08]"

/** A section under a menu's list, set off by a hairline: the permissions. */
export const COMPOSER_MENU_SECTION_CLASS_NAME =
  "shrink-0 border-t-[0.5px] border-black/[0.08] px-4 pt-3 pb-3.5 dark:border-white/[0.08]"

export function ComposerMenuHeader({ children }: { readonly children: ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-1 text-[11.5px] font-medium text-muted-foreground">
      {children}
    </div>
  )
}

/** A row's title, the choice in medium weight, over a line that says what it does. */
export function ComposerMenuRowText({
  title,
  description,
  descriptionId,
}: {
  readonly title: string
  readonly description: string
  readonly descriptionId: string
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-px">
      <span className="break-words font-medium text-foreground">{title}</span>
      <span id={descriptionId} className="text-xs leading-4 text-muted-foreground">
        {description}
      </span>
    </span>
  )
}

/** A hairline between a menu's groups; `strong` sets off a choice from the list after it. */
export function ComposerMenuDivider({ strong = false }: { readonly strong?: boolean }) {
  return (
    <div
      className={cn(
        "mx-2.5 h-[0.5px]",
        strong
          ? "my-1.5 bg-black/[0.09] dark:bg-white/[0.12]"
          : "my-[3px] bg-black/[0.05] dark:bg-white/[0.08]"
      )}
    />
  )
}

/**
 * A composer menu on frosted glass beside its trigger, or a bottom sheet on a phone. `trigger` is
 * the button that opens it.
 */
export function ComposerMenu({
  open,
  onOpenChange,
  trigger,
  title,
  align,
  className,
  onCloseAutoFocus,
  children,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly trigger: ReactNode
  /** Names the menu to assistive technology. */
  readonly title: string
  readonly align: "start" | "end"
  readonly className?: string
  /** Where the focus goes once the menu closes; the trigger unless prevented. */
  readonly onCloseAutoFocus?: (event: Event) => void
  readonly children: ReactNode
}) {
  const mobile = useIsMobile()

  if (mobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[85dvh]" onCloseAutoFocus={onCloseAutoFocus}>
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
        onCloseAutoFocus={onCloseAutoFocus}
        // Capped by the viewport, not Radix's available-height variable: a size that depends on a
        // value Radix rewrites loops its resize observer.
        className={cn(
          "sixb-composer-glass flex max-h-[min(34rem,calc(100dvh-8rem))] w-[20rem] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-[20px] border-0 p-1.5",
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
