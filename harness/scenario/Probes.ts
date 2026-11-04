/**
 * The rule rows' probes (DESIGN §5.5, §5.8 `raw{probe}`): what each side of a compile-time rule's live pair does.
 * A `typed-*` probe calls the library's public operation (the valid side compiles, and must succeed or apply as
 * the registry expects); a `raw-*` probe sends what the types forbid through `SubjectRaw` (the invalid side, which
 * Discord must refuse or ignore). Execution is `harness/Probes.ts`; this module is the pure description the
 * catalog, Facts and Safety read.
 *
 * Each probe names the operation row it stands for (where its permissions are resolved: a channel, or the guild
 * for member operations), the other lab channels it writes to (cleanup and the next Converge restore them), the
 * channels whose name or topic it may change (H-162: Safety allows one per channel per run), and whom it mentions.
 */
import { Schema } from "effect"
import type { OpName } from "../../src/permissions/Operations.ts"
import type * as LabIds from "../LabIds.ts"
import { commandProbeNames } from "./catalog/commands.ts"
import { sessionNames } from "./catalog/intents.ts"

/** Every probe. */
export const ProbeName = Schema.Literals([
  // text, View and SendMessages
  "typed-send",
  "raw-send-user-id",
  "raw-send-category",
  "raw-embed",
  "raw-file",
  "raw-poll",
  "raw-tts",
  "raw-reply",
  "typed-guild-sticker",
  "raw-unknown-sticker",
  "raw-empty",
  "typed-cv2",
  "raw-cv2-content",
  "typed-mention-user",
  "raw-mention-user",
  "typed-suppress-notifications",
  "raw-ephemeral",
  "raw-edit-suppress-notifications",
  "typed-mention-mentionable",
  "typed-mention-unmentionable",
  "typed-five-links",
  "raw-six-links",
  "typed-select-alone",
  "raw-select-with-button",
  "raw-link-custom-id",
  "raw-premium-unlabelled",
  "raw-premium-labelled",
  "typed-content-max",
  "raw-content-over",
  // text with EmbedLinks and SendPolls
  "typed-embed-max",
  "raw-embed-over",
  "typed-poll-max",
  "raw-poll-over",
  // forum
  "typed-post",
  "raw-send-forum",
  "raw-thread-forum",
  // announcement
  "typed-crosspost",
  "raw-crosspost-text",
  "typed-announcement-thread",
  "raw-private-announcement-thread",
  // a public thread, View and SendMessagesInThreads
  "typed-join",
  "raw-join-text",
  "typed-thread-send",
  "raw-send-parent",
  // text with CreatePublicThreads
  "typed-thread-name-max",
  "raw-thread-voice",
  "raw-thread-name-over",
  // text, the subject's and the harness's messages
  "typed-edit-own",
  "raw-edit-foreign",
  "typed-delete-own",
  "raw-delete-foreign",
  // text with ManageMessages
  "typed-bulk-delete-two",
  "raw-bulk-delete-one",
  // text with PinMessages
  "typed-pin-text",
  "raw-pin-voice",
  // text with ManageChannels
  "typed-topic-max",
  "raw-topic-voice",
  "raw-topic-over",
  "typed-slowmode-max",
  "raw-slowmode-over",
  // members
  "typed-nickname-max",
  "raw-nickname-over",
  "typed-timeout-max",
  "raw-timeout-over",
  // the intent sessions (M7, `catalog/intents.ts`): text, the subject's and the harness's messages
  ...sessionNames,
  // registration and custom_id routes (M8, `catalog/commands.ts`): text, View and SendMessages
  ...commandProbeNames
])
/** A probe. */
export type ProbeName = typeof ProbeName.Type

/** What a probe touches besides the scenario channel. */
export interface ProbeMeta {
  /** The operation row the probe stands for. */
  readonly op: OpName
  /** Other lab channels it posts in or edits (cleaned and restored after it). */
  readonly touches: ReadonlyArray<LabIds.ChannelName>
  /** Lab channels whose name or topic it may change (H-162). */
  readonly renames: ReadonlyArray<LabIds.ChannelName>
  /** Whom it mentions: the target bot, and lab roles (which Rhys must not hold). */
  readonly mentions: { readonly target: boolean; readonly roles: ReadonlyArray<LabIds.RoleName> }
}

const send = (touches: ReadonlyArray<LabIds.ChannelName> = []): ProbeMeta => ({ op: "channel.send", touches, renames: [], mentions: { target: false, roles: [] } })

/**
 * An intent session (M7, `catalog/intents.ts`): resolved on the channel row of its setup (a session reads no
 * permissions), touching `lab-bots-only`, whose slowmode its canary (or trigger) edits. The target mentions only the
 * subject, a bot.
 */
const session: ProbeMeta = send(["lab-bots-only"])

/**
 * A registration or route probe (M8, `catalog/commands.ts`): resolved on the channel row of its setup (registration reads
 * no channel permissions; the route probes send in the scenario channel), touching no other channel.
 */
const command: ProbeMeta = send()

/** Each probe's description. */
export const probes: { readonly [P in ProbeName]: ProbeMeta } = {
  "typed-send": send(),
  "raw-send-user-id": send(),
  "raw-send-category": send(["lab"]),
  "raw-embed": send(),
  "raw-file": send(),
  "raw-poll": send(),
  "raw-tts": send(),
  "raw-reply": send(),
  "typed-guild-sticker": send(),
  "raw-unknown-sticker": send(),
  "raw-empty": send(),
  "typed-cv2": send(),
  "raw-cv2-content": send(),
  "typed-mention-user": { ...send(), mentions: { target: true, roles: [] } },
  "raw-mention-user": { ...send(), mentions: { target: true, roles: [] } },
  "typed-suppress-notifications": send(),
  "raw-ephemeral": send(),
  "raw-edit-suppress-notifications": { ...send(), op: "message.edit.channel" },
  "typed-mention-mentionable": { ...send(), mentions: { target: false, roles: ["lab-mentionable"] } },
  "typed-mention-unmentionable": { ...send(), mentions: { target: false, roles: ["lab-unmentionable"] } },
  "typed-five-links": send(),
  "raw-six-links": send(),
  "typed-select-alone": send(),
  "raw-select-with-button": send(),
  "raw-link-custom-id": send(),
  "raw-premium-unlabelled": send(),
  "raw-premium-labelled": send(),
  "typed-content-max": send(),
  "raw-content-over": send(),
  "typed-embed-max": send(),
  "raw-embed-over": send(),
  "typed-poll-max": send(),
  "raw-poll-over": send(),
  "typed-post": { ...send(), op: "forum.createPost" },
  "raw-send-forum": send(),
  "raw-thread-forum": { ...send(), op: "forum.createPost" },
  "typed-crosspost": { ...send(), op: "message.crosspostOwn" },
  "raw-crosspost-text": { ...send(["lab-text"]), op: "message.crosspostOwn" },
  "typed-announcement-thread": { ...send(), op: "channel.createThread.public" },
  "raw-private-announcement-thread": { ...send(), op: "channel.createThread.private" },
  "typed-join": { ...send(), op: "thread.join" },
  "raw-join-text": { ...send(["lab-text"]), op: "thread.join" },
  "typed-thread-send": { ...send(), op: "thread.send" },
  "raw-send-parent": send(["lab-text"]),
  "typed-thread-name-max": { ...send(), op: "channel.createThread.public" },
  "raw-thread-voice": { ...send(["lab-voice"]), op: "channel.createThread.public" },
  "raw-thread-name-over": { ...send(), op: "channel.createThread.public" },
  "typed-edit-own": { ...send(), op: "message.edit.channel" },
  "raw-edit-foreign": { ...send(), op: "message.edit.channel" },
  "typed-delete-own": { ...send(), op: "message.deleteOwn" },
  "raw-delete-foreign": { ...send(), op: "message.deleteForeign" },
  "typed-bulk-delete-two": { ...send(), op: "channel.bulkDelete" },
  "raw-bulk-delete-one": { ...send(), op: "channel.bulkDelete" },
  "typed-pin-text": { ...send(), op: "message.pin.channel" },
  "raw-pin-voice": { ...send(["lab-voice"]), op: "message.pin.channel" },
  "typed-topic-max": { op: "channel.edit", touches: ["lab-bots-only"], renames: ["lab-bots-only"], mentions: { target: false, roles: [] } },
  "raw-topic-voice": { op: "voice.edit", touches: ["lab-voice"], renames: ["lab-voice"], mentions: { target: false, roles: [] } },
  "raw-topic-over": { op: "channel.edit", touches: ["lab-bots-only"], renames: [], mentions: { target: false, roles: [] } },
  "typed-slowmode-max": { op: "channel.edit", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "raw-slowmode-over": { op: "channel.edit", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "typed-nickname-max": { op: "member.setNickname", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "raw-nickname-over": { op: "member.setNickname", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "typed-timeout-max": { op: "member.timeout", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "raw-timeout-over": { op: "member.timeout", touches: [], renames: [], mentions: { target: false, roles: [] } },
  "session-guild-messages-with": session,
  "session-guild-messages-without": session,
  "session-reactions-with": session,
  "session-reactions-without": session,
  "session-typing-with": session,
  "session-typing-without": session,
  "session-guild-members-with": session,
  "session-guild-members-without": session,
  "session-guilds-with": session,
  "session-guilds-without": session,
  "session-content-with": session,
  "session-content-without": session,
  "session-content-mention": session,
  "session-content-reply": session,
  "session-content-own": session,
  "typed-register-options": command,
  "typed-register-subcommands": command,
  "typed-register-choices": command,
  "typed-sync-identical": command,
  "typed-sync-channel-types": command,
  "typed-sync-choices": command,
  "typed-sync-description": command,
  "typed-sync-name": command,
  "typed-sync-option-name": command,
  "typed-sync-required": command,
  "raw-command-name-upper": command,
  "raw-command-name-space": command,
  "raw-command-name-33": command,
  "raw-subcommand-name-upper": command,
  "raw-subcommand-name-space": command,
  "raw-subcommand-name-33": command,
  "raw-option-name-upper": command,
  "raw-option-name-upper-nested": command,
  "raw-option-order": command,
  "raw-option-order-nested": command,
  "raw-option-count": command,
  "raw-option-count-nested": command,
  "raw-subcommand-count-nested": command,
  "raw-group-in-subcommand": command,
  "raw-group-in-group": command,
  "raw-subcommand-mixed": command,
  "raw-subcommand-mixed-nested": command,
  "raw-choice-wrong-type": command,
  "typed-custom-id-max": command,
  "raw-custom-id-over": command
}
