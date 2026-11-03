// R-ids-distinct (fail side): branded IDs cannot be mixed, and a plain string is no ID (DESIGN §2.1).
import { ChannelId, type UserId } from "../../../src/Snowflake.ts"

declare const takesChannel: (id: ChannelId) => void
declare const user: UserId

// @valid
export const ok = takesChannel(ChannelId.make("123456789012345678"))

// @expect-error TS2345 ChannelId
takesChannel(user)

// @expect-error TS2345 ChannelId
takesChannel("123456789012345678")
