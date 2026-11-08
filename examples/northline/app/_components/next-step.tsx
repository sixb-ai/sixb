import { cn } from "@sixb/ui/lib/utils"
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from "react"
import { Link } from "react-router-dom"

const pillTones = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-offset-2 focus-visible:ring-offset-card",
  secondary:
    "bg-black/[0.05] text-foreground hover:bg-black/[0.08] dark:bg-white/[0.08] dark:hover:bg-white/[0.12]",
} as const

type PillTone = keyof typeof pillTones

/** A rounded action button's classes, for elements that can't be a `PillButton` or `PillLink`. */
export function pillClass(tone: PillTone = "primary", className?: string): string {
  return cn(
    "inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60",
    pillTones[tone],
    className
  )
}

export function PillButton({
  tone = "primary",
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> & { tone?: PillTone }) {
  return <button type="button" className={pillClass(tone, className)} {...props} />
}

export function PillLink({
  to,
  tone = "primary",
  className,
  children,
}: PropsWithChildren<{ to: string; tone?: PillTone; className?: string }>) {
  return (
    <Link to={to} className={pillClass(tone, className)}>
      {children}
    </Link>
  )
}

/** The accent ring that marks the one card on a page waiting for a decision. */
export const decisionRingClass =
  "rounded-[20px] bg-card shadow-[0_0_0_1.5px_var(--primary),0_10px_28px_color-mix(in_srgb,var(--primary)_12%,transparent)]"

/** The decision a record is waiting on: what to do, why, and the buttons that do it. */
export function NextStepCard({
  label = "Next step",
  title,
  detail,
  children,
}: PropsWithChildren<{ label?: string; title: ReactNode; detail?: ReactNode }>) {
  return (
    <section className={cn("flex flex-col gap-4 p-6 max-sm:p-5", decisionRingClass)}>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-semibold text-primary">{label}</span>
        <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-balance">
          {title}
        </h2>
        {detail ? (
          <p className="max-w-2xl text-[15px] leading-6 text-pretty text-foreground/75">{detail}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** Why an action did not go through, under its buttons. */
export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-[13.5px] text-destructive">
      {children}
    </p>
  )
}
