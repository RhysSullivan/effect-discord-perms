/**
 * The gateway codec (DESIGN §4.15, D20, G7). dfx 1.1.1's Identify carries no `capabilities`, so a bot cannot opt
 * in to channel obfuscation (mandatory from 2026-11-16) through dfx alone. This codec replaces dfx's
 * `JsonDiscordWSCodecLive`: it adds `capabilities: 32768` (ChannelObfuscation) to Identify (op 2), leaves every
 * other opcode to dfx's JSON codec, and records the intents bitfield and capabilities it actually sent, which the
 * harness's identity check compares with the declared intents (§4.4). The record is read back from the very string
 * the codec hands the socket (`identifiedIn`), so it shows what went out on the wire, not what the codec meant to
 * send (after the M7 verifier: the record had been set beside the payload, from the same constant, so comparing its
 * capabilities with that constant could never fail).
 *
 * `DiscordLiveWithCapabilities` is dfx's 8-line `DiscordLive` composition (`dfx/gateway`) with this codec in
 * place of the JSON one, and the record exposed (LOG.md, "dfx deviations"). It uses dfx's own layer values, so a
 * build that also provides `DiscordRESTMemoryLive` shares one REST client and one rate-limit store with it.
 */
import { DiscordRESTLive } from "dfx/DiscordREST"
import type { DiscordREST } from "dfx/DiscordREST"
import { ShardStateStore } from "dfx/DiscordGateway/Shard/StateStore"
import { type DiscordGateway, DiscordGatewayLive, DiscordWS, ShardStore } from "dfx/gateway"
import { MemoryRateLimitStoreLive, type RateLimiter, RateLimiterLive } from "dfx/RateLimit"
import type { DiscordConfig } from "dfx/DiscordConfig"
import { Discord } from "dfx"
import { Context, Effect, Layer, Option, Schema } from "effect"
import type * as HttpClient from "effect/http/HttpClient"
import type * as Socket from "effect/socket/Socket"

/** `GatewayCapabilityBits.ChannelObfuscation`: channels the bot cannot view arrive obfuscated (H-160). */
export const channelObfuscation = 1 << 15

/** One Identify the codec sent, as read back from its encoded bytes: the intents bitfield and the capabilities (absent when it had none). */
export interface Identified {
  readonly intents: number
  readonly capabilities: number | undefined
}

/** What the codec sent, for the identity check. */
export interface Interface {
  /** Every Identify sent so far, oldest first (a reconnect that cannot resume identifies again). */
  readonly identified: Effect.Effect<ReadonlyArray<Identified>>
}

/** The record of the Identify payloads one build's codec sent. */
export class SentIdentify extends Context.Service<SentIdentify, Interface>()("gateway/SentIdentify") {}

/** The payload `encode` sends for `payload`: Identify with `capabilities` added, anything else unchanged. Pure. */
export const withCapabilities = (payload: Discord.GatewaySendPayload): Discord.GatewaySendPayload | (Discord.GatewayIdentify & { readonly d: { readonly capabilities: number } }) =>
  payload.op === Discord.GatewayOpcodes.Identify ? { ...payload, d: { ...payload.d, capabilities: channelObfuscation } } : payload

const IdentifyWire = Schema.fromJsonString(
  Schema.Struct({ op: Schema.Literal(Discord.GatewayOpcodes.Identify), d: Schema.Struct({ intents: Schema.Int, capabilities: Schema.optionalKey(Schema.Int) }) })
)
const decodeIdentify = Schema.decodeUnknownOption(IdentifyWire)

/** The Identify an encoded gateway payload carries, read from the JSON text itself; `None` for any other payload. */
export const identifiedIn = (encoded: string): Option.Option<Identified> =>
  Option.map(decodeIdentify(encoded), (wire) => ({ intents: wire.d.intents, capabilities: wire.d.capabilities }))

/**
 * The codec and its record. `encode` is synchronous (dfx's codec interface), so the record is a list owned by this
 * layer's instance and appended to only by `encode`; `identified` reads a copy.
 */
export const layer: Layer.Layer<DiscordWS.DiscordWSCodec | SentIdentify> = Layer.effectContext(
  Effect.gen(function* () {
    const json = yield* DiscordWS.DiscordWSCodec
    const sent: Array<Identified> = []
    const codec: DiscordWS.DiscordWSCodecService = {
      type: json.type,
      encode: (payload) => {
        if (payload.op !== Discord.GatewayOpcodes.Identify) return json.encode(payload)
        const encoded = JSON.stringify(withCapabilities(payload))
        const identified = identifiedIn(encoded)
        // an Identify this codec encoded that does not read back as one is a bug here, a defect (dfx runs encode in an Effect)
        if (Option.isNone(identified)) throw new Error("gateway codec: the encoded Identify does not read back as an Identify")
        sent.push(identified.value)
        return encoded
      },
      decode: json.decode
    }
    return Context.make(DiscordWS.DiscordWSCodec, codec).pipe(Context.add(SentIdentify, SentIdentify.of({ identified: Effect.sync(() => [...sent]) })))
  })
).pipe(Layer.provide(DiscordWS.JsonDiscordWSCodecLive))

/** dfx's `DiscordLive` with the capabilities codec (see the module comment). */
export const DiscordLiveWithCapabilities: Layer.Layer<
  RateLimiter | DiscordGateway | DiscordREST | SentIdentify,
  never,
  DiscordConfig | Socket.WebSocketConstructor | HttpClient.HttpClient
> = Layer.mergeAll(RateLimiterLive, DiscordGatewayLive).pipe(
  Layer.provideMerge(DiscordRESTLive),
  Layer.provideMerge(layer),
  Layer.provide(MemoryRateLimitStoreLive),
  Layer.provide(ShardStore.MemoryShardStoreLive),
  Layer.provide(ShardStateStore.MemoryLive)
)
