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
| Cost | $0 per call: a Claude plan bills by subscription, not by call. Cost limits admit the calls, and token limits count them. |

Claude Code also adds context about its own process to every conversation, and offers no way to
leave it out: its working directory, platform and scratchpad, and the email address of the
account it is signed in with. Sixb tells the model that this describes Claude Code, not where its
tools run. A server signed in only with `CLAUDE_CODE_OAUTH_TOKEN` has no account email to add.

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
the worker's environment. Claude Code reads it there itself.

Turns on people's computers still use their own Claude Code; every other call uses that one
sign-in. The SDK installs Claude Code for Linux, macOS and Windows with the package, so the server
needs nothing else. Claude Code runs beside the worker, not inside the run's sandbox: it runs no
tools, and a token there would be readable by the agent's commands.

## Models

`claudeCode.catalog.list()` returns the models Claude Code offers the account it is signed in
with, such as `opus`, `sonnet`, `haiku` and full model ids, with their names and effort levels.
Loading the list starts Claude Code briefly, once an hour at most.

A model bound for a call, such as the Agent's, takes the context window Claude Code gives the
account, such as 1,000,000 tokens, so the Agent compacts a conversation only near it. Claude Code
reports it without a model call. On a person's computer, that computer's Claude Code reports it,
including with `computersOnly`. A `contextWindow` passed through `models` takes precedence.

## Options

```ts
import { createClaudeCode } from "@sixb/claude-code"

const provider = createClaudeCode({
  // Run the `claude` on your PATH instead of the one the SDK ships.
  executable: "/usr/local/bin/claude",
  // Definitions that override Claude Code's own list, such as one with a context window.
  models: [],
  // Keep every call on people's computers (see above).
  computersOnly: true,
})

const sonnet = provider("sonnet", { name: "Sonnet", description: "For everyday questions." })
```

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` in the environment are not passed to Claude Code,
because Claude Code would bill them ahead of its sign-in. To bill an API key, use
`@sixb/anthropic`. Neither are the variables a Claude Code session exports to the commands it runs,
such as `sixb dev` started from one: Claude Code would act as part of that session.

## Requirements

- Claude Code signed in on the machine that runs the model: run `claude`, then `/login`. A call
  made while it is signed out fails with `Claude Code is not signed in`, and one made where it is
  not installed with `Claude Code is not installed here`.
- A call the Claude plan's usage limit refuses fails with the limit and the time it resets, and is
  not retried: only extra usage, or the reset, lets the next call through.
- Each call starts a Claude Code process, which adds its startup time to every model call.

This provider is for running Sixb on your own computer with your own Claude account. Anthropic does
not allow products built on the Claude Agent SDK to offer claude.ai sign-in to their users unless
Anthropic has approved it: a deployment that serves other people should use `@sixb/anthropic` with
an API key.
