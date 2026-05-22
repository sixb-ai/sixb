import type { Callback, SFTPWrapper } from "ssh2"
import { Client } from "ssh2"
import type { SftpClient, SftpConnection, SftpConnector, SftpWriteData } from "./types"

const CONNECTION = Symbol("ParioSftpConnection")

type InternalSftpClient = SftpClient & {
  [CONNECTION]: {
    client: Client
    closed: boolean
  }
}

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
        throw new Error("[ParioSftp] Connection aborted before it started.")
      }

      const client = new Client()
      const sftpClient = await connectSftpClient(client, connection, context.signal)
      return createSftpClient(client, sftpClient)
    },
    async disconnect(client) {
      const state = (client as InternalSftpClient)[CONNECTION]
      if (!state || state.closed) {
        return
      }

      await closeClient(state)
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
      fail(new Error("[ParioSftp] Connection aborted."))
    }

    const onError = (error: Error) => {
      fail(error)
    }

    const onClose = () => {
      fail(new Error("[ParioSftp] Connection closed before the SFTP session was ready."))
    }

    const onReady = () => {
      client.sftp((error, sftpClient) => {
        if (settled) {
          return
        }

        if (error || !sftpClient) {
          fail(error ?? new Error("[ParioSftp] Failed to start SFTP session."))
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

function createSftpClient(client: Client, sftpClient: SFTPWrapper): SftpClient {
  const state = {
    client,
    closed: false,
  }

  client.once("close", () => {
    state.closed = true
  })

  const wrappedClient: InternalSftpClient = {
    [CONNECTION]: state,
    list(path) {
      return callResult((callback) => sftpClient.readdir(path, callback))
    },
    stat(path) {
      return callResult((callback) => sftpClient.stat(path, callback))
    },
    exists(path) {
      return new Promise((resolve) => {
        sftpClient.exists(path, (exists) => resolve(exists))
      })
    },
    read(path) {
      return callResult((callback) => sftpClient.readFile(path, callback))
    },
    write(path, data) {
      return callVoid((callback) => sftpClient.writeFile(path, toBuffer(data), callback))
    },
    rename(sourcePath, destinationPath) {
      return callVoid((callback) => sftpClient.rename(sourcePath, destinationPath, callback))
    },
    delete(path) {
      return callVoid((callback) => sftpClient.unlink(path, callback))
    },
    mkdir(path) {
      return callVoid((callback) => sftpClient.mkdir(path, callback))
    },
    rmdir(path) {
      return callVoid((callback) => sftpClient.rmdir(path, callback))
    },
  }

  return wrappedClient
}

function callVoid(method: (callback: Callback) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    method((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

function callResult<T>(
  method: (callback: (error: Error | undefined, result: T) => void) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    method((error, result) => {
      if (error) {
        reject(error)
        return
      }

      resolve(result)
    })
  })
}

function toBuffer(data: SftpWriteData): string | Buffer {
  if (typeof data === "string" || Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

async function closeClient(state: InternalSftpClient[typeof CONNECTION]): Promise<void> {
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
    throw new Error("[ParioSftp] username must not be empty.")
  }

  if (!connection.host?.trim() && !connection.sock) {
    throw new Error("[ParioSftp] host must not be empty when sock is not provided.")
  }
}
