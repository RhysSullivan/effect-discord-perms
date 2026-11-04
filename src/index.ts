/**
 * effect-discord-perms: a typed layer over dfx in which every way a Discord call can fail is a named, categorised
 * error, and the compiler catches missing permissions, payload rules and wrong IDs (DESIGN.md).
 *
 * The types guarantee that every failure is handled. They do not guarantee that any call succeeds: Discord owns
 * the permission state, and it can change between a check and a request.
 *
 * This barrel is the public API. Internal modules (the bot build's `BotInternals`, the handle constructors, the
 * harness's seams) are not exported. `CustomId` is exported as a type only: a `custom_id` is built by a
 * `ComponentRoute` (§2.9), never by its schema's `make`.
 */
export * from "./Snowflake.ts"
export * from "./errors/index.ts"
export { Bot, BotRuntime, type BotConfig, type Runtime } from "./bot/Bot.ts"
export type { Handled, UnhandledErrors } from "./bot/Handler.ts"
export { StartupFailed } from "./bot/Startup.ts"
export { EventIntents, type EventName, type Intent, Intents, type IntentCheck, type MissingIntent } from "./gateway/Intents.ts"
export {
  type ChannelUpdate,
  type ContentUnavailable,
  contentUnavailable,
  type Delivered,
  type DirectMessage,
  type DirectMessageCreate,
  type EventPayloads,
  type GuildMessageCreate,
  type MemberUpdate,
  type MessageCreate,
  type ReactionAdd,
  type ReactionEmoji,
  type Ready,
  type ReceivedMessage,
  type TypingStart,
  type Undelivered
} from "./gateway/Events.ts"
export type { Transient, OpErrors, OpName, OpFlags, OpTags, OpPermissionErrors } from "./permissions/Operations.ts"
export type {
  AnnouncementChannel,
  AnnouncementThread,
  Basis,
  CategoryChannel,
  ChannelKinds,
  ChannelPatch,
  DMChannel,
  ForumChannel,
  GuildChannel,
  GuildChannelKind,
  GuildMessageKind,
  MediaChannel,
  MessageChannel,
  MessageKind,
  PinsList,
  PrivateThread,
  PublicThread,
  SendMethod,
  Sent,
  SentDegradable,
  StageChannel,
  TextChannel,
  ThreadChannel,
  ThreadKind,
  VoiceChannel,
  WithGranted
} from "./channels/Channel.ts"
export { isMessageChannel } from "./channels/Channel.ts"
export type { AnyMessage, ForeignMessage, ForeignMessages, OwnMessage, OwnMessages } from "./channels/Message.ts"
export { Channels } from "./channels/Ops.ts"
export { type GuildMember, Members } from "./members/Member.ts"
export { Permissions } from "./permissions/Require.ts"
export type { CreateMessage, CreateMessageV2, EditMessage, Embed, Emoji, FileUpload, Mentions, MessagePayload, Poll, ReplyTo, StickerRef } from "./payload/Message.ts"
export {
  type ActionRow,
  type Button,
  type CustomId,
  type InteractiveButton,
  type Invalid,
  type LinkButton,
  linkButton,
  type PremiumButton,
  premiumButton,
  row,
  type StringSelect,
  textDisplay,
  type V2Component
} from "./payload/Components.ts"
export { Limits } from "./payload/Limits.ts"
export { ComponentRoute } from "./components/CustomId.ts"
export {
  type AnyChatInputCommand,
  type BooleanOption,
  type ChannelOption,
  type ChatInputCommand,
  type CheckedSubs,
  type CheckName,
  Command,
  type CommandDefinition,
  type GroupDef,
  type IntegerOption,
  type InvocationOf,
  type NumberOption,
  type OptionLike,
  type OptionsOf,
  type Ordered,
  type ResolvedRole,
  type ResolvedUser,
  type RoleOption,
  type StringOption,
  type SubcommandDef,
  type SubsInvocation,
  type UserOption,
  type ValueOption
} from "./commands/Command.ts"
export { DiscordApiConfig } from "./rest/DiscordApi.ts"
