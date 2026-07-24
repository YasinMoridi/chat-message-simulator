import type { Participant } from "@/types/conversation"
import type { LayoutConfig } from "@/types/layout"
import { cn } from "@/utils/cn"

interface TypingIndicatorProps {
  sender: Participant | undefined
  layout: LayoutConfig
  /**
   * When set, freezes the dot animation at this exact point (in ms) in its
   * cycle instead of letting it run live. Video export needs this: every
   * captured frame is rendered from a brand-new DOM clone, whose CSS
   * animation clock restarts from zero the instant it's attached - so
   * without this, every snapshot lands on the same opening instant of the
   * animation and the dots look frozen in the exported video.
   */
  frozenPhaseMs?: number
  /** True when the "self" participant is the one typing - aligns the bubble right. */
  isOwn?: boolean
}

/** Matches the `1.2s` duration on `@keyframes typing-bounce` in index.css. */
export const TYPING_ANIMATION_CYCLE_MS = 1200
/** Matches the per-dot `animation-delay` values set via `:nth-child` in index.css. */
export const TYPING_DOT_BASE_DELAYS_MS = [0, 150, 300]

/**
 * Animated "..." bubble shown briefly before a message appears, mimicking the
 * native typing indicator of chat apps. Reuses the same bubble radius/shadow
 * rules as MessageBubble so it blends into every layout.
 */
export const TypingIndicator = ({ sender, layout, frozenPhaseMs, isOwn }: TypingIndicatorProps) => {
  const isWhatsApp = layout.id === "whatsapp"
  const isIMessage = layout.id === "imessage"
  const isMessenger = layout.id === "messenger"
  const isInstagram = layout.id === "instagram"
  const isTinder = layout.id === "tinder"

  const bubbleRadius = isWhatsApp
    ? "rounded-[16px]"
    : isIMessage
      ? "rounded-[18px]"
      : isMessenger
        ? "rounded-[20px]"
        : isInstagram
          ? "rounded-[20px]"
          : isTinder
            ? "rounded-[22px]"
            : "rounded-2xl"

  const isFrozen = frozenPhaseMs !== undefined

  return (
    <div className={cn("flex w-full flex-col gap-1", isOwn ? "items-end" : "items-start")}>
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-2.5 shadow-sm",
          bubbleRadius,
        )}
        style={{ backgroundColor: isOwn ? "var(--bubble-sent)" : "var(--bubble-received)" }}
        aria-label={isOwn ? "You are typing" : `${sender?.name ?? "Someone"} is typing`}
      >
        {TYPING_DOT_BASE_DELAYS_MS.map((baseDelayMs, index) => (
          <span
            key={index}
            className="typing-dot"
            // Inline styles win over the stylesheet's `:nth-child` rule, so
            // when frozen we can pin each dot to an exact, deterministic
            // point in the bounce cycle via a negative animation-delay. We
            // also override the dot color on the "own" bubble since it's
            // often a saturated color (WhatsApp green, iMessage blue, etc.)
            // where the default muted-gray dot wouldn't have enough contrast.
            style={{
              ...(isOwn ? { backgroundColor: "var(--bubble-sent-text)", opacity: 0.6 } : {}),
              ...(isFrozen
                ? {
                    animationDelay: `${baseDelayMs - frozenPhaseMs!}ms`,
                    animationPlayState: "paused",
                  }
                : {}),
            }}
          />
        ))}
      </div>
    </div>
  )
}
