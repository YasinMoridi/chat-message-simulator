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
export const TypingIndicator = ({ sender, layout, frozenPhaseMs }: TypingIndicatorProps) => {
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
    <div className="flex w-full flex-col items-start gap-1">
      <div
        className={cn(
          "flex items-center gap-1 px-3 py-2.5 shadow-sm",
          bubbleRadius,
        )}
        style={{ backgroundColor: "var(--bubble-received)" }}
        aria-label={`${sender?.name ?? "Someone"} is typing`}
      >
        {TYPING_DOT_BASE_DELAYS_MS.map((baseDelayMs, index) => (
          <span
            key={index}
            className="typing-dot"
            // Inline styles win over the stylesheet's `:nth-child` rule, so
            // when frozen we can pin each dot to an exact, deterministic
            // point in the bounce cycle via a negative animation-delay.
            style={
              isFrozen
                ? {
                    animationDelay: `${baseDelayMs - frozenPhaseMs!}ms`,
                    animationPlayState: "paused",
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  )
}
