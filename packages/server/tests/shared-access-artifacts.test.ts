import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  type ArtifactFile,
  artifactRef,
  can,
  defineGroup,
  defineObjectType,
  defineRole,
  defineShare,
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  objectRef,
  prop,
  ref,
  resolveAuthorizationContext,
  SixbHost,
} from "@sixb/core"
import { CANVAS_FILE } from "@sixb/core/artifacts"
import { decodeLiveData, encodeLiveData } from "@sixb/core/artifacts/live"
import { createSessionCredential } from "@sixb/core/internal/auth"
import { createTestSixb } from "@sixb/core/testing"
import * as decoding from "lib0/decoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as Y from "yjs"
import { SHARED_ACCESS_GRANT_HEADER_NAME } from "../src/auth/shared-access"
import {
  SHARED_ACCESS_ENDED_CLOSE_CODE,
  SHARED_SOCKET_RECHECK_MS,
} from "../src/routes/ws/shared-sockets"
import { createSixbApi, SixbServer } from "../src/server"
import { createTestBrowserPolicy } from "./helpers"

// A shared link's visitor, a guest, reaches the artifacts the link's objects hold: it reads them
// through the API, watches them live, follows their events, and comments under a name it gives.
// Core's tests own the access rule; these prove the routes and sockets that ask it.

const projectId = "shared-access-artifacts"

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("board", ref.artifact(), { nullable: true }),
  ],
})

const meetingShare = defineShare("meeting", {
  target: Meeting,
  grants: ({ target }) => [can.view(target)],
})

const hosts = defineGroup("meeting-hosts")
const host_ = defineRole("meeting.host", {
  grantedTo: [hosts],
  grants: [can.view(Meeting), can.edit(Meeting), can.share(meetingShare)],
})

afterEach(() => {
  jest.useRealTimers()
})

async function setup() {
  const storage = new InMemoryStorage()
  const blobStorage = new InMemoryBlobStorage()
  const host = new SixbHost({
    id: projectId,
    ontology: [Meeting],
    shares: [meetingShare],
    groups: [hosts],
    roles: [host_],
    storage,
    blobStorage,
    broker: new InMemoryBroker(),
    lakeStorage: new InMemoryLakeStorage(),
    queues: new InMemoryQueues(),
    auth: { id: "test", kind: "dev" as const },
  })
  const server = new SixbServer({
    host,
    hostname: "127.0.0.1",
    port: 0,
    quiet: true,
    browser: createTestBrowserPolicy(),
  })
  const app = createSixbApi(server)

  // Marie hosts the meeting: a member, signed in, without a profile name.
  await storage.auth.users.create({ id: "usr_marie", projectId, email: "marie@example.com" })
  await storage.auth.groupMemberships.upsert({
    projectId,
    userId: "usr_marie",
    groupId: hosts.id,
    source: "manual",
  })
  const credential = createSessionCredential("ses_marie")
  await storage.auth.sessions.create({
    id: credential.sessionId,
    projectId,
    userId: "usr_marie",
    strategyId: "test",
    tokenHash: credential.tokenHash,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  })
  const marieCookie = `sixb_session_app=${credential.cookieValue}`

  const marie = createTestSixb(host, {
    authorization: resolveAuthorizationContext({
      principal: { type: "user", id: "usr_marie" },
      groupIds: [hosts.id],
      roles: host.definitions.security.listResolvedRoles(),
    }),
  })

  const put = async (contents: Record<string, string>): Promise<ArtifactFile[]> =>
    Promise.all(
      Object.entries(contents).map(async ([path, body]) => ({
        path,
        file: await blobStorage.put({ body: new TextEncoder().encode(body), fileName: path }),
      }))
    )

  const canvas = await marie.artifacts.create({
    kind: "canvas",
    title: "Kick-off",
    files: await put({
      [CANVAS_FILE]: JSON.stringify({
        items: [
          { id: "welcome", type: "board", file: "boards/welcome.html", x: 0, y: 0, w: 390, h: 844 },
        ],
      }),
      "boards/welcome.html": "<main><h1>Welcome</h1></main>\n",
    }),
  })
  const other = await marie.artifacts.create({
    kind: "document",
    title: "Budget",
    files: await put({ "document.md": "# Budget\n" }),
  })
  const meetings = createTestSixb(host).objects(Meeting)
  await meetings.upsert({ properties: { id: "m1", board: artifactRef(canvas.artifact.id) } })
  await meetings.upsert({ properties: { id: "m2", board: artifactRef(other.artifact.id) } })

  /** A visitor of the link to `m1`: the session its secret opened, as a browser holds it. */
  const visit = async () => {
    const invitation = await marie.shares.issue(meetingShare, {
      target: objectRef(Meeting, "m1"),
      destinationPath: "/meetings/m1",
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    })
    const grantId = invitation.grant.id
    const exchanged = await app.fetch(
      new Request(`http://api.localhost/api/shared-access/${grantId}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: invitation.secret }),
      })
    )
    const session = (await exchanged.json()) as { csrfToken: string; guestId: string }
    const cookie = (exchanged.headers as Headers & { getSetCookie(): string[] })
      .getSetCookie()
      .map((value) => value.slice(0, value.indexOf(";")))
      .join("; ")

    const request = (method: string, path: string, body?: unknown) =>
      app.fetch(
        new Request(`http://api.localhost${path}`, {
          method,
          headers: {
            cookie,
            [SHARED_ACCESS_GRANT_HEADER_NAME]: grantId,
            "x-sixb-csrf": session.csrfToken,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      )
    const name = (value: string, csrf = session.csrfToken) =>
      app.fetch(
        new Request(`http://api.localhost/api/shared-access/${grantId}/name`, {
          method: "PUT",
          headers: { cookie, "content-type": "application/json", "x-sixb-csrf": csrf },
          body: JSON.stringify({ name: value }),
        })
      )
    /** Gives the name through the started server, which holds the guest's socket. */
    const nameLive = (value: string) =>
      fetch(`http://127.0.0.1:${server.getPort()}/api/shared-access/${grantId}/name`, {
        method: "PUT",
        headers: { cookie, "content-type": "application/json", "x-sixb-csrf": session.csrfToken },
        body: JSON.stringify({ name: value }),
      })
    return { grantId, cookie, guestId: session.guestId, request, name, nameLive }
  }

  const asMarie = (method: string, path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://api.localhost${path}`, {
        method,
        headers: {
          cookie: marieCookie,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    )

  return {
    host,
    storage,
    blobStorage,
    server,
    app,
    marie,
    marieCookie,
    asMarie,
    visit,
    put,
    meetings,
    canvasId: canvas.artifact.id,
    otherId: other.artifact.id,
  }
}

/** The worker's pictures of a version's boards, in both modes and sizes: each board is ready. */
async function pictureBoards(
  storage: InMemoryStorage,
  blobStorage: InMemoryBlobStorage,
  artifactId: string
): Promise<readonly { readonly id: string; readonly renderKey: string }[]> {
  const version = await storage.artifacts.getVersion({ projectId, artifactId, version: 1 })
  const boards =
    version?.outline.kind === "canvas"
      ? version.outline.items.flatMap((item) =>
          item.type === "board" && item.renderKey
            ? [{ id: item.id, renderKey: item.renderKey }]
            : []
        )
      : []

  const picture = await blobStorage.put({
    body: new TextEncoder().encode("a picture"),
    fileName: "board.png",
    mediaType: "image/png",
  })
  await storage.artifacts.putBoardPreviews({
    projectId,
    previews: boards.flatMap((board) =>
      (["light", "dark"] as const).flatMap((theme) =>
        (["full", "small"] as const).map((size) => ({
          renderKey: board.renderKey,
          theme,
          size,
          file: picture,
          createdAt: new Date(),
        }))
      )
    ),
  })
  return boards
}

describe("a shared link's guest", () => {
  // Guard proof: drop `sharedSession` from getArtifact in core's api-routes.ts; the boundary then
  // refuses the guest the canvas its meeting holds.
  test("reads the artifacts its link's objects hold, and nothing else", async () => {
    const { visit, canvasId, otherId } = await setup()
    const guest = await visit()

    const read = await guest.request("GET", `/api/artifacts/${canvasId}`)
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ artifact: { id: canvasId }, access: "read" })
    expect(read.headers.get("cache-control")).toBe("no-store")

    const version = await guest.request("GET", `/api/artifacts/${canvasId}/versions/latest`)
    expect(version.status).toBe(200)
    expect((await guest.request("GET", `/api/artifacts/${canvasId}/holders`)).status).toBe(200)
    expect((await guest.request("GET", `/api/artifacts/${canvasId}/comments`)).status).toBe(200)

    // A board loads as an `<img>` or a frame would: the grant in the query, the cookie as the
    // credential.
    const board = await guest.request(
      "GET",
      `/api/artifacts/${canvasId}/versions/latest/content?path=boards/welcome.html&shareGrant=${guest.grantId}`
    )
    expect(board.status).toBe(200)
    expect(await board.text()).toContain("Welcome")

    // Another meeting's artifact is not shared with the guest.
    const elsewhere = await guest.request("GET", `/api/artifacts/${otherId}`)
    expect(elsewhere.status).toBe(403)
    expect(await elsewhere.json()).toMatchObject({ code: "not_shared" })
  })

  // An `<img>`, a `<video>` or a download link sends cookies and no header: the grant is named in
  // the query. Guard proof: drop the `/content` and `/preview` routes from
  // SHARED_QUERY_SELECTOR_ROUTES (auth/shared-access.ts); the guest's pictures are then refused.
  test("loads a board's picture and a file the way a browser's tags do", async () => {
    const { app, storage, blobStorage, visit, canvasId } = await setup()
    const guest = await visit()

    // The worker pictured the welcome board in light mode.
    const version = await storage.artifacts.getVersion({
      projectId,
      artifactId: canvasId,
      version: 1,
    })
    const board = version?.outline.kind === "canvas" ? version.outline.items[0] : undefined
    if (board?.type !== "board" || !board.renderKey) throw new Error("Expected a board.")
    const picture = await blobStorage.put({
      body: new TextEncoder().encode("a picture"),
      fileName: "welcome.png",
      mediaType: "image/png",
    })
    await storage.artifacts.putBoardPreviews({
      projectId,
      previews: (["light", "dark"] as const).map((theme) => ({
        renderKey: board.renderKey as string,
        theme,
        size: "full" as const,
        file: picture,
        createdAt: new Date(),
      })),
    })

    const base = `http://api.localhost/api/artifacts/${canvasId}/versions/1`
    const urls = [
      `${base}/boards/welcome/preview?theme=light&key=${board.renderKey}`,
      `${base}/content?path=boards/welcome.html&disposition=inline`,
    ]
    const load = (url: string, headers: Record<string, string>) =>
      app.fetch(new Request(url, { headers }))

    for (const url of urls) {
      const loaded = await load(`${url}&shareGrant=${guest.grantId}`, { cookie: guest.cookie })
      expect(loaded.status, url).toBe(200)
      expect(loaded.headers.get("cache-control"), url).toBe("no-store")

      // The query only names the grant: without its cookie, nothing loads.
      expect((await load(`${url}&shareGrant=${guest.grantId}`, {})).status, url).toBe(401)
      // Without the query, the request is nobody's.
      expect((await load(url, { cookie: guest.cookie })).status, url).toBe(401)
    }
  })

  // A board of a version that holds queries is pictured with its author's answers, which the
  // link does not grant. Guard proof: return true from seesBoardPreviews (routes/artifacts.ts);
  // the guest then loads Marie's picture of every meeting.
  test("shows no picture of a board that reads data the link does not grant", async () => {
    const { app, storage, blobStorage, marie, asMarie, visit, put, meetings, canvasId } =
      await setup()
    const guest = await visit()

    // A canvas whose boards read nothing keeps its pictures for the guest.
    await pictureBoards(storage, blobStorage, canvasId)
    const plain = await guest.request("GET", `/api/artifacts/${canvasId}/versions/1`)
    expect(await plain.json()).toMatchObject({ boardPreviews: { welcome: "ready" } })

    const board = {
      id: "agenda",
      type: "board",
      file: "boards/agenda.html",
      x: 0,
      y: 0,
      w: 390,
      h: 844,
    }
    const live = await marie.artifacts.create({
      kind: "canvas",
      title: "Every meeting",
      files: await put({
        [CANVAS_FILE]: JSON.stringify({ items: [board] }),
        "boards/agenda.html": "<main><h1>Meetings</h1></main>\n",
        "queries/meetings.json": JSON.stringify({
          kind: "start",
          objectTypeId: "Meeting",
        }),
      }),
    })
    await meetings.upsert({ properties: { id: "m1", board: artifactRef(live.artifact.id) } })
    const [pictured] = await pictureBoards(storage, blobStorage, live.artifact.id)

    const base = `/api/artifacts/${live.artifact.id}/versions/1`
    const preview = `${base}/boards/agenda/preview?theme=light&key=${pictured?.renderKey}`
    const statuses = async (response: Response) =>
      ((await response.json()) as { boardPreviews?: Record<string, string> }).boardPreviews

    // Marie sees her pictures.
    expect(await statuses(await asMarie("GET", base))).toEqual({ agenda: "ready" })
    expect((await asMarie("GET", preview)).status).toBe(200)

    // The guest sees the board's outline, and runs its query with their own rights once it opens.
    expect(await statuses(await guest.request("GET", base))).toEqual({ agenda: "none" })
    const refused = await app.fetch(
      new Request(`http://api.localhost${preview}&shareGrant=${guest.grantId}`, {
        headers: { cookie: guest.cookie },
      })
    )
    expect(refused.status).toBe(404)
    expect(await refused.json()).toMatchObject({ code: "preview_not_found" })
  })

  // Guard proof: opt any of these routes into `sharedSession` in core's api-routes.ts; the
  // boundary then lets the guest's request through.
  test("writes nothing, keeps nothing, and lists no gallery", async () => {
    const { visit, canvasId } = await setup()
    const guest = await visit()
    const files = { kind: "canvas", title: "Mine", files: [] }

    for (const [method, path, body] of [
      ["GET", "/api/artifacts", undefined],
      ["POST", "/api/artifacts", files],
      ["PUT", `/api/artifacts/${canvasId}/content`, files],
      ["POST", `/api/artifacts/${canvasId}/freeze`, {}],
      ["DELETE", `/api/artifacts/${canvasId}`, undefined],
      ["GET", `/api/artifacts/${canvasId}/state`, undefined],
      ["PUT", `/api/artifacts/${canvasId}/state/seen`, { value: true }],
      ["GET", `/api/artifacts/${canvasId}/restore-points`, undefined],
      ["POST", `/api/artifacts/${canvasId}/restore-points/1/restore`, {}],
      ["POST", `/api/artifacts/${canvasId}/comments/cmt_x/resolve`, {}],
      ["DELETE", `/api/artifacts/${canvasId}/comments/cmt_x`, undefined],
    ] as const) {
      const refused = await guest.request(method, path, body)
      expect(refused.status, `${method} ${path}`).toBe(403)
      expect(await refused.json()).toEqual({
        error: "Shared access is not allowed for this request",
      })
    }
  })

  // Guard proof: drop the `email` option from commentAuthors in routes/artifacts.ts; the guest
  // then reads Marie's email beside her comment.
  test("comments under the name it gives once, and never learns a member's email", async () => {
    const { visit, marie, asMarie, canvasId } = await setup()
    const guest = await visit()
    const path = `/api/artifacts/${canvasId}/comments`

    const nameless = await guest.request("POST", path, { body: "Can we start at 9?" })
    expect(nameless.status).toBe(400)
    expect(await nameless.json()).toMatchObject({ code: "name_required" })

    // A name is checked after the session and its CSRF token.
    expect((await guest.name("Ava", "x".repeat(43))).status).toBe(403)
    const blank = await guest.name("  \n ")
    expect(blank.status).toBe(400)
    expect(await blank.json()).toMatchObject({ code: "invalid_name" })

    const named = await guest.name("  Ava   Martin ")
    expect(named.status).toBe(200)
    expect(await named.json()).toMatchObject({ guestId: guest.guestId, guestName: "Ava Martin" })

    const added = await guest.request("POST", path, { body: "Can we start at 9?" })
    expect(added.status).toBe(201)
    expect(await added.json()).toMatchObject({
      author: { type: "guest", id: guest.guestId },
      authorName: "Ava Martin",
    })
    await marie.artifacts.addComment(canvasId, { body: "Sure" })

    const authors = async (response: Response) =>
      ((await response.json()) as { comments: { authorName: string | null }[] }).comments.map(
        (comment) => comment.authorName
      )
    expect(await authors(await guest.request("GET", path))).toEqual(["Ava Martin", null])
    expect(await authors(await asMarie("GET", path))).toEqual(["Ava Martin", "marie@example.com"])
  })

  // Guard proof: drop the read from the timer in SharedSockets (routes/ws/shared-sockets.ts); the
  // revoked guest's socket then stays open, watching.
  test("watches its canvas live under its name, until the link is revoked", async () => {
    jest.useFakeTimers()
    const { server, storage, visit, canvasId } = await setup()
    const guest = await visit()
    await guest.name("Ava Martin")
    await server.start()

    const socket = openSocket(server, `/ws/artifacts?shareGrant=${guest.grantId}`, guest.cookie)
    try {
      expect(await socket.next()).toEqual({ type: "connected", channel: "artifacts" })
      socket.send({ type: "join", artifactId: canvasId })
      expect(await socket.next()).toMatchObject({
        type: "joined",
        artifactId: canvasId,
        access: "watch",
        user: { id: `guest:${guest.guestId}`, name: "Ava Martin", guest: true },
      })

      await storage.shareSessions.revoke({
        projectId,
        id: guest.guestId,
        revokedAt: new Date(),
      })
      jest.advanceTimersByTime(SHARED_SOCKET_RECHECK_MS)
      expect(await socket.closed).toBe(SHARED_ACCESS_ENDED_CLOSE_CODE)

      // And the next request is refused.
      expect((await guest.request("GET", `/api/artifacts/${canvasId}`)).status).toBe(401)
    } finally {
      socket.close()
      await server.stop()
    }
  })

  // Guard proof: drop `onRenamed` from the live socket's SharedSockets.open (routes/ws/artifacts.ts);
  // Marie then still sees the guest unnamed after they gave their name.
  test("shows a guest under the name they give once they are watching", async () => {
    const { server, visit, canvasId, marieCookie } = await setup()
    const guest = await visit()
    await server.start()

    const watching = openSocket(server, `/ws/artifacts?shareGrant=${guest.grantId}`, guest.cookie)
    const marie = openSocket(server, "/ws/artifacts", marieCookie)
    try {
      expect(await watching.next()).toMatchObject({ type: "connected" })
      watching.send({ type: "join", artifactId: canvasId })
      expect(await watching.until((message) => message.type === "joined")).toMatchObject({
        user: { name: "", guest: true },
      })

      // The guest points somewhere, as a client's awareness does.
      const doc = new Y.Doc()
      const awareness = new awarenessProtocol.Awareness(doc)
      awareness.setLocalState({ cursor: { x: 1, y: 1 } })
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [doc.clientID])
      watching.send({ type: "awareness", artifactId: canvasId, data: encodeLiveData(update) })

      expect(await marie.next()).toMatchObject({ type: "connected" })
      marie.send({ type: "join", artifactId: canvasId })
      const guestUser = async () => {
        const message = await marie.until(
          (each) => each.type === "awareness" && guestStateOf(each, doc.clientID) !== undefined
        )
        return guestStateOf(message, doc.clientID)?.user
      }
      expect(await guestUser()).toMatchObject({ name: "", guest: true })

      // The name comes from the session, never from what the client says of itself.
      expect((await guest.nameLive("Ava Martin")).status).toBe(200)
      expect(await guestUser()).toMatchObject({ name: "Ava Martin", guest: true })
    } finally {
      watching.close()
      marie.close()
      await server.stop()
    }
  })

  // Guard proof: drop `shared.open(ws)` from routes/ws/events.ts; the revoked guest's event stream
  // then stays open, still delivering the team's comments.
  test("closes the event stream once the link is revoked", async () => {
    jest.useFakeTimers()
    const { server, storage, visit } = await setup()
    const guest = await visit()
    await server.start()

    const socket = openSocket(server, `/ws/events?shareGrant=${guest.grantId}`, guest.cookie)
    try {
      expect(await socket.next()).toEqual({ type: "connected", channel: "events" })

      await storage.shareSessions.revoke({ projectId, id: guest.guestId, revokedAt: new Date() })
      jest.advanceTimersByTime(SHARED_SOCKET_RECHECK_MS)
      expect(await socket.closed).toBe(SHARED_ACCESS_ENDED_CLOSE_CODE)
    } finally {
      socket.close()
      await server.stop()
    }
  })

  // Guard proof: answer `[]` for delegated authority in core's `events.visible`; the guest's
  // subscription then delivers nothing.
  test("follows the events of its artifacts, and no others", async () => {
    const { server, marie, visit, canvasId, otherId } = await setup()
    const guest = await visit()
    await server.start()

    const socket = openSocket(server, `/ws/events?shareGrant=${guest.grantId}`, guest.cookie)
    try {
      expect(await socket.next()).toEqual({ type: "connected", channel: "events" })
      socket.send({ type: "subscribe", topic: "artifacts" })
      expect(await socket.next()).toMatchObject({ type: "subscribed" })

      // The other meeting's comment comes first: the first event delivered proves the filter.
      await marie.artifacts.addComment(otherId, { body: "Not for guests" })
      await marie.artifacts.addComment(canvasId, { body: "Welcome aboard" })
      expect(await socket.next()).toMatchObject({
        type: "event",
        event: { type: "artifact.commented", payload: { artifactId: canvasId } },
      })
    } finally {
      socket.close()
      await server.stop()
    }
  })

  // Guard proof: drop the origin check in createSixbApi's onRequest; another site's page then
  // opens the guest's socket with their cookie.
  test("opens no socket from another site's page", async () => {
    const { app, visit } = await setup()
    const guest = await visit()

    const hijacked = await app.fetch(
      new Request(`http://api.localhost/ws/artifacts?shareGrant=${guest.grantId}`, {
        headers: {
          cookie: guest.cookie,
          origin: "https://attacker.example",
          connection: "upgrade",
          upgrade: "websocket",
        },
      })
    )
    expect(hijacked.status).toBe(403)
  })
})

/**
 * A socket to the server, presenting a guest's cookies as a browser would: messages are buffered
 * so none is lost between two awaits, and `closed` settles with the close code.
 */
function openSocket(server: SixbServer, path: string, cookie: string) {
  // Bun's WebSocket accepts an options object with `headers`; the DOM lib types only model the
  // subprotocols argument, so widen at the call site.
  const ws = new WebSocket(`ws://127.0.0.1:${server.getPort()}${path}`, {
    headers: { cookie },
  } as unknown as string[])
  const received: unknown[] = []
  let wake: (() => void) | undefined
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(String((event as MessageEvent).data)))
    wake?.()
  })
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (event) => resolve((event as CloseEvent).code))
  })
  const opened = new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()))

  const next = async (): Promise<unknown> => {
    while (received.length === 0) await new Promise<void>((resolve) => (wake = resolve))
    return received.shift()
  }

  return {
    closed,
    next,
    /** The next message that matches, skipping the others. */
    async until(matches: (message: Record<string, unknown>) => boolean) {
      for (;;) {
        const message = (await next()) as Record<string, unknown>
        if (matches(message)) return message
      }
    },
    send(message: unknown) {
      void opened.then(() => ws.send(JSON.stringify(message)))
    },
    close() {
      ws.close()
    },
  }
}

/** The awareness state a live `awareness` message carries for one client, if it carries one. */
function guestStateOf(
  message: Record<string, unknown>,
  clientId: number
): { readonly user?: unknown } | undefined {
  const bytes = decodeLiveData(String(message.data))
  if (!bytes) return undefined

  const decoder = decoding.createDecoder(bytes)
  const count = decoding.readVarUint(decoder)
  for (let index = 0; index < count; index += 1) {
    const client = decoding.readVarUint(decoder)
    decoding.readVarUint(decoder)
    const state = JSON.parse(decoding.readVarString(decoder)) as { readonly user?: unknown } | null
    if (client === clientId && state) return state
  }
  return undefined
}
