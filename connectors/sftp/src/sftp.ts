import type { SFTPWrapper, Client as SshClient } from "ssh2"
import { createSftpClient } from "./client"
import { createSshClient } from "./ssh"
import type { SftpClient, SftpConnection, SftpConnector, SftpOptions } from "./types"

const DEFAULT_READ_AHEAD_REQUESTS = 1
const MAX_READ_AHEAD_REQUESTS = 64

type ConnectionState = {
  client: SshClient
  closed: boolean
}

const connections = new WeakMap<SftpClient, ConnectionState>()

/**
 * Create an SFTP connector backed by ssh2.
 *
 * The connected client exposes a small promise-based file API over a single
 * SSH connection and SFTP session.
 */
export function sftp(connection: SftpConnection, options: SftpOptions = {}): SftpConnector {
  assertConnection(connection)
  const readAheadRequests = resolveReadAheadRequests(options.readAheadRequests)

  return {
    type: "sftp",
    async connect(context) {
      if (context.signal.aborted) {
        throw new Error("[SixbSftp] Connection aborted before it started.")
      }

      const sshClient = await createSshClient()
      if (context.signal.aborted) {
        throw new Error("[SixbSftp] Connection aborted before it started.")
      }

      const sftpSession = await connectSftpClient(sshClient, connection, context.signal)
      const sftpClient = createSftpClient(sftpSession, { readAheadRequests })
      const state = {
        client: sshClient,
        closed: false,
      }

      sshClient.once("close", () => {
        state.closed = true
      })

      connections.set(sftpClient, state)
      return sftpClient
    },
    async disconnect(client) {
      const state = connections.get(client)
      if (!state || state.closed) {
        return
      }

      await closeClient(state)
      connections.delete(client)
    },
  }
}

function resolveReadAheadRequests(value: number | undefined): number {
  const resolved = value ?? DEFAULT_READ_AHEAD_REQUESTS
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < DEFAULT_READ_AHEAD_REQUESTS ||
    resolved > MAX_READ_AHEAD_REQUESTS
  ) {
    throw new Error(
      `[SixbSftp] readAheadRequests must be an integer between ${DEFAULT_READ_AHEAD_REQUESTS} and ${MAX_READ_AHEAD_REQUESTS}.`
    )
  }

  return resolved
}

async function connectSftpClient(
  client: SshClient,
  connection: SftpConnection,
  signal: AbortSignal
): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort)
      client.off("ready", onReady)
      client.off("error", onError)
      client.off("close", onClose)
    }

    const fail = (error: Error) => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      client.end()
      reject(error)
    }

    const onAbort = () => {
      fail(new Error("[SixbSftp] Connection aborted."))
    }

    const onError = (error: Error) => {
      fail(error)
    }

    const onClose = () => {
      fail(new Error("[SixbSftp] Connection closed before the SFTP session was ready."))
    }

    const onReady = () => {
      client.sftp((error, sftpClient) => {
        if (settled) {
          return
        }

        if (error || !sftpClient) {
          fail(error ?? new Error("[SixbSftp] Failed to start SFTP session."))
          return
        }

        settled = true
        cleanup()
        resolve(sftpClient)
      })
    }

    signal.addEventListener("abort", onAbort, { once: true })
    client.once("ready", onReady)
    client.once("error", onError)
    client.once("close", onClose)
    client.connect(connection)
  })
}

async function closeClient(state: ConnectionState): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      cleanup()
      state.closed = true
      resolve()
    }

    const cleanup = () => {
      state.client.off("close", finish)
      state.client.off("error", finish)
    }

    state.client.once("close", finish)
    state.client.once("error", finish)
    state.client.end()
  })
}

function assertConnection(connection: SftpConnection): void {
  if (!connection.username?.trim()) {
    throw new Error("[SixbSftp] username must not be empty.")
  }

  if (!connection.host?.trim() && !connection.sock) {
    throw new Error("[SixbSftp] host must not be empty when sock is not provided.")
  }
}
