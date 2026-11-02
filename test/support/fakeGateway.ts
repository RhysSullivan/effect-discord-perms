/**
 * A fake Discord gateway behind a fake `WebSocketConstructor`, for tests that build the real bot layer
 * (DESIGN §4.2): it answers HELLO, IDENTIFY (READY, then GUILD_CREATE when the world has the guild) and
 * heartbeats, and lets a test push further dispatches. Nothing leaves the process. Test-only.
 */
import { Effect, Layer, Ref } from "effect"
import * as Socket from "effect/socket/Socket"

/** What the fake gateway knows. */
export interface GatewayWorld {
  /** The bot user a token belongs to; `undefined` closes the socket with 4004 (authentication failed). */
  readonly userFor: (token: string) => string | undefined
  /** The GUILD_CREATE payloads to send after READY, for this user. */
  readonly guildsFor: (userId: string) => ReadonlyArray<unknown>
}

/** The fake gateway and what it saw. */
export interface FakeGateway {
  readonly layer: Layer.Layer<Socket.WebSocketConstructor>
  /** Every IDENTIFY payload received: the token is replaced by the user it belongs to; intents are kept. */
  readonly identified: Effect.Effect<ReadonlyArray<{ readonly user: string | undefined; readonly intents: number }>>
  /** Sends a dispatch to every socket that has identified. */
  readonly dispatch: (event: string, data: unknown) => Effect.Effect<void>
  /** When the first socket was opened, relative to other recorded events (see `openedAt`). */
  readonly opened: Effect.Effect<number>
}

type Listener = (event: Socket.WebSocketEvent) => void

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null

/** Builds a fake gateway over `world`. `clock` orders socket opening against the caller's own records. */
export const makeFakeGateway = (world: GatewayWorld, clock: () => number): Effect.Effect<FakeGateway> =>
  Effect.gen(function* () {
    const identified = yield* Ref.make<ReadonlyArray<{ readonly user: string | undefined; readonly intents: number }>>([])
    const sockets = new Set<FakeSocket>()
    let opened = -1

    class FakeSocket implements Socket.WebSocketLike {
      readyState = 1
      private listeners = new Map<string, Set<Listener>>()
      private sequence = 0
      private helloSent = false
      ready = false

      addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
        const set = this.listeners.get(type) ?? new Set()
        set.add(listener)
        this.listeners.set(type, set)
        if (type === "message" && !this.helloSent) {
          this.helloSent = true
          setTimeout(() => this.emit({ op: 10, d: { heartbeat_interval: 41250 } }), 0)
        }
      }
      removeEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
        this.listeners.get(type)?.delete(listener)
      }
      close(code = 1000, reason = ""): void {
        if (this.readyState >= 2) return
        this.readyState = 3
        sockets.delete(this)
        for (const listener of this.listeners.get("close") ?? []) listener({ code, reason })
      }
      send(data: string | Uint8Array<ArrayBuffer>): void {
        const parsed: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data))
        if (!isRecord(parsed)) return
        if (parsed.op === 1) {
          setTimeout(() => this.emit({ op: 11 }), 0)
          return
        }
        if (parsed.op === 2 && isRecord(parsed.d)) {
          const token = typeof parsed.d.token === "string" ? parsed.d.token : ""
          const intents = typeof parsed.d.intents === "number" ? parsed.d.intents : -1
          const user = world.userFor(token)
          Effect.runSync(Ref.update(identified, (entries) => [...entries, { user, intents }]))
          if (user === undefined) {
            setTimeout(() => this.close(4004, "Authentication failed."), 0)
            return
          }
          setTimeout(() => {
            this.ready = true
            this.dispatch("READY", {
              v: 10,
              user: { id: user, username: "fake", discriminator: "0", global_name: null, avatar: null, bot: true },
              guilds: [],
              session_id: `session-${user}`,
              resume_gateway_url: "wss://gateway.invalid",
              application: { id: "100000000000000000", flags: 0 }
            })
            for (const guild of world.guildsFor(user)) this.dispatch("GUILD_CREATE", guild)
          }, 0)
        }
      }
      dispatch(event: string, data: unknown): void {
        this.sequence += 1
        this.emit({ op: 0, s: this.sequence, t: event, d: data })
      }
      private emit(payload: unknown): void {
        if (this.readyState !== 1) return
        for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(payload) })
      }
    }

    const layer = Layer.succeed(Socket.WebSocketConstructor, () => {
      if (opened < 0) opened = clock()
      const socket = new FakeSocket()
      sockets.add(socket)
      return socket
    })
    return {
      layer,
      identified: Ref.get(identified),
      dispatch: (event, data) =>
        Effect.sync(() => {
          for (const socket of sockets) if (socket.ready) socket.dispatch(event, data)
        }),
      opened: Effect.sync(() => opened)
    }
  })
