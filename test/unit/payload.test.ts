import { describe, expect, it } from "vitest"
import { PreflightDecision } from "../../src/errors/Cause.ts"
import { CustomId, linkButton, premiumButton, row, textDisplay } from "../../src/payload/Components.ts"
import * as Limits from "../../src/payload/Limits.ts"
import type { MessagePayload } from "../../src/payload/Message.ts"
import { customEmojiTokens, errorFlags, features, type PayloadRuleName, payloadRuleNames, PayloadRules } from "../../src/payload/PayloadRules.ts"
import * as ToDfx from "../../src/payload/ToDfx.ts"
import { MessageId, RoleId, StickerId, UserId } from "../../src/Snowflake.ts"

/**
 * The payload modules' runtime (DESIGN §2.3, §4.7, §4.8 step 1): the features a payload value carries (the mirror
 * of the type-level `Present`, which `test/types/pass/payload.ts` pins for the same samples), the wire request
 * `ToDfx` builds, and the local limit checks in tier 7's order.
 */
const cause = new PreflightDecision({ route: "/channels/{channel.id}/messages", basis: "payload-check" })
const messageId = MessageId.make("123456789012345678")

describe("features (the runtime mirror of PayloadFlags and DegradableFlags)", () => {
  /** One literal sample per rule, each carrying exactly its feature. */
  const samples: { readonly [K in PayloadRuleName]: MessagePayload } = {
    reply: { content: "hi", reply: { messageId } },
    embeds: { embeds: [{ title: "t" }] },
    files: { content: "f", files: [{ name: "a.txt", data: new Uint8Array() }] },
    tts: { content: "hi", tts: true },
    poll: { poll: { question: "q", answers: ["a"], durationHours: 1 } },
    externalSticker: { stickers: [{ origin: "external", id: StickerId.make("123456789012345678") }] },
    externalEmojiInContent: { content: "look <:party:123456789012345678>" },
    mentionsEveryone: { content: "@everyone", mentions: { everyone: true } },
    unmentionableRole: { content: "hi", mentions: { roles: [RoleId.make("123456789012345678")] } }
  }

  it.each(payloadRuleNames)("%s: the sample carries exactly its feature, and its flag follows the rule's mode", (name) => {
    expect(features(samples[name])).toEqual([name])
    const rule = PayloadRules[name]
    expect(errorFlags(features(samples[name]))).toEqual(rule.mode === "error" ? [rule.flag] : [])
  })

  it("treats absent, empty and false fields as no feature, and a guild sticker as none (H-138)", () => {
    expect(features({ content: "hi", embeds: [], files: [], tts: false, stickers: [{ origin: "guild", id: StickerId.make("123456789012345678") }], mentions: { roles: [] } })).toEqual([])
    expect(features({ componentsV2: [textDisplay("x")] })).toEqual([])
    expect(features({ componentsV2: [textDisplay("x")], files: [{ name: "a", data: new Uint8Array() }], reply: { messageId } })).toEqual(["reply", "files"])
  })

  it("finds custom-emoji tokens, animated ones too, for the readback (H-104)", () => {
    expect(customEmojiTokens("a <:x:123> b <a:y:456> c <:not an emoji>")).toEqual(["<:x:123>", "<a:y:456>"])
  })
})

describe("ToDfx", () => {
  it("always sends allowed_mentions with nothing parsed, plus the explicit opt-ins (H-110, H-133)", () => {
    expect(ToDfx.createRequest({ content: "hi" }).request.allowed_mentions).toEqual({ parse: [] })
    const user = UserId.make("123456789012345678")
    const role = RoleId.make("123456789012345679")
    expect(ToDfx.createRequest({ content: "hi", mentions: { users: [user], roles: [role], everyone: true, repliedUser: true } }).request.allowed_mentions).toEqual({
      parse: ["everyone"],
      users: [user],
      roles: [role],
      replied_user: true
    })
    // an edit resends it, so it never falls back to the default allowances (H-111)
    expect(ToDfx.editRequest({ content: "hi" })).toEqual({ allowed_mentions: { parse: [] }, content: "hi" })
  })

  it("builds the flags bitfield: SuppressEmbeds 4, SuppressNotifications 4096, IsComponentsV2 32768", () => {
    expect(ToDfx.createRequest({ content: "hi", suppressEmbeds: true, suppressNotifications: true }).request.flags).toBe(4 | 4096)
    expect(ToDfx.createRequest({ componentsV2: [textDisplay("x")] }).request).toEqual({ allowed_mentions: { parse: [] }, flags: 32768, components: [{ type: 10, content: "x" }] })
    expect(ToDfx.createRequest({ content: "hi" }).request.flags).toBeUndefined()
    expect(ToDfx.editRequest({ suppressEmbeds: false }).flags).toBe(0)
  })

  it("sends tts exactly as the payload has it, and leaves it out when absent (H-102)", () => {
    expect(ToDfx.createRequest({ content: "hi", tts: true }).request).toEqual({ allowed_mentions: { parse: [] }, content: "hi", tts: true })
    expect(ToDfx.createRequest({ content: "hi", tts: false }).request).toEqual({ allowed_mentions: { parse: [] }, content: "hi", tts: false })
    expect("tts" in ToDfx.createRequest({ content: "hi" }).request).toBe(false)
  })

  it("maps embeds, polls, stickers, replies, components and files", () => {
    const customId = CustomId.make("lab:{}")
    const wire = ToDfx.createRequest({
      content: "hi",
      embeds: [{ title: "t", fields: [{ name: "n", value: "v", inline: true }], footer: { text: "f" } }],
      poll: { question: "q", answers: ["a", "b"], durationHours: 2 },
      stickers: [{ origin: "guild", id: StickerId.make("123456789012345678") }],
      reply: { messageId, failIfMissing: false },
      components: [row([linkButton({ label: "L", url: "https://example.com" }), premiumButton({ skuId: "1" }), { kind: "button", style: "danger", label: "D", customId }])],
      files: [{ name: "a.txt", data: new TextEncoder().encode("x"), contentType: "text/plain" }]
    })
    expect(wire.request).toEqual({
      allowed_mentions: { parse: [] },
      message_reference: { message_id: messageId, fail_if_not_exists: false },
      content: "hi",
      embeds: [{ title: "t", fields: [{ name: "n", value: "v", inline: true }], footer: { text: "f" } }],
      sticker_ids: ["123456789012345678"],
      poll: { question: { text: "q" }, answers: [{ poll_media: { text: "a" } }, { poll_media: { text: "b" } }], duration: 2, allow_multiselect: false },
      components: [{ type: 1, components: [{ type: 2, style: 5, label: "L", url: "https://example.com" }, { type: 2, style: 6, sku_id: "1" }, { type: 2, style: 4, label: "D", custom_id: "lab:{}" }] }]
    })
    expect(wire.files.map((file) => [file.name, file.type, file.size])).toEqual([["a.txt", "text/plain", 1]])
    // a reply fails when its target is gone unless it says otherwise (H-109)
    expect(ToDfx.createRequest({ content: "hi", reply: { messageId } }).request.message_reference).toEqual({ message_id: messageId, fail_if_not_exists: true })
  })
})

describe("Limits and the local checks", () => {
  it("counts lengths in Limits.unit", () => {
    expect(Limits.Limits.unit).toBe("code-point")
    expect(Limits.lengthOf("😀😀")).toBe(2)
    expect(Limits.lengthOf("ab")).toBe(2)
  })

  it("passes a create exactly at every limit, and fails each one over, in tier 7's order", () => {
    const max = { content: "a".repeat(Limits.Limits.content), embeds: [{ title: "t".repeat(Limits.Limits.embeds.title) }], poll: { question: "q".repeat(Limits.Limits.poll.question), answers: ["a"], durationHours: 768 } }
    expect(Limits.checkCreate(max, cause)).toEqual([])
    const over = { content: "a".repeat(Limits.Limits.content + 1), embeds: [{ title: "t".repeat(Limits.Limits.embeds.title + 1) }], poll: { question: "q", answers: ["a"], durationHours: 769 } }
    expect(Limits.checkCreate(over, cause).map((failure) => failure._tag)).toEqual(["ContentTooLong", "EmbedTooLarge", "PollTooLarge"])
    expect(Limits.checkCreate({ content: "" }, cause).map((failure) => failure._tag)).toEqual(["MessageEmpty"])
    expect(Limits.checkCreate({ componentsV2: [] }, cause).map((failure) => failure._tag)).toEqual(["MessageEmpty"])
  })

  it("passes an edit exactly at the content and embed limits, and fails each one over, in tier 7's order", () => {
    expect(Limits.checkEdit({ content: "a".repeat(Limits.Limits.content), embeds: [{ title: "t".repeat(Limits.Limits.embeds.title) }] }, cause)).toEqual([])
    const over = Limits.checkEdit({ content: "😀".repeat(Limits.Limits.content + 1), embeds: [{ title: "t".repeat(Limits.Limits.embeds.title + 1) }] }, cause)
    expect(over.map((failure) => failure._tag)).toEqual(["ContentTooLong", "EmbedTooLarge"])
    expect(over[0]).toMatchObject({ length: Limits.Limits.content + 1, limit: Limits.Limits.content })
    // an edit's emptiness is Discord's to decide (the message may keep its attachments)
    expect(Limits.checkEdit({ content: "" }, cause)).toEqual([])
  })

  it("names the embed and poll limit exceeded", () => {
    expect(Limits.embedLimitExceeded(Array.from({ length: 11 }, () => ({ title: "t" })))).toBe("count")
    expect(Limits.embedLimitExceeded([{ fields: Array.from({ length: 26 }, () => ({ name: "n", value: "v" })) }])).toBe("fields")
    expect(Limits.embedLimitExceeded([{ fields: [{ name: "n", value: "v".repeat(1025) }] }])).toBe("fieldValue")
    expect(Limits.embedLimitExceeded([{ description: "d".repeat(4096) }, { description: "d".repeat(2000) }])).toBe("total")
    expect(Limits.pollLimitExceeded({ question: "q", answers: [], durationHours: 1 })).toBe("answerCount")
    expect(Limits.pollLimitExceeded({ question: "q", answers: ["a".repeat(56)], durationHours: 1 })).toBe("answerText")
  })

  it("checks names, topics (4096 on forums), slowmode, nicknames, timeouts and bulk deletes", () => {
    expect(Limits.checkName("", cause).map((failure) => failure._tag)).toEqual(["NameTooLong"])
    expect(Limits.checkName("n".repeat(100), cause)).toEqual([])
    expect(Limits.checkChannelEdit({ name: "n".repeat(101), topic: "t".repeat(1025), slowmodeSeconds: 21601 }, false, cause).map((failure) => failure._tag)).toEqual(["NameTooLong", "TopicTooLong", "SlowmodeOutOfRange"])
    expect(Limits.checkChannelEdit({ topic: "t".repeat(1025) }, true, cause)).toEqual([])
    expect(Limits.checkChannelEdit({ slowmodeSeconds: 1.5 }, false, cause).map((failure) => failure._tag)).toEqual(["SlowmodeOutOfRange"])
    expect(Limits.checkNickname(null, cause)).toEqual([])
    expect(Limits.checkNickname("n".repeat(33), cause).map((failure) => failure._tag)).toEqual(["NicknameTooLong"])
    const now = Date.parse("2026-11-01T12:00:00Z")
    expect(Limits.checkTimeout(new Date(now + 28 * 86_400_000), now, cause)).toEqual([])
    expect(Limits.checkTimeout(new Date(now + 28 * 86_400_000 + 1), now, cause).map((failure) => failure._tag)).toEqual(["TimeoutTooLong"])
    expect(Limits.checkTimeout(null, now, cause)).toEqual([])
    // a snowflake's time is its top 42 bits after Discord's epoch
    const old = MessageId.make(String(BigInt(now - 15 * 86_400_000 - 1_420_070_400_000) << 22n))
    const fresh = MessageId.make(String(BigInt(now - 1_420_070_400_000) << 22n))
    expect(Limits.snowflakeTime(fresh)).toBe(now)
    expect(Limits.checkBulkDelete([fresh, old], now, cause).map((failure) => failure._tag)).toEqual(["MessagesTooOld"])
    expect(Limits.checkBulkDelete(Array.from({ length: 101 }, () => fresh), now, cause).map((failure) => failure._tag)).toEqual(["TooManyMessagesToDelete"])
  })
})
