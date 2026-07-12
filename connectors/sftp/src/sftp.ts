import type { SFTPWrapper } from "ssh2"
import { Client } from "ssh2"
import { closeSftpReadStreams, createSftpClient } from "./client"
import type { SftpClient, SftpConnection, SftpConnector } from "./types"

type ConnectionState = {
  client: Client
  closed: boolean
}

const connections = new WeakMap<SftpClient, ConnectionState>()

/**
 * Create an SFTP connector backed by ssh2.
 *
 * The connected client exposes a small promise-based file API over a single
 * SSH connection and SFTP session.
 */
export function sftp(connection: SftpConnection): SftpConnector {
  assertConnection(connection)

  return {
    type: "sftp",
    async connect(context) {
      if (context.signal.aborted) {
        throw new Error("[SixbSftp] Connection aborted before it started.")
      }

      const sshClient = new Client()
      const sftpSession = await connectSftpClient(sshClient, connection, context.signal)
      const sftpClient = createSftpClient(sftpSession)
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

      try {
        await closeSftpReadStreams(client)
      } finally {
        await closeClient(state)
        connections.delete(client)
      }
    },
  }
}

async function connectSftpClient(
  client: Client,
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

    const forceClose = () => {
      state.client.destroy()
    }

    const cleanup = () => {
      state.client.off("close", finish)
      state.client.off("error", forceClose)
    }

    state.client.once("close", finish)
    state.client.once("error", forceClose)
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
