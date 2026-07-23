import { DEFAULT_MESSAGE_DELAY_MS } from "@/types/message"

/** How much of a message's delay is spent showing the typing indicator vs. waiting silently. */
export const TYPING_SHARE = 0.6
/** Never show the typing dots for less than this long, or longer than this. */
export const MIN_TYPING_MS = 400
export const MAX_TYPING_MS = 2500

/**
 * Splits a message's total delay into "typing dots shown" time and
 * "remaining wait" time. Shared by the live Play button and the video
 * exporter so both feel consistent.
 */
export const computeRevealTiming = (delayMs: number | undefined) => {
  const totalDelay = delayMs ?? DEFAULT_MESSAGE_DELAY_MS
  const typingMs = Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, totalDelay * TYPING_SHARE))
  const restMs = Math.max(0, totalDelay - typingMs)
  return { typingMs, restMs }
}
