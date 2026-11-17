import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Spinner,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronDown, Cloud, Folder, FolderPlus, Laptop, X } from "lucide-react"
import { Fragment, useId } from "react"
import type { PlaceComputer } from "../hooks/use-new-thread-place"
import type { ThreadPlace, ThreadPlaceBusy } from "../hooks/use-thread-place"
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

/**
 * A folder by its name, as a place reads everywhere in running text: its path is only the menu's
 * second line and a tooltip.
 */
export function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

/**
 * A computer and the folder there, as the header writes them: the computer's name capped so the
 * folder always shows, and the folder alone on a phone, where it's what tells conversations apart.
 */
function ComputerFolderName({ computer }: { readonly computer: ThreadComputer }) {
  return (
    <>
      <span className="hidden max-w-[11rem] truncate font-medium text-foreground sm:inline">
        {computer.name}
      </span>
      <span aria-hidden className="hidden sm:inline">
        ·
      </span>
      <span className="min-w-0 truncate font-medium text-foreground sm:font-normal sm:text-muted-foreground">
        {folderName(computer.folder)}
      </span>
    </>
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
  const described = currentComputer
    ? messages.placeOn(folderName(currentComputer.folder), currentComputer.name)
    : messages.cloudPlace

  const sections = placeSections(place)
  // Nowhere else to go meanwhile: the place it runs in stays a way to close the menu.
  const locked = place.pending || place.busy !== null
  // A row held back by a turn says why to assistive technology, not just that it's dimmed.
  const busyReasonId = useId()
  const heldBy = place.busy !== null ? busyReasonId : undefined
  const status = currentComputer
    ? currentComputer.online
      ? messages.online
      : messages.offline
    : null

  const trigger =
    place.onComputer && currentComputer ? (
      <button
        type="button"
        aria-label={messages.placeChip(described, status)}
        aria-haspopup="dialog"
        aria-expanded={place.open}
        title={`${currentComputer.name} · ${shownFolder(currentComputer.folder)}`}
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
        <ComputerFolderName computer={currentComputer} />
        <ChevronDown
          className="size-3 shrink-0 opacity-65 transition-transform duration-150 group-aria-expanded/place:rotate-180"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      </button>
    ) : (
      <button
        type="button"
        aria-label={
          // On a computer from before folders were kept: no folder yet, until one is chosen.
          place.onComputer ? messages.noFolderChip : messages.placeChip(described, null)
        }
        aria-haspopup="dialog"
        aria-expanded={place.open}
        title={place.onComputer ? messages.chooseFolderShort : messages.cloud}
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
    <>
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
            disabled={place.onComputer && locked && place.movingTo !== "cloud"}
            aria-current={place.onComputer ? undefined : "true"}
            aria-describedby={place.onComputer ? heldBy : undefined}
            className={cn(
              COMPOSER_MENU_ROW_CLASS_NAME,
              !place.onComputer && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
            )}
            onClick={place.moveToCloud}
          >
            {place.movingTo === "cloud" ? (
              <Spinner className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <Cloud
                className="size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.9}
                aria-hidden="true"
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className="truncate font-medium text-foreground">{messages.cloud}</span>
              <span className="truncate text-xs leading-4 text-muted-foreground">
                {messages.cloudDescription}
              </span>
            </span>
            {place.onComputer ? null : <CurrentCheck />}
          </button>

          <ComposerMenuDivider strong />

          {sections.map(({ computer, online, folders }) => (
            <Fragment key={computer.id ?? "here"}>
              <ComposerMenuHeader>
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      online ? "bg-emerald-500" : "border border-muted-foreground"
                    )}
                  />
                  <span className="truncate">{computer.name ?? messages.thisComputer}</span>
                  {online ? null : (
                    <span className="shrink-0 font-normal">· {messages.offlineLabel}</span>
                  )}
                </span>
              </ComposerMenuHeader>
              {folders.map((known) => {
                const selected =
                  place.onComputer &&
                  currentComputer?.id === computer.id &&
                  currentComputer.folder === known
                const waiting = selected && !currentComputer.online
                const { movingTo } = place
                const moving =
                  movingTo !== null &&
                  movingTo !== "cloud" &&
                  movingTo.computerId === computer.id &&
                  movingTo.folder === known
                return (
                  <Fragment key={known}>
                    <div className="group/row relative">
                      <button
                        type="button"
                        disabled={!selected && !moving && locked}
                        aria-current={selected ? "true" : undefined}
                        aria-describedby={selected ? undefined : heldBy}
                        className={cn(
                          COMPOSER_MENU_ROW_CLASS_NAME,
                          place.forgetFolder && !selected && "pr-9",
                          selected && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
                        )}
                        title={shownFolder(known)}
                        onClick={() => place.moveToFolder(computer, known)}
                      >
                        {moving ? (
                          <Spinner className="size-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <Folder
                            className="size-4 shrink-0 text-muted-foreground"
                            strokeWidth={1.9}
                            aria-hidden="true"
                          />
                        )}
                        <span className="flex min-w-0 flex-1 flex-col gap-px">
                          <span className="truncate font-medium text-foreground">
                            {folderName(known)}
                          </span>
                          <span className="truncate text-xs leading-4 text-muted-foreground">
                            {shownFolder(known)}
                          </span>
                        </span>
                        {selected ? <CurrentCheck /> : null}
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
                    {waiting ? (
                      <p className="pt-0.5 pr-2.5 pb-1.5 pl-[37px] text-xs leading-4 text-muted-foreground">
                        {messages.offlineMenuHint}
                      </p>
                    ) : null}
                  </Fragment>
                )
              })}
            </Fragment>
          ))}

          {place.pickFolder ? (
            <button
              type="button"
              disabled={locked}
              aria-describedby={heldBy}
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
          ) : sections.length === 0 ? (
            // No computer is connected, and the conversation runs on none it can name: only the cloud.
            <p className="px-2.5 py-2 text-xs leading-4 text-muted-foreground">
              {messages.noComputers}
            </p>
          ) : null}
        </ComposerMenuScroll>

        {place.error || place.busy ? (
          <div className={COMPOSER_MENU_SECTION_CLASS_NAME}>
            {place.error ? (
              <p role="alert" className="text-xs leading-4 text-destructive">
                {place.error === "busy" ? messages.moveBusy : messages.moveSwitchFailed}
              </p>
            ) : (
              <p id={busyReasonId} className="text-xs leading-4 text-muted-foreground">
                {place.busy === "approval" ? messages.moveWhileApproval : messages.moveWhileRunning}
              </p>
            )}
          </div>
        ) : null}
      </ComposerMenu>
      <ConfirmCloudDialog place={place} />
    </>
  )
}

/** The place the conversation runs in, marked apart from a row that's only hovered or focused. */
function CurrentCheck() {
  return <Check className="size-4 shrink-0 text-foreground" strokeWidth={2.2} aria-hidden="true" />
}

/**
 * Asked before a waiting message goes to the cloud, from the menu or the notice: it would run there
 * apart from its folder's files. Moving with nothing waiting needs no question, the marker says it.
 */
function ConfirmCloudDialog({ place }: { readonly place: ThreadPlace }) {
  const messages = useAgentMessages().computer
  const folder = place.currentComputer ? folderName(place.currentComputer.folder) : null
  return (
    <AlertDialog open={place.confirmCloud.open} onOpenChange={place.confirmCloud.setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{messages.confirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>{messages.confirmDescription(folder)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{messages.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={place.confirmCloud.accept}>
            {messages.confirmAction}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A computer in the menu, whether it's connected, and its folders there. */
interface PlaceSection {
  readonly computer: PlaceComputer
  readonly online: boolean
  readonly folders: readonly string[]
}

/**
 * The connected computers and their folders, and the conversation's own place first among them even
 * while it isn't connected: the menu always shows where it runs.
 */
function placeSections(place: ThreadPlace): readonly PlaceSection[] {
  const sections = place.computers.map((computer) => ({
    computer,
    online: true,
    folders: computer.folders,
  }))

  const current = place.onComputer ? place.currentComputer : null
  if (!current) return sections

  const listed = sections.find((section) => section.computer.id === current.id)
  if (!listed) {
    const computer = { id: current.id, name: current.name, folders: [current.folder] }
    return [{ computer, online: current.online, folders: computer.folders }, ...sections]
  }
  if (listed.folders.includes(current.folder)) return sections

  // Its computer is connected in other folders, not in this one.
  return sections.map((section) =>
    section === listed ? { ...section, folders: [current.folder, ...section.folders] } : section
  )
}

export interface ComputerOfflineNoticeProps {
  /** Null for a conversation from before folders were kept, until it moves. */
  readonly computer: ThreadComputer | null
  /** A message waits for the folder: continuing in the cloud runs it there. */
  readonly waiting: boolean
  /** A move to the cloud is on its way: the button says so. */
  readonly pending: boolean
  /** Any move is on its way, from here or from the header: the buttons wait for it. */
  readonly moving: boolean
  /** What keeps it where it runs: the button waits, and says why. */
  readonly busy: ThreadPlaceBusy
  /** Why the last move failed: a turn it must wait for, or anything else. */
  readonly error: "busy" | "failed" | null
  /** Asks first when a message waits, as the header's menu does. */
  readonly onContinueInCloud: () => void
  /** In a desktop app on this conversation's own computer: ask the person to run it here. */
  readonly onRunHere?: () => void
}

/**
 * Above the composer while the conversation's folder isn't open on its computer: it says whether a
 * message waits for it, how to get it back, and offers the cloud meanwhile.
 */
export function ComputerOfflineNotice({
  computer,
  waiting,
  pending,
  moving,
  busy,
  error,
  onContinueInCloud,
  onRunHere,
}: ComputerOfflineNoticeProps) {
  const messages = useAgentMessages().computer
  // Its buttons follow the words, or go under them where there's no room: never under the icon.
  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-baseline gap-3 px-4 pt-1 text-xs text-muted-foreground"
      role="status"
    >
      <Laptop aria-hidden className="size-3.5 shrink-0 translate-y-0.5" />
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-2">
        <span className="min-w-[min(100%,15rem)] flex-1">
          {!computer
            ? messages.noFolder
            : onRunHere
              ? messages.offlineHere(folderName(computer.folder))
              : waiting
                ? messages.messageWaiting(folderName(computer.folder), computer.name)
                : messages.folderUnavailable(folderName(computer.folder), computer.name)}
        </span>
        <div className="flex flex-wrap items-baseline gap-2">
          {onRunHere ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={moving}
              className="h-7 rounded-full"
              onClick={onRunHere}
            >
              {messages.runHere}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={moving || busy !== null}
            className="h-7 rounded-full"
            onClick={onContinueInCloud}
          >
            {pending ? messages.moving : messages.continueInCloud}
          </Button>
        </div>
        {error ? (
          <span role="alert" className="w-full text-destructive">
            {error === "busy" ? messages.moveBusy : messages.moveFailed}
          </span>
        ) : busy ? (
          <span className="w-full">
            {busy === "approval" ? messages.moveWhileApproval : messages.moveWhileRunning}
          </span>
        ) : null}
      </div>
    </div>
  )
}
