import { cn } from "@sixb/ui/lib/utils"
import { ChevronDown, Cloud, Folder, FolderPlus, Laptop, X } from "lucide-react"
import { useState } from "react"
import type { NewThreadPlace } from "../hooks/use-new-thread-place"
import { useAgentMessages } from "../i18n"
import {
  COMPOSER_MENU_ROW_CLASS_NAME,
  COMPOSER_MENU_ROW_SELECTED_CLASS_NAME,
  ComposerMenu,
  ComposerMenuDivider,
  ComposerMenuHeader,
  ComposerMenuScroll,
} from "./composer-menu"
import { shownFolder } from "./computer-place"

/** A folder's last name: what tells it apart in a chip. */
function folderName(folder: string): string {
  return folder.split("/").filter(Boolean).at(-1) ?? folder
}

/**
 * Where a new conversation runs, as a quiet line under the input: set once for the conversation, and
 * the thing a person most needs to see before sending, so it isn't among the per-message settings.
 * Its menu holds the folders chosen before, a way to choose another, and the cloud.
 */
export function ComposerPlace({
  place,
  disabled,
}: {
  readonly place: NewThreadPlace
  readonly disabled?: boolean
}) {
  const messages = useAgentMessages().computer
  const [open, setOpen] = useState(false)
  const { cloud, folder, folders } = place
  const name = cloud ? messages.cloud : folder ? folderName(folder) : messages.chooseFolderShort
  const Icon = cloud ? Cloud : Laptop
  const path = !cloud && folder ? shownFolder(folder) : null
  const described = path ?? name

  return (
    <ComposerMenu
      open={open}
      onOpenChange={(next) => {
        if (next) place.refreshFolders()
        setOpen(next)
      }}
      title={messages.placeTitle}
      align="start"
      side="bottom"
      className="w-[22rem]"
      trigger={
        <button
          type="button"
          disabled={disabled}
          aria-label={messages.placeChip(described)}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={described}
          className="group/place -ml-1.5 flex h-7 min-w-0 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-black/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-expanded:bg-black/[0.05] aria-expanded:text-foreground dark:hover:bg-white/[0.08] dark:aria-expanded:bg-white/[0.08]"
        >
          <Icon className="size-3.5 shrink-0" strokeWidth={1.9} aria-hidden="true" />
          <span className="max-w-[12rem] shrink-0 truncate">{name}</span>
          {path ? (
            <span className="min-w-0 truncate font-normal text-muted-foreground/70 max-sm:hidden">
              {path}
            </span>
          ) : null}
          <ChevronDown
            className="size-3 shrink-0 opacity-70 transition-transform group-aria-expanded/place:rotate-180"
            strokeWidth={2.6}
            aria-hidden="true"
          />
        </button>
      }
    >
      <ComposerMenuScroll>
        <ComposerMenuHeader>{place.computerName}</ComposerMenuHeader>
        {folders.map((known) => (
          <div key={known} className="group/row relative">
            <button
              type="button"
              className={cn(
                COMPOSER_MENU_ROW_CLASS_NAME,
                "pr-9",
                !cloud && known === folder && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
              )}
              title={shownFolder(known)}
              onClick={() => {
                place.chooseFolder(known)
                setOpen(false)
              }}
            >
              <Folder className="size-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
              <span className="flex min-w-0 flex-1 flex-col gap-px">
                <span className="truncate font-medium text-foreground">{folderName(known)}</span>
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {shownFolder(known)}
                </span>
              </span>
            </button>
            <button
              type="button"
              aria-label={messages.forgetFolder(shownFolder(known))}
              title={messages.forgetFolder(shownFolder(known))}
              className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-black/[0.05] focus-visible:opacity-100 group-hover/row:opacity-100 dark:hover:bg-white/[0.08]"
              onClick={() => place.forgetFolder(known)}
            >
              <X className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className={COMPOSER_MENU_ROW_CLASS_NAME}
          onClick={() => {
            setOpen(false)
            void place.pickFolder()
          }}
        >
          <FolderPlus className="size-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
          <span className="min-w-0 flex-1 font-medium text-foreground">
            {messages.chooseFolder}
          </span>
        </button>
        <ComposerMenuDivider strong />
        <button
          type="button"
          className={cn(
            COMPOSER_MENU_ROW_CLASS_NAME,
            cloud && COMPOSER_MENU_ROW_SELECTED_CLASS_NAME
          )}
          onClick={() => {
            place.chooseCloud()
            setOpen(false)
          }}
        >
          <Cloud className="size-4 shrink-0" strokeWidth={1.9} aria-hidden="true" />
          <span className="min-w-0 flex-1 font-medium text-foreground">{messages.cloud}</span>
        </button>
      </ComposerMenuScroll>
    </ComposerMenu>
  )
}
