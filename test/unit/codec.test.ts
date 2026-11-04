import { Discord } from "dfx"
import { Option } from "effect"
import { describe, expect, it } from "vitest"
import { channelObfuscation, identifiedIn, withCapabilities } from "../../src/gateway/Codec.ts"

/**
 * The capabilities codec's record (DESIGN §4.15, §4.4; after the M7 verifier): what the identity check compares is
 * read back from the encoded text the socket receives, so an Identify that went out without the capability, or with
 * other intents, shows as such. The end-to-end wire check is the fake gateway's (`bot-build.test.ts`,
 * `identities.test.ts`), which parses the IDENTIFY frame it receives.
 */
const identify: Discord.GatewaySendPayload = {
  op: Discord.GatewayOpcodes.Identify,
  d: { token: "fake-token", intents: 3, properties: { os: "linux", browser: "dfx", device: "dfx" } }
}

describe("the gateway codec's Identify record", () => {
  it("reads the intents and the capability from the encoded Identify", () => {
    expect(identifiedIn(JSON.stringify(withCapabilities(identify)))).toStrictEqual(Option.some({ intents: 3, capabilities: channelObfuscation }))
  })

  it("shows an Identify encoded without capabilities as having none, so the identity check can fail", () => {
    expect(identifiedIn(JSON.stringify(identify))).toStrictEqual(Option.some({ intents: 3, capabilities: undefined }))
  })

  it("records nothing for other opcodes, which the codec leaves unchanged", () => {
    const heartbeat: Discord.GatewaySendPayload = { op: Discord.GatewayOpcodes.Heartbeat, d: null }
    expect(withCapabilities(heartbeat)).toBe(heartbeat)
    expect(identifiedIn(JSON.stringify(heartbeat))).toStrictEqual(Option.none())
  })
})
