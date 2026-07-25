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
  /** Each linkable participant's own (visible) messages, keyed by participantId. */
  subConversations?: Record<string, Message[]>
}

/** Which chat is currently being animated/shown. */
export type ActiveThread = { kind: "main" } | { kind: "sub"; participantId: string }

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
  { soundEnabled = true, selfId, subConversations = {} }: UseConversationPlaybackOptions = {},
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
  // Which chat the preview is currently showing. "main" unless a clickable,
  // linked notification has been tapped (or auto-tapped) and its side-chat
  // is now open.
  const [activeThread, setActiveThread] = useState<ActiveThread>({ kind: "main" })
  const [subRevealCount, setSubRevealCount] = useState(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const keystrokeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Kept fresh via effect below so the resume-after-side-chat continuation
  // (which can fire long after `play()` was originally called) always sees
  // the latest props instead of a stale closure.
  const messagesRef = useRef(messages)
  const selfIdRef = useRef(selfId)
  const subConversationsRef = useRef(subConversations)
  const soundEnabledRef = useRef(soundEnabled)
  useEffect(() => {
    messagesRef.current = messages
    selfIdRef.current = selfId
    subConversationsRef.current = subConversations
    soundEnabledRef.current = soundEnabled
  })

  // Index in the main thread to resume at once a linked side-chat that was
  // opened from it finishes (or scripts a return). Only meaningful while
  // activeThread.kind === "sub".
  const pendingMainResumeIndexRef = useRef(0)

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
  // (or sooner if the next message is due before that) - UNLESS `persist` is
  // set, in which case no auto-hide timer is scheduled at all.
  //
  // `persist` is used for any `notificationClickable` message: those banners
  // must stay up until a real or auto-scripted tap actually happens, which
  // is what calls `dismissBanner` (via `openLinkedConversation`/`stop`).
  // Previously every banner - including clickable ones - was auto-hidden
  // after a fixed timer derived from the message's own `restMs`/`delayMs`,
  // completely unrelated to `notificationAutoOpenDelayMs`. Whenever the
  // scripted auto-open delay (or a slow real click) was longer than that
  // timer, the banner (and `bannerMessage`) got cleared first - which made
  // the auto-tap effect in MainLayout see `bannerVisible === false` and
  // cancel its own pending timeout before it ever fired. That's why a
  // clickable+linked notification froze the preview instead of opening the
  // linked chat: the tap that was supposed to call `openLinkedConversation`
  // simply got cancelled out from under itself.
  const showBanner = (message: Message, holdMs: number, options?: { persist?: boolean }) => {
    clearBannerTimeouts()
    setBannerMessage(message)
    // Mount hidden first, then flip to visible a tick later so the
    // slide-down/fade transition actually plays instead of popping in.
    const raf = requestAnimationFrame(() => setBannerVisible(true))
    bannerTimeoutsRef.current.push(raf as unknown as ReturnType<typeof setTimeout>)

    if (options?.persist) return

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

  // Same as above, but for whichever linked side-chat is currently open: once
  // its scripted autoplay has finished (or if it's just sitting open), keep
  // showing every message it actually has - so messages added, edited, or
  // removed via the LinkedConversationEditor after a notification opened
  // this chat show up immediately instead of staying stuck at the count from
  // whenever the auto-play step loop last touched it.
  useEffect(() => {
    if (isPlaying) return
    if (activeThread.kind !== "sub") return
    const msgs = subConversations[activeThread.participantId] ?? []
    setSubRevealCount(msgs.length)
  }, [isPlaying, activeThread, subConversations])

  const stop = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    setIsPlaying(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(messages.length)
    setActiveThread({ kind: "main" })
    setSubRevealCount(0)
  }

  // Works out how long a message should "type" for and how long to wait
  // after, including the real-keystroke simulation for the current
  // participant's own text messages. Shared by both the main thread and any
  // side-chat, since the logic doesn't depend on which one it's playing.
  const prepareMessageTiming = (message: Message) => {
    const text = message.content
    const isOwnTextMessage =
      message.type === "text" &&
      Boolean(selfIdRef.current) &&
      message.senderId === selfIdRef.current &&
      text.length > 0

    let typingMs: number
    let restMs: number

    if (isOwnTextMessage) {
      const keystrokeDelay = Math.min(
        MAX_KEYSTROKE_MS,
        Math.max(MIN_KEYSTROKE_MS, MAX_OWN_TYPING_MS / text.length),
      )
      typingMs = Math.min(MAX_OWN_TYPING_MS, Math.max(MIN_OWN_TYPING_MS, text.length * keystrokeDelay))
      const totalDelay = message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS
      restMs = Math.max(250, totalDelay - typingMs)
    } else {
      ;({ typingMs, restMs } = computeRevealTiming(message.delayMs))
    }

    return { typingMs, restMs, isOwnTextMessage, text }
  }

  const beginTypingSimulation = (
    message: Message,
    isOwnTextMessage: boolean,
    text: string,
    typingMs: number,
  ) => {
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
  }

  // Runs the main thread starting at `startIndex` - used both by play() and
  // by the "resume after a side-chat closed" continuation.
  const runMainFrom = (startIndex: number) => {
    const step = (index: number) => {
      const msgs = messagesRef.current
      if (index >= msgs.length) {
        setIsPlaying(false)
        setTypingSenderId(null)
        setTypingDraftText(null)
        return
      }

      const message = msgs[index]
      const { typingMs, restMs, isOwnTextMessage, text } = prepareMessageTiming(message)
      beginTypingSimulation(message, isOwnTextMessage, text, typingMs)

      timeoutRef.current = setTimeout(() => {
        clearKeystrokeInterval()
        setTypingSenderId(null)
        setTypingDraftText(null)
        setRevealCount(index + 1)
        if (soundEnabledRef.current && message.type !== "system") {
          playMessageSound()
        }
        if (message.type === "notification") {
          showBanner(message, restMs, { persist: Boolean(message.notificationClickable) })
        }

        // A clickable notification that's linked to a real side-chat pauses
        // the main thread right here - only a tap (real or auto-scripted)
        // moves the story forward from this point.
        const opensLinkedThread =
          message.type === "notification" &&
          Boolean(message.notificationClickable) &&
          Boolean(message.linkedParticipantId)
        if (opensLinkedThread) {
          pendingMainResumeIndexRef.current = index + 1
          return
        }

        timeoutRef.current = setTimeout(() => step(index + 1), restMs)
      }, typingMs)
    }
    step(startIndex)
  }

  const play = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    setIsPlaying(true)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(0)
    setActiveThread({ kind: "main" })
    setSubRevealCount(0)
    runMainFrom(0)
  }

  // Opens the side-chat linked to `participantId` (called once a clickable
  // notification is actually tapped, live or auto-scripted): pauses the
  // main thread and starts playing that participant's own messages instead.
  const openLinkedConversation = (participantId: string) => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    setActiveThread({ kind: "sub", participantId })
    setSubRevealCount(0)

    const step = (index: number) => {
      const msgs = subConversationsRef.current[participantId] ?? []
      if (index >= msgs.length) {
        setIsPlaying(false)
        setTypingSenderId(null)
        setTypingDraftText(null)
        return
      }

      const message = msgs[index]
      const { typingMs, restMs, isOwnTextMessage, text } = prepareMessageTiming(message)
      beginTypingSimulation(message, isOwnTextMessage, text, typingMs)

      timeoutRef.current = setTimeout(() => {
        clearKeystrokeInterval()
        setTypingSenderId(null)
        setTypingDraftText(null)
        setSubRevealCount(index + 1)
        if (soundEnabledRef.current && message.type !== "system") {
          playMessageSound()
        }
        if (message.type === "notification") {
          showBanner(message, restMs, { persist: Boolean(message.notificationClickable) })
        }

        if (message.returnToParent) {
          timeoutRef.current = setTimeout(() => {
            setActiveThread({ kind: "main" })
            setSubRevealCount(0)
            runMainFrom(pendingMainResumeIndexRef.current)
          }, restMs)
          return
        }

        timeoutRef.current = setTimeout(() => step(index + 1), restMs)
      }, typingMs)
    }
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
    /** How many messages (in order) of the MAIN thread should currently be rendered. */
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
    /** Which chat ("main" or a participant's side-chat) is currently active. */
    activeThread,
    /** How many messages of the currently-open side-chat should be rendered. */
    subRevealCount,
    /** Opens (and starts playing) the side-chat linked to a tapped notification. */
    openLinkedConversation,
  }
}
