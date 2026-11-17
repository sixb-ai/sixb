# @sixb/claude-code

Use Claude through the Claude Code installed and signed in on your computer. The calls are billed
the way your Claude Code is: a Claude subscription you signed in with pays for them, with no
Anthropic API key in your project.

```ts
import { claudeCode } from "@sixb/claude-code"

export const opus = claudeCode("opus", { reasoning: "high" })
```

Give it to an agent, a project's model catalog (`models: { language: [opus] }`), or `generate()`
like any other language model.

## What runs where

Sixb keeps running the Agent: its system prompt, its tools and its loop. Claude Code only answers.
It runs without its own tools, without your Claude Code settings, `CLAUDE.md` files, skills or MCP
servers, and with Sixb's system prompt in place of its own.

| | |
| --- | --- |
| Tools | Sixb's tools are offered to Claude Code. When the model calls one, the answer ends there, and Sixb runs the tool as it does for every provider. |
| Conversation | Claude Code keeps each conversation in a session. Each answer records its session, so the next call resumes it and sends only the tool results or the next message. |
| Prompt caching | Claude Code caches the session's prompt itself; `caching` options are ignored. |
| Structured output | Supported, through Claude Code's own structured output. |
| Files | Images and PDFs in user messages. |
| Reasoning | Sixb's levels map to Claude Code's effort; `minimal` runs as `low`. |
| Cost | Not reported. A subscription bills by plan, not by call. |

Claude Code cannot resume a session it no longer has, such as one its cleanup removed, or a
conversation whose earlier answers came from another model provider. Then a new session starts
with the conversation so far as a transcript, and with tool calls written out as text.

## Where Claude Code runs

A call runs Claude Code where the call is made, signed in as whoever is signed in there.

| The turn runs | Claude Code runs | Billed to |
| --- | --- | --- |
| On a person's computer, in the desktop app or `sixb agent` | On that computer | That person's Claude plan |
| In the cloud, or a workflow or `generate()` call | In the project's agent worker | The sign-in configured there |

A computer that runs a turn calls Claude Code itself, through its own copy of this provider, and
the project records each call's usage from what the computer reports. The desktop app runs the
`claude` installed on the computer, so install Claude Code there and sign in once. `sixb agent`
runs the copy the SDK ships when no compiled program runs it.

To keep calls on people's computers, so each person's turns use their own plan:

```ts
import { createClaudeCode } from "@sixb/claude-code"

const claudeCode = createClaudeCode({ computersOnly: true })

export const opus = claudeCode("opus", { name: "Opus (your Claude Code)" })
```

The project then never starts Claude Code: a call made anywhere else fails, saying to run the thread
on a computer. Its model list is only the definitions passed in `models`.

To run it in the cloud as well, sign Claude Code in where the agent worker runs: run
`claude setup-token` on your computer, and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN` in
the worker's environment, or pass it as `oauthToken`:

```ts
const claudeCode = createClaudeCode({ oauthToken: () => process.env.CLAUDE_CODE_OAUTH_TOKEN })
```

Turns on people's computers still use their own Claude Code; every other call uses that one
sign-in. The SDK installs Claude Code for Linux, macOS and Windows with the package, so the server
needs nothing else. Claude Code runs beside the worker, not inside the run's sandbox: it runs no
tools, and a token there would be readable by the agent's commands.

## Models

`claudeCode.catalog.list()` returns the models Claude Code offers the account it is signed in
with, such as `opus`, `sonnet`, `haiku` and full model ids, with their names and effort levels.
Loading the list starts Claude Code briefly, once an hour at most. Context windows are not listed:
pass `contextWindow` through `models` when the Agent should size its context to one.

## Options

```ts
import { createClaudeCode } from "@sixb/claude-code"

const provider = createClaudeCode({
  // Run the `claude` on your PATH instead of the one the SDK ships.
  executable: "/usr/local/bin/claude",
  // Bill an API key instead of Claude Code's sign-in.
  apiKey: () => process.env.CLAUDE_CODE_API_KEY,
  // Sign in with a token from `claude setup-token`, where nobody signs in to Claude Code.
  oauthToken: () => process.env.CLAUDE_CODE_OAUTH_TOKEN,
  // Where Claude Code runs, and so where its sessions are filed under ~/.claude/projects.
  cwd: "/tmp/sixb-claude-code",
})

const sonnet = provider("sonnet", { name: "Sonnet", description: "For everyday questions." })
```

`ANTHROPIC_API_KEY` in the environment is not passed to Claude Code, because Claude Code would bill
it ahead of its sign-in. Pass `apiKey` to use a key on purpose.

## Requirements

- Claude Code signed in on the machine that runs the model: run `claude`, then `/login`. A call
  made while it is signed out fails with `Claude Code is not signed in`, and one made where it is
  not installed with `Claude Code is not installed here`.
- Each call starts a Claude Code process, which adds its startup time to every model call.

This provider is for running Sixb on your own computer with your own Claude account. Anthropic does
not allow products built on the Claude Agent SDK to offer claude.ai sign-in to their users unless
Anthropic has approved it: a deployment that serves other people should use `@sixb/anthropic` with
an API key.
