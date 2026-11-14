import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Spinner,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, Cloud, Folder, FolderPlus, Laptop, X } from "lucide-react"
import { Fragment } from "react"
import type { ThreadPlace } from "../hooks/use-thread-place"
import { useAgentMessages } from "../i18n"
import type { AgentThread } from "../types"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_MENU_ROW_SELECTED_CLASS_NAME,
  COMPOSER_MENU_SECTION_CLASS_NAME,
  ComposerMenu,
  ComposerMenuDivider,
  ComposerMenuHeader,
  ComposerMenuScroll,
} from "./composer-menu"

/** Where a conversation runs on its owner's computer, as its owner reads it. */
export type ThreadComputer = NonNullable<AgentThread["computer"]>

/** A folder as its owner reads it: their home folder as `~`. */
export function shownFolder(folder: string): string {
  return folder.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~")
}

/** A folder short enough for the badge beside its computer's name: its last name is what tells. */
function shortFolder(folder: string): string {
  const parts = shownFolder(folder).split("/")
  return parts.length > 2 ? `${parts[0]}/…/${parts.at(-1)}` : parts.join("/")
}

/** A folder's basename for a menu row's title. */
function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

/** The computer a conversation runs on, its folder there, and whether `sixb` is open in it. */
export function ComputerBadge({ computer }: { readonly computer: ThreadComputer }) {
  const messages = useAgentMessages().computer
  return (
    <Badge
      variant="outline"
      className="h-7 max-w-72 gap-1.5 px-2.5 font-normal text-muted-foreground"
      title={`${computer.name} · ${computer.folder}`}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          computer.online ? "bg-emerald-500" : "border border-muted-foreground"
        )}
      />
      <span className="max-w-full shrink-0 truncate text-foreground">{computer.name}</span>
      <span className="hidden min-w-0 truncate sm:inline">· {shortFolder(computer.folder)}</span>
      <span className="sr-only">{computer.online ? messages.online : messages.offline}</span>
    </Badge>
  )
}

/**
 * The conversation header's living Handoff control: shows whether the conversation runs in the
 * cloud or in a folder on one of its owner's computers, and lets its owner switch between them
 * seamlessly at any time.
 */
export function ThreadPlaceControl({ place }: { readonly place: ThreadPlace }) {
  const messages = useAgentMessages().computer
  const { currentComputer } = place
  const described = place.onComputer
    ? currentComputer
      ? `${currentComputer.name} · ${shownFolder(currentComputer.folder)}`
      : messages.chooseFolderShort
    : messages.cloud

  const currentListed =
    currentComputer !== null &&
    place.computers.some(
      (known) => known.id === currentComputer.id && known.folders.includes(currentComputer.folder)
    )

  const trigger =
    place.onComputer && currentComputer ? (
      <button
        type="button"
        aria-label={messages.placeChip(described)}
        aria-haspopup="dialog"
        aria-expanded={place.open}
        title={`${currentComputer.name} · ${currentComputer.folder}`}
        className="group/place inline-flex h-7 max-w-72 items-center gap-1.5 rounded-full border border-border/80 bg-background/60 px-2.5 text-xs font-normal text-muted-foreground outline-none transition-colors hover:border-border hover:bg-black/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:border-border aria-expanded:bg-black/[0.05] aria-expanded:text-foreground dark:hover:bg-white/[0.07] dark:aria-expanded:bg-white/[0.08]"
      >
        {place.pending ? (
          <Spinner className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "size-2 shrink-0 rounded-full transition-colors",
              currentComputer.online
                ? "bg-emerald-500 shadow-[0_0_0_2px_rgb(16_185_129/0.16)]"
                : "border border-muted-foreground"
            )}
          />
        )}
        <span className="max-w-full shrink-0 truncate font-medium text-foreground">
          {currentComputer.name}
        </span>
        <span className="hidden min-w-0 truncate sm:inline">
          · {shortFolder(currentComputer.folder)}
        </span>
        <span className="sr-only">
          {currentComputer.online ? messages.online : messages.offline}
        </span>
        <ChevronDown
          className="size-3 shrink-0 opacity-65 transition-transform duration-150 group-aria-expanded/place:rotate-180"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </button>
    ) : (
      <button
        type="button"
        aria-label={messages.placeChip(described)}
        aria-haspopup="dialog"
        aria-expanded={place.open}
        title={described}
        className="group/place inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-black/[0.04] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-expanded:bg-black/[0.05] aria-expanded:text-foreground dark:hover:bg-white/[0.07] dark:aria-expanded:bg-white/[0.08]"
      >
        {place.pending ? (
          <Spinner className="size-3.5 shrink-0" />
        ) : place.onComputer ? (
          <Laptop className="size-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
        ) : (
          <Cloud className="size-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
        )}
        <span className="truncate">
          {place.onComputer ? messages.chooseFolderShort : messages.cloud}
        </span>
        <ChevronDown
          className="size-3 shrink-0 opacity-65 transition-transform duration-150 group-aria-expanded/place:rotate-180"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </button>
    )

  return (
    <ComposerMenu
      open={place.open}
      onOpenChange={place.setOpen}
      title={messages.placeTitle}
      align="end"
      side="bottom"
      className="w-[22rem]"
      trigger={trigger}
    >
      <ComposerMenuScroll>
        <ComposerMenuHeader>{messages.placeTitle}</ComposerMenuHeader>
        <button
          type="button"
          disabled={place.onComputer && (place.pending || place.busy)}
          className={cn(
            COMPOSER_MENU_ROW_CLASS_NAME,
            !place.onComputer && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
          )}
          onClick={place.moveToCloud}
        >
          <Cloud
            className="size-4 shrink-0 text-muted-foreground"
            strokeWidth={1.9}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="truncate font-medium text-foreground">{messages.cloud}</span>
            <span className="truncate text-xs leading-4 text-muted-foreground">
              {messages.cloudDescription}
            </span>
          </span>
        </button>

        <ComposerMenuDivider strong />

        {place.onComputer && currentComputer && !currentListed ? (
          <Fragment>
            <ComposerMenuHeader>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    currentComputer.online ? "bg-emerald-500" : "border border-muted-foreground"
                  )}
                />
                <span className="truncate">{currentComputer.name}</span>
              </span>
            </ComposerMenuHeader>
            <button
              type="button"
              className={cn(COMPOSER_MENU_ROW_CLASS_NAME, COMPOSER_MENU_ROW_SELECTED_CLASS_NAME)}
              title={shownFolder(currentComputer.folder)}
              onClick={() => place.setOpen(false)}
            >
              <Folder
                className="size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.9}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate font-medium text-foreground">
                  {folderName(currentComputer.folder)}
                </span>
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {shownFolder(currentComputer.folder)}
                </span>
              </span>
            </button>
          </Fragment>
        ) : null}

        {place.computers.map((computer) => (
          <Fragment key={computer.id ?? "here"}>
            <ComposerMenuHeader>
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span className="truncate">{computer.name ?? messages.thisComputer}</span>
              </span>
            </ComposerMenuHeader>
            {computer.folders.map((known) => {
              const selected =
                place.onComputer &&
                currentComputer?.id === computer.id &&
                currentComputer.folder === known
              return (
                <div key={known} className="group/row relative">
                  <button
                    type="button"
                    disabled={!selected && (place.pending || place.busy)}
                    className={cn(
                      COMPOSER_MENU_ROW_CLASS_NAME,
                      place.forgetFolder && !selected && "pr-9",
                      selected && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
                    )}
                    title={shownFolder(known)}
                    onClick={() => place.moveToFolder(computer, known)}
                  >
                    <Folder
                      className="size-4 shrink-0 text-muted-foreground"
                      strokeWidth={1.9}
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                      <span className="truncate font-medium text-foreground">
                        {folderName(known)}
                      </span>
                      <span className="truncate text-xs leading-4 text-muted-foreground">
                        {shownFolder(known)}
                      </span>
                    </span>
                  </button>
                  {place.forgetFolder && !selected ? (
                    <button
                      type="button"
                      aria-label={messages.forgetFolder(shownFolder(known))}
                      title={messages.forgetFolder(shownFolder(known))}
                      className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-black/[0.05] focus-visible:opacity-100 group-hover/row:opacity-100 dark:hover:bg-white/[0.08]"
                      onClick={() => place.forgetFolder?.(known)}
                    >
                      <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              )
            })}
          </Fragment>
        ))}

        {place.pickFolder ? (
          <button
            type="button"
            disabled={place.pending || place.busy}
            className={COMPOSER_MENU_ROW_CLASS_NAME}
            onClick={() => void place.pickFolder?.()}
          >
            <FolderPlus
              className="size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.9}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 font-medium text-foreground">
              {messages.chooseFolder}
            </span>
          </button>
        ) : place.loading && place.computers.length === 0 ? (
          <div className="flex items-center gap-2.5 px-2.5 py-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5 shrink-0" />
            <span>{messages.checkingComputers}</span>
          </div>
        ) : place.computers.length === 0 ? (
          <div className="mx-1 my-0.5 flex items-start gap-2.5 rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]">
            <Laptop
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              strokeWidth={1.9}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-[13px] font-medium leading-4 text-foreground">
                {messages.connectComputerTitle}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {messages.connectComputerHint}
              </p>
            </div>
          </div>
        ) : null}
      </ComposerMenuScroll>

      {place.error || place.busy ? (
        <div className={COMPOSER_MENU_SECTION_CLASS_NAME}>
          {place.error ? (
            <p role="alert" className="text-xs leading-4 text-destructive">
              {place.error === "busy" ? messages.moveBusy : messages.moveSwitchFailed}
            </p>
          ) : (
            <p className="text-xs leading-4 text-muted-foreground">{messages.moveWhileBusy}</p>
          )}
        </div>
      ) : null}
    </ComposerMenu>
  )
}

export interface ComputerOfflineNoticeProps {
  /** Null for a conversation from before folders were kept, until it moves. */
  readonly computer: ThreadComputer | null
  readonly pending: boolean
  /** Why the last move failed: a turn it must wait for, or anything else. */
  readonly error: "busy" | "failed" | null
  readonly onContinueInCloud: () => void
  /** In a desktop app on this conversation's own computer: ask the person to run it here. */
  readonly onRunHere?: () => void
}

/**
 * Above the composer while the conversation's computer is offline: a message waits for it, or the
 * conversation continues in the cloud until moved back.
 */
export function ComputerOfflineNotice({
  computer,
  pending,
  error,
  onContinueInCloud,
  onRunHere,
}: ComputerOfflineNoticeProps) {
  const messages = useAgentMessages().computer
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1 text-xs text-muted-foreground"
      role="status"
    >
      <Laptop aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {computer
          ? onRunHere
            ? messages.offlineHere(shownFolder(computer.folder))
            : messages.offlineNotice(computer.name, shownFolder(computer.folder))
          : messages.noFolder}
      </span>
      {onRunHere ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          className="h-7 rounded-full"
          onClick={onRunHere}
        >
          {messages.runHere}
        </Button>
      ) : null}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            className="h-7 rounded-full"
          >
            {pending ? messages.moving : messages.continueInCloud}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{messages.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{messages.confirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={onContinueInCloud}>
              {messages.continueInCloud}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error ? (
        <span role="alert" className="w-full pl-6.5 text-destructive">
          {error === "busy" ? messages.moveBusy : messages.moveFailed}
        </span>
      ) : null}
    </div>
  )
}
