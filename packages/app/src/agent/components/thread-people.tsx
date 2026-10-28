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
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Eye, GitBranchPlus, LogOut, UserPlus, X } from "lucide-react"
import { type ReactNode, type RefObject, useId, useRef, useState } from "react"
import { PersonAvatar } from "../../artifacts/person-avatar"
import type { CurrentUser } from "../../session"
import type { ThreadSharing } from "../hooks/use-thread-sharing"
import { useAgentMessages } from "../i18n"
import {
  personName,
  samePrincipal,
  type ThreadAccess,
  type ThreadPerson,
  threadOwner,
  threadParticipants,
  userPrincipal,
} from "../sharing"
import type { AgentThread } from "../types"
import { type ParticipantChoice, ParticipantInput, participantChoiceKey } from "./participant-input"

export interface ThreadPeopleProps {
  readonly thread: AgentThread
  readonly access: ThreadAccess
  readonly user: CurrentUser | null
  readonly sharing: ThreadSharing
}

/** Avatars the header stacks before it counts the rest. */
const STACKED = 3

/**
 * Who takes part in a thread, from its header: an avatar stack once it is shared, a share button
 * before. It opens a dialog, or a bottom drawer on a phone. The owner adds and removes people; a
 * participant sees who is there, leaves, or continues in a thread of their own.
 */
export function ThreadPeople({ thread, access, user, sharing }: ThreadPeopleProps) {
  const messages = useAgentMessages().sharing
  const mobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)

  const owner = threadOwner(thread)
  const participants = threadParticipants(thread)
  const people = [owner, ...participants]
  const shared = participants.length > 0
  const title = access === "owner" ? messages.shareTitle : messages.peopleTitle

  const changeOpen = (next: boolean) => {
    setOpen(next)
    if (!next) sharing.resetShare()
  }

  // Nobody is suggested twice: not the reader, nor whoever is in the thread.
  const exclude = new Set(
    [...people.map((person) => person.principal), ...(user ? [userPrincipal(user)] : [])]
      .filter((principal) => principal?.type === "user")
      .map((principal) => principal?.id ?? "")
  )

  const body = (
    <>
      {access === "owner" ? (
        <AddPeople sharing={sharing} emailRef={emailRef} exclude={exclude} />
      ) : null}

      <PeopleList
        labelled={access === "owner"}
        owner={owner}
        participants={participants}
        user={user}
        canRemove={access === "owner"}
        sharing={sharing}
        emailRef={emailRef}
      />
    </>
  )

  const footer =
    access === "participant" && user ? (
      <ParticipantActions owner={personName(owner)} userId={user.id} sharing={sharing} />
    ) : null

  return (
    <>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            {shared ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={messages.people(people.length)}
                onClick={() => changeOpen(true)}
                className="h-9 px-1.5"
              >
                <PeopleStack people={people} />
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label={messages.share}
                onClick={() => changeOpen(true)}
                className="[&_svg]:size-5"
              >
                <UserPlus />
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {shared ? messages.names(people.map(personName)) : messages.shareShort}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {mobile ? (
        <Drawer open={open} onOpenChange={changeOpen}>
          <DrawerContent className="max-h-[85dvh]">
            <div className="px-4 pt-3 pb-1">
              <DrawerTitle className="text-lg">{title}</DrawerTitle>
              <DrawerDescription className="mt-1">{messages.description}</DrawerDescription>
            </div>
            <div
              className={cn(
                "min-h-0 overflow-y-auto px-4",
                footer ? "pb-4" : "pb-[max(1rem,env(safe-area-inset-bottom))]"
              )}
            >
              {body}
            </div>
            <PanelFooter>{footer}</PanelFooter>
          </DrawerContent>
        </Drawer>
      ) : (
        <Dialog open={open} onOpenChange={changeOpen}>
          <DialogContent
            showCloseButton={false}
            // Held near the top: the dialog grows downward as suggestions open, instead of jumping.
            className="top-[max(4rem,12dvh)] flex max-h-[calc(100dvh-max(4rem,12dvh)-2rem)] w-[min(calc(100vw-2rem),30rem)] max-w-[30rem] translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl p-0"
          >
            <div className="flex h-16 shrink-0 items-center gap-3 px-5">
              <DialogTitle className="text-lg">{title}</DialogTitle>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={messages.close}
                  className="ml-auto text-muted-foreground hover:text-foreground"
                >
                  <X />
                </Button>
              </DialogClose>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
              <DialogDescription className="text-sm text-muted-foreground">
                {messages.description}
              </DialogDescription>
              {body}
            </div>
            <PanelFooter>{footer}</PanelFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** Overlapping avatars of the first people, then how many more. */
function PeopleStack({ people }: { readonly people: readonly ThreadPerson[] }) {
  const shown = people.slice(0, STACKED)
  const more = people.length - shown.length

  return (
    <span aria-hidden className="flex items-center -space-x-1">
      {shown.map((person) => (
        <PersonAvatar
          key={person.principal.id}
          name={personName(person)}
          className="size-7 ring-2 ring-background"
        />
      ))}
      {more > 0 ? (
        <span className="grid size-7 place-items-center rounded-full bg-muted-foreground/15 text-[9px] font-medium text-foreground/75 tabular-nums ring-2 ring-background">
          +{more}
        </span>
      ) : null}
    </span>
  )
}

function PanelFooter({ children }: { readonly children: ReactNode }) {
  if (!children) return null

  return (
    <div className="shrink-0 border-border/60 border-t px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5 sm:pb-3">
      {children}
    </div>
  )
}

function AddPeople({
  sharing,
  emailRef,
  exclude,
}: {
  readonly sharing: ThreadSharing
  readonly emailRef: RefObject<HTMLInputElement | null>
  readonly exclude: ReadonlySet<string>
}) {
  const messages = useAgentMessages().sharing
  const [staged, setStaged] = useState<readonly ParticipantChoice[]>([])
  const ready = staged.length > 0

  const stage = (choice: ParticipantChoice) => {
    sharing.resetShare()
    setStaged((current) =>
      current.some((entry) => participantChoiceKey(entry) === participantChoiceKey(choice))
        ? current
        : [...current, choice]
    )
  }

  const unstage = (choice: ParticipantChoice) =>
    setStaged((current) =>
      current.filter((entry) => participantChoiceKey(entry) !== participantChoiceKey(choice))
    )

  // Focus goes back to the email field, the one control that stays.
  const confirm = async () => {
    if (!(await sharing.share(staged))) return

    setStaged([])
    emailRef.current?.focus()
  }

  return (
    <section className="mt-4 flex flex-col">
      <ParticipantInput
        staged={staged}
        exclude={exclude}
        onAdd={stage}
        onRemove={unstage}
        disabled={sharing.sharing}
        inputRef={emailRef}
      />

      {/* The warning and the button open smoothly once someone is picked, and only then. */}
      <div
        inert={!ready}
        aria-hidden={!ready}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          ready ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
          <p
            role="note"
            className="mt-3 flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground"
          >
            <Eye
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
            />
            <span>{messages.warning}</span>
          </p>

          {sharing.shareFailure ? (
            <p role="alert" className="text-xs text-destructive">
              {sharing.shareFailure === "invalid" ? messages.shareRefused : messages.shareFailed}
            </p>
          ) : null}

          <Button
            type="button"
            className="self-end rounded-full"
            disabled={sharing.sharing || !ready}
            onClick={() => void confirm()}
          >
            {sharing.sharing ? <Spinner className="size-4" /> : null}
            {sharing.sharing ? messages.sharing : messages.confirm(Math.max(staged.length, 1))}
          </Button>
        </div>
      </div>
    </section>
  )
}

function PeopleList({
  labelled,
  owner,
  participants,
  user,
  canRemove,
  sharing,
  emailRef,
}: {
  /** Under the field that adds people, a heading says these are already in. */
  readonly labelled: boolean
  readonly owner: ThreadPerson
  readonly participants: readonly ThreadPerson[]
  readonly user: CurrentUser | null
  readonly canRemove: boolean
  readonly sharing: ThreadSharing
  readonly emailRef: RefObject<HTMLInputElement | null>
}) {
  const messages = useAgentMessages().sharing
  const me = userPrincipal(user)

  // The removed row and its button are gone: focus goes back to the email field.
  const remove = async (userId: string) => {
    if (await sharing.remove(userId)) emailRef.current?.focus()
  }

  return (
    <section className="mt-5" aria-label={messages.inThread}>
      {labelled ? (
        <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{messages.inThread}</h3>
      ) : null}
      <ul className="space-y-0.5">
        <PersonRow
          person={owner}
          detail={
            samePrincipal(owner.principal, me)
              ? `${messages.owner} · ${messages.you}`
              : messages.owner
          }
        />

        {participants.map((participant) => (
          <PersonRow
            key={participant.principal.id}
            person={participant}
            detail={samePrincipal(participant.principal, me) ? messages.you : undefined}
            onRemove={canRemove ? () => void remove(participant.principal.id) : undefined}
            removing={sharing.removing.has(participant.principal.id)}
          />
        ))}
      </ul>

      {sharing.removeFailed ? (
        <p role="alert" className="mt-2 px-2 text-xs text-destructive">
          {messages.removeFailed}
        </p>
      ) : null}
    </section>
  )
}

function PersonRow({
  person,
  detail,
  onRemove,
  removing = false,
}: {
  readonly person: ThreadPerson
  readonly detail?: string
  readonly onRemove?: () => void
  readonly removing?: boolean
}) {
  const messages = useAgentMessages().sharing
  const name = personName(person)

  return (
    <li className="group flex min-h-12 items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-muted/50">
      <PersonAvatar name={name} size="md" />

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{name}</span>
        {detail ? (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>

      {onRemove ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={messages.remove(name)}
          disabled={removing}
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
        >
          {removing ? <Spinner className="size-4" /> : <X />}
        </Button>
      ) : null}
    </li>
  )
}

/** What a participant does from the dialog: continue alone, or leave. */
function ParticipantActions({
  owner,
  userId,
  sharing,
}: {
  readonly owner: string
  readonly userId: string
  readonly sharing: ThreadSharing
}) {
  const messages = useAgentMessages().sharing

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <ContinueButton label={messages.continueMine} sharing={sharing} className="sm:mr-auto" />
      <LeaveButton owner={owner} userId={userId} sharing={sharing} />
    </div>
  )
}

/** Leaving asks first, and the question stays open until the server lets the reader go. */
function LeaveButton({
  owner,
  userId,
  sharing,
}: {
  readonly owner: string
  readonly userId: string
  readonly sharing: ThreadSharing
}) {
  const messages = useAgentMessages().sharing
  const [open, setOpen] = useState(false)

  const leave = async () => {
    if (await sharing.leave(userId)) setOpen(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !sharing.leaving && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 rounded-full text-muted-foreground"
        >
          <LogOut />
          {messages.leave}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{messages.leaveTitle}</AlertDialogTitle>
          <AlertDialogDescription>{messages.leaveDescription(owner)}</AlertDialogDescription>
        </AlertDialogHeader>

        {sharing.leaveFailed ? (
          <p role="alert" className="text-xs text-destructive">
            {messages.leaveFailed}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={sharing.leaving}>{messages.cancel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={sharing.leaving}
            onClick={(event) => {
              event.preventDefault()
              void leave()
            }}
          >
            {sharing.leaving ? <Spinner className="size-4" /> : null}
            {messages.leave}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Copy the conversation into one the reader owns alone, then open it. */
export function ContinueButton({
  label,
  sharing,
  variant = "secondary",
  className,
}: {
  readonly label: string
  readonly sharing: ThreadSharing
  readonly variant?: "secondary" | "link"
  readonly className?: string
}) {
  const messages = useAgentMessages().sharing
  const hintId = useId()

  return (
    <span className={cn("flex min-w-0 flex-col items-start gap-1", className)}>
      <Button
        type="button"
        variant={variant}
        size="sm"
        aria-describedby={hintId}
        disabled={sharing.forking}
        onClick={() => void sharing.fork()}
        className={cn(
          "gap-1.5",
          variant === "link"
            ? "h-auto p-0 text-xs whitespace-nowrap has-[>svg]:px-0"
            : "rounded-full px-3.5"
        )}
      >
        {sharing.forking ? <Spinner className="size-3.5" /> : <GitBranchPlus />}
        {sharing.forking ? messages.continuing : label}
      </Button>

      {/* Said under the button in the dialog; in the one-line notice, only to assistive tech. */}
      <span
        id={hintId}
        className={variant === "link" ? "sr-only" : "text-[11px] text-muted-foreground"}
      >
        {messages.continueHint}
      </span>

      {sharing.forkFailed ? (
        <span role="alert" className="text-xs text-destructive">
          {messages.forkFailed}
        </span>
      ) : null}
    </span>
  )
}
