/**
 * Library internals the harness needs and the public barrel never exports (DESIGN §1.2, §4.2).
 *
 * `SubjectRaw` is the subject's raw dfx REST client, for matrix step (c): the call made with no check at all.
 * It must come from the **same** build as the library's runtime, so step (c) shares the subject's token, HTTP
 * client and rate-limit store with the library's own operations. M3 provides it from `BotInternals.layerWith`
 * together with `BotRuntime`; until then (M2) the harness provides it as a REST-only identity like
 * `HarnessRest` and `TargetRest` (`harness/Identities.ts`).
 */
import type { DiscordRestService } from "dfx/DiscordREST"
import { Context } from "effect"

/** The subject's raw dfx REST client (internal; harness only). */
export class SubjectRaw extends Context.Service<SubjectRaw, DiscordRestService>()("internal/SubjectRaw") {}
