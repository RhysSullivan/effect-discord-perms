import { Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { ChannelId, GuildId, MessageId, UserId } from "../../src/Snowflake.ts"

/** Branded IDs at run time (DESIGN §2.1): branding is a decode, `make` is the trusted constructor. */

describe("snowflake IDs", () => {
  it("make accepts a 17 to 20 digit snowflake and returns the same string", () => {
    expect(ChannelId.make("12345678901234567")).toBe("12345678901234567")
    expect(UserId.make("12345678901234567890")).toBe("12345678901234567890")
  })

  it("make throws on a malformed snowflake", () => {
    for (const bad of ["", "1234567890123456", "123456789012345678901", "12345678901234567a", " 123456789012345678"]) {
      expect(() => GuildId.make(bad), bad).toThrow()
    }
  })

  it("decoding brands valid snowflakes and fails on anything else", () => {
    const decode = Schema.decodeUnknownExit(MessageId)
    expect(decode("123456789012345678")).toEqual(Exit.succeed("123456789012345678"))
    expect(Exit.isFailure(decode(123456789012345678))).toBe(true)
    expect(Exit.isFailure(decode("not a snowflake"))).toBe(true)
  })
})
