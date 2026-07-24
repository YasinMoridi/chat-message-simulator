import { useEffect, useRef, useState } from "react"
import type { Message } from "@/types/message"
import { DEFAULT_MESSAGE_DELAY_MS } from "@/types/message"
import { computeRevealTiming } from "@/utils/messageTiming"
import { playMessageSound } from "@/utils/sound"

interface UseConversationPlaybackOptions {
  /** Play the little "pop" sound whenever a new message is revealed. */
  soundEnabled?: boolean
  /**
   * The participant treated as "you". When the message about to be revealed
   * belongs to this participant, we simulate real on-device typing (letters
   * appearing progressively in the message input) instead of the generic
   * "..." dots bubble used for everyone else.
   */
  selfId?: string
}

/** How long the notification banner stays up before it slides away. */
const BANNER_HOLD_MS = 2600
/** Must match the transition duration used in NotificationBanner.tsx. */
const BANNER_EXIT_MS = 300
/** Never wait less than this between two simulated keystrokes, however long the text is. */
const MIN_KEYSTROKE_MS = 20
/** Never wait more than this between two simulated keystrokes, however short the text is. */
const MAX_KEYSTROKE_MS = 70
/** A single-character own message still gets at least this much "typing" time. */
const MIN_OWN_TYPING_MS = 500
/**
 * However long the message is, the simulated typing never runs past this -
 * long pastes still finish in a reasonable time instead of dragging on.
 */
const MAX_OWN_TYPING_MS = 6000

export const useConversationPlayback = (
  messages: Message[],
  { soundEnabled = true, selfId }: UseConversationPlaybackOptions = {},
) => {
  const [revealCount, setRevealCount] = useState(messages.length)
  const [typingSenderId, setTypingSenderId] = useState<string | null>(null)
  // Progressively revealed text for the message currently being "typed" by
  // `selfId`, mimicking real keystrokes landing in the phone's own input
  // field. Null whenever nobody is composing an own text message right now.
  const [typingDraftText, setTypingDraftText] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [bannerMessage, setBannerMessage] = useState<Message | null>(null)
  const [bannerVisible, setBannerVisible] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const keystrokeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }

  const clearKeystrokeInterval = () => {
    if (keystrokeIntervalRef.current) {
      clearInterval(keystrokeIntervalRef.current)
      keystrokeIntervalRef.current = null
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
    clearKeystrokeInterval()
    dismissBanner()
    setIsPlaying(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(messages.length)
  }

  const play = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    setIsPlaying(true)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(0)

    const step = (index: number) => {
      if (index >= messages.length) {
        setIsPlaying(false)
        setTypingSenderId(null)
        setTypingDraftText(null)
        return
      }

      const message = messages[index]

      // For the "self" participant's own text messages, simulate the actual
      // keystrokes landing in the message input instead of a dots bubble -
      // it reads much more like someone really typing on their phone. The
      // typing duration scales with the text length (capped) instead of
      // reusing the generic dots-bubble timing budget, which was capped at
      // MAX_TYPING_MS regardless of length and cut long/multi-line messages
      // off mid-sentence before "sending" them.
      const text = message.content
      const isOwnTextMessage =
        message.type === "text" && Boolean(selfId) && message.senderId === selfId && text.length > 0

      let typingMs: number
      let restMs: number

      if (isOwnTextMessage) {
        const keystrokeDelay = Math.min(
          MAX_KEYSTROKE_MS,
          Math.max(MIN_KEYSTROKE_MS, MAX_OWN_TYPING_MS / text.length),
        )
        typingMs = Math.min(
          MAX_OWN_TYPING_MS,
          Math.max(MIN_OWN_TYPING_MS, text.length * keystrokeDelay),
        )
        const totalDelay = message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS
        // Keep whatever pause the author configured, on top of typing -
        // but never let it look like the message sent itself instantly.
        restMs = Math.max(250, totalDelay - typingMs)
      } else {
        ;({ typingMs, restMs } = computeRevealTiming(message.delayMs))
      }

      // Show typing dots for whoever is about to send the next message,
      // including your own outgoing messages (rendered on the right side).
      // Notification entries aren't "typed" - they just pop in.
      if (message.type !== "system" && message.type !== "notification") {
        setTypingSenderId(message.senderId)
      }

      if (isOwnTextMessage) {
        setTypingDraftText("")
        let charIndex = 0
        const keystrokeDelay = typingMs / text.length
        clearKeystrokeInterval()
        keystrokeIntervalRef.current = setInterval(() => {
          charIndex += 1
          setTypingDraftText(text.slice(0, charIndex))
          if (charIndex >= text.length) {
            clearKeystrokeInterval()
          }
        }, keystrokeDelay)
      } else {
        setTypingDraftText(null)
      }

      timeoutRef.current = setTimeout(() => {
        clearKeystrokeInterval()
        setTypingSenderId(null)
        setTypingDraftText(null)
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
      clearKeystrokeInterval()
      clearBannerTimeouts()
    },
    [],
  )

  return {
    /** How many messages (in order) should currently be rendered. */
    revealCount,
    /** senderId of whoever is "typing" right now, or null. */
    typingSenderId,
    /**
     * The progressively revealed text for `selfId`'s own message currently
     * being simulated as real keystrokes, or null when that's not happening
     * right now (e.g. someone else is typing, or the current entry isn't an
     * own text message).
     */
    typingDraftText,
    isPlaying,
    play,
    stop,
    /** The message the notification banner is currently showing, if any. */
    bannerMessage,
    /** Whether the banner should be in its "shown" (vs sliding out) state. */
    bannerVisible,
  }
}
