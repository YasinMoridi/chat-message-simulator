import { useEffect, useRef, useState } from "react"
import type { Message } from "@/types/message"
import { computeRevealTiming } from "@/utils/messageTiming"
import { playMessageSound } from "@/utils/sound"

interface UseConversationPlaybackOptions {
  /** Play the little "pop" sound whenever a new message is revealed. */
  soundEnabled?: boolean
}

/** How long the notification banner stays up before it slides away. */
const BANNER_HOLD_MS = 2600
/** Must match the transition duration used in NotificationBanner.tsx. */
const BANNER_EXIT_MS = 300

export const useConversationPlayback = (
  messages: Message[],
  { soundEnabled = true }: UseConversationPlaybackOptions = {},
) => {
  const [revealCount, setRevealCount] = useState(messages.length)
  const [typingSenderId, setTypingSenderId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [bannerMessage, setBannerMessage] = useState<Message | null>(null)
  const [bannerVisible, setBannerVisible] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  const clearBannerTimeouts = () => {
    bannerTimeoutsRef.current.forEach((id) => clearTimeout(id))
    bannerTimeoutsRef.current = []
  }

  const dismissBanner = () => {
    clearBannerTimeouts()
    setBannerVisible(false)
    setBannerMessage(null)
  }

  // Slides the banner in for `message`, then back out after BANNER_HOLD_MS
  // (or sooner if the next message is due before that).
  const showBanner = (message: Message, holdMs: number) => {
    clearBannerTimeouts()
    setBannerMessage(message)
    // Mount hidden first, then flip to visible a tick later so the
    // slide-down/fade transition actually plays instead of popping in.
    const raf = requestAnimationFrame(() => setBannerVisible(true))
    bannerTimeoutsRef.current.push(raf as unknown as ReturnType<typeof setTimeout>)

    const hideAfter = Math.max(600, Math.min(holdMs, BANNER_HOLD_MS))
    const hideTimeout = setTimeout(() => {
      setBannerVisible(false)
      const clearTimeoutId = setTimeout(() => setBannerMessage(null), BANNER_EXIT_MS)
      bannerTimeoutsRef.current.push(clearTimeoutId)
    }, hideAfter)
    bannerTimeoutsRef.current.push(hideTimeout)
  }

  // Keep everything visible by default (e.g. while editing in the builder).
  useEffect(() => {
    if (!isPlaying) {
      setRevealCount(messages.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  const stop = () => {
    clearPendingTimeout()
    dismissBanner()
    setIsPlaying(false)
    setTypingSenderId(null)
    setRevealCount(messages.length)
  }

  const play = () => {
    clearPendingTimeout()
    dismissBanner()
    setIsPlaying(true)
    setTypingSenderId(null)
    setRevealCount(0)

    const step = (index: number) => {
      if (index >= messages.length) {
        setIsPlaying(false)
        setTypingSenderId(null)
        return
      }

      const message = messages[index]
      const { typingMs, restMs } = computeRevealTiming(message.delayMs)

      // Show typing dots for whoever is about to send the next message,
      // including your own outgoing messages (rendered on the right side).
      // Notification entries aren't "typed" - they just pop in.
      if (message.type !== "system" && message.type !== "notification") {
        setTypingSenderId(message.senderId)
      }

      timeoutRef.current = setTimeout(() => {
        setTypingSenderId(null)
        setRevealCount(index + 1)
        if (soundEnabled && message.type !== "system") {
          playMessageSound()
        }
        // Only entries explicitly authored as "Notification" trigger the
        // OS-style banner - regular chat messages never do.
        if (message.type === "notification") {
          showBanner(message, restMs)
        }

        timeoutRef.current = setTimeout(() => step(index + 1), restMs)
      }, typingMs)
    }

    // Kick off with the first message's own delay before it appears.
    step(0)
  }

  useEffect(
    () => () => {
      clearPendingTimeout()
      clearBannerTimeouts()
    },
    [],
  )

  return {
    /** How many messages (in order) should currently be rendered. */
    revealCount,
    /** senderId of whoever is "typing" right now, or null. */
    typingSenderId,
    isPlaying,
    play,
    stop,
    /** The message the notification banner is currently showing, if any. */
    bannerMessage,
    /** Whether the banner should be in its "shown" (vs sliding out) state. */
    bannerVisible,
  }
}
