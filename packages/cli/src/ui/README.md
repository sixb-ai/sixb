# CLI output

Two ways to draw, chosen per command.

| | Printed screens | Live screens |
|---|---|---|
| Files | `theme.ts`, `layout.ts`, `screens.ts`, `deploy-screens.ts`, `index.ts` | `live/` |
| What | Strings written once with `renderStatic` | An OpenTUI footer pinned under scrolling output |
| Used by | Help, errors, results, role startup, spinners (`startTask`) | `sixb dev`, a deploy in progress, prompts |
| Loads | Nothing beyond Bun | `@opentui/core`, `@opentui/react`, React, a native library |

Printed screens keep the terminal's own foreground for body text and use color only for status,
so they read on light and dark terminals. `colorLevel()` drops color for pipes, `NO_COLOR`, and
dumb terminals, and steps 24-bit colors down to 256 or 16 where the terminal says it must.
Piped output never wraps, so a log line stays one line.

Every screen follows the same rules:

- It opens with `▰ sixb <command>`, shows its details, and ends with the outcome. A command with
  one thing to say (`build`, `typegen`, `db migrate`) says it on one line instead.
- Bold is for the outcome and the command name. Section titles stay muted.
- Blue means live, or something to open or run: a ready dot, a URL, a command. A fix written in
  prose is led by a faint `→`, never blue.
- URLs are terminal hyperlinks where the terminal takes them (`link` in `theme.ts`).
- Content stops at about 100 columns, however wide the terminal.

Live screens load only behind `canRunLive()` (`live/can-run-live.ts`, which imports nothing), and
only through `await import(...)`. Nothing a role or a printed command imports may reach `live/`:
a renderer holds tens of MB for the life of the process, and `prod-roles.e2e.ts` checks that
`sixb app` outside a terminal loads none of it.

## Split footer

`live/session.ts` starts OpenTUI in `split-footer` mode: the footer owns the bottom rows and
everything else is committed to the scrollback above it, where it stays after the footer goes.

- Write above the footer with `footer.print`. It takes SGR-colored text (`live/ansi.ts` turns it
  into OpenTUI styled text); OpenTUI shows any raw escape it is handed as text.
- While a footer is up, `console.*` is routed through `print`: Bun's console writes past
  `process.stdout.write` and would draw over the footer.
- Print a command's last screen through `print` before `stop()`, not after: what follows a
  stopped footer lands one row low.
- Raw mode turns ctrl+c into a key. Each live screen decides what it means.

## `sixb dev`

The supervisor (`lib/dev-supervisor.ts`) outlives every restart, so it owns the screen. It picks a
`DevReporter`: the footer (`live/dev.tsx`) in a terminal, `[SixbDev]` lines otherwise.

With the footer, the dev process runs with `SIXB_DEV_UI=footer` and its stdout and stderr piped.
It prints nothing of its own; it reports over IPC instead (`lib/dev-messages.ts`): each startup
step, the ready view, or the startup failure. The supervisor forwards its output line by line.
Without the footer the dev process inherits the terminal and prints its own screens, as any
command does.
