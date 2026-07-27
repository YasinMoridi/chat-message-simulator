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

/** A single point in the playback timeline - used to step back/forward. */
interface HistorySnapshot {
  thread: ActiveThread
  revealCount: number
  subRevealCount: number
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

// Info about whichever timer-driven phase (typing or resting) is currently
// scheduled, kept fresh so pause() can work out how much time is left in it.
interface RunningPhase {
  type: "typing" | "resting"
  thread: ActiveThread
  index: number
  message: Message
  isOwnTextMessage: boolean
  text: string
  typingMs: number
  restMs: number
  isReturn: boolean
  startedAt: number
}

// Same shape, but frozen while paused (remainingMs replaces "how much time
// has passed since startedAt" with "how much is left in this phase").
interface PausedPhase extends Omit<RunningPhase, "startedAt"> {
  remainingMs: number
}

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
  // True while a play session is active but timers are frozen - either the
  // user hit "pause", or they stepped back/forward manually. Only
  // meaningful while isPlaying is true.
  const [isPaused, setIsPaused] = useState(false)
  const [bannerMessage, setBannerMessage] = useState<Message | null>(null)
  const [bannerVisible, setBannerVisible] = useState(false)
  // Which chat the preview is currently showing. "main" unless a clickable,
  // linked notification has been tapped (or auto-tapped) and its side-chat
  // is now open.
  const [activeThread, setActiveThread] = useState<ActiveThread>({ kind: "main" })
  const [subRevealCount, setSubRevealCount] = useState(0)
  // Mirrors historyRef/historyIndexRef purely so the UI can enable/disable
  // the step back/forward buttons - the refs below are the source of truth.
  const [stepState, setStepState] = useState({ canStepBack: false, canStepForward: false })
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

  // Whichever timer-driven phase is currently ticking down (or null when
  // nothing is scheduled, e.g. waiting for a notification tap).
  const runningPhaseRef = useRef<RunningPhase | null>(null)
  // Snapshot of the phase that was interrupted by pause(), so resume() can
  // pick it back up with the correct remaining time.
  const pausedPhaseRef = useRef<PausedPhase | null>(null)
  // When the banner's own auto-hide timer is running, its start time + full
  // hold duration - so pausing can freeze it too instead of letting it
  // slide away while the rest of the preview is frozen.
  const bannerHoldRef = useRef<{ startedAt: number; holdMs: number } | null>(null)
  const pausedBannerRemainingRef = useRef<number | null>(null)

  // Every revealed message pushes a snapshot here. Stepping back/forward
  // just walks this list instead of trying to re-derive "what was on screen
  // two moves ago", which would be ambiguous once side-chats are involved.
  const historyRef = useRef<HistorySnapshot[]>([{ thread: { kind: "main" }, revealCount: 0, subRevealCount: 0 }])
  const historyIndexRef = useRef(0)

  const syncStepState = () => {
    setStepState({
      canStepBack: historyIndexRef.current > 0,
      canStepForward: historyIndexRef.current < historyRef.current.length - 1,
    })
  }

  const pushHistory = (snapshot: HistorySnapshot) => {
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1)
    historyRef.current.push(snapshot)
    historyIndexRef.current = historyRef.current.length - 1
    syncStepState()
  }

  const resetHistory = (snapshot: HistorySnapshot) => {
    historyRef.current = [snapshot]
    historyIndexRef.current = 0
    syncStepState()
  }

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
    bannerHoldRef.current = null
    setBannerVisible(false)
    setBannerMessage(null)
  }

  // Slides the banner in for `message`, then back out after BANNER_HOLD_MS
  // (or sooner if the next message is due before that) - UNLESS `persist` is
  // set, in which case no auto-hide timer is scheduled at all.
  const showBanner = (message: Message, holdMs: number, options?: { persist?: boolean }) => {
    clearBannerTimeouts()
    bannerHoldRef.current = null
    setBannerMessage(message)
    const raf = requestAnimationFrame(() => setBannerVisible(true))
    bannerTimeoutsRef.current.push(raf as unknown as ReturnType<typeof setTimeout>)

    if (options?.persist) return

    const hideAfter = Math.max(600, Math.min(holdMs, BANNER_HOLD_MS))
    bannerHoldRef.current = { startedAt: Date.now(), holdMs: hideAfter }
    const hideTimeout = setTimeout(() => {
      bannerHoldRef.current = null
      setBannerVisible(false)
      const clearTimeoutId = setTimeout(() => setBannerMessage(null), BANNER_EXIT_MS)
      bannerTimeoutsRef.current.push(clearTimeoutId)
    }, hideAfter)
    bannerTimeoutsRef.current.push(hideTimeout)
  }

  // Restarts the banner's own auto-hide countdown for `remainingMs` more -
  // used when resume() picks a paused banner back up.
  const rescheduleBannerHide = (remainingMs: number) => {
    bannerHoldRef.current = { startedAt: Date.now(), holdMs: remainingMs }
    const hideTimeout = setTimeout(() => {
      bannerHoldRef.current = null
      setBannerVisible(false)
      const clearTimeoutId = setTimeout(() => setBannerMessage(null), BANNER_EXIT_MS)
      bannerTimeoutsRef.current.push(clearTimeoutId)
    }, remainingMs)
    bannerTimeoutsRef.current.push(hideTimeout)
  }

  // Keep everything visible by default (e.g. while editing in the builder).
  useEffect(() => {
    if (!isPlaying) {
      setRevealCount(messages.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length])

  // Same as above, but for whichever linked side-chat is currently open.
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
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(messages.length)
    setActiveThread({ kind: "main" })
    setSubRevealCount(0)
    resetHistory({ thread: { kind: "main" }, revealCount: 0, subRevealCount: 0 })
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

  // `startFromChar` lets resume() continue an own-text typing animation
  // partway through instead of restarting it from the first letter.
  const beginTypingSimulation = (
    message: Message,
    isOwnTextMessage: boolean,
    text: string,
    typingMs: number,
    startFromChar = 0,
  ) => {
    if (message.type !== "system" && message.type !== "notification") {
      setTypingSenderId(message.senderId)
    }
    if (isOwnTextMessage) {
      const remainingChars = text.length - startFromChar
      if (remainingChars <= 0 || typingMs <= 0) {
        setTypingDraftText(text)
        return
      }
      setTypingDraftText(text.slice(0, startFromChar))
      let charIndex = startFromChar
      const keystrokeDelay = typingMs / remainingChars
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

  // Applies the visible effects of a message becoming revealed - bumping the
  // right reveal counter, playing the pop sound, showing a banner if it's a
  // notification, and recording a history snapshot for step back/forward.
  const applyReveal = (thread: ActiveThread, index: number, message: Message, restMs: number) => {
    const newRevealCount = thread.kind === "main" ? index + 1 : revealCount
    const newSubRevealCount = thread.kind === "sub" ? index + 1 : 0
    if (thread.kind === "main") {
      setRevealCount(newRevealCount)
    } else {
      setSubRevealCount(newSubRevealCount)
    }
    if (soundEnabledRef.current && message.type !== "system") {
      playMessageSound()
    }
    if (message.type === "notification") {
      showBanner(message, restMs, { persist: Boolean(message.notificationClickable) })
    }
    pushHistory({ thread, revealCount: newRevealCount, subRevealCount: newSubRevealCount })
  }

  const advance = (thread: ActiveThread, index: number) => {
    const msgs = thread.kind === "main" ? messagesRef.current : subConversationsRef.current[thread.participantId] ?? []
    if (index >= msgs.length) {
      setIsPlaying(false)
      setIsPaused(false)
      setTypingSenderId(null)
      setTypingDraftText(null)
      runningPhaseRef.current = null
      return
    }
    startTypingPhase(thread, index, msgs[index])
  }

  const startTypingPhase = (thread: ActiveThread, index: number, message: Message) => {
    const { typingMs, restMs, isOwnTextMessage, text } = prepareMessageTiming(message)
    beginTypingSimulation(message, isOwnTextMessage, text, typingMs)
    runningPhaseRef.current = {
      type: "typing",
      thread,
      index,
      message,
      isOwnTextMessage,
      text,
      typingMs,
      restMs,
      isReturn: false,
      startedAt: Date.now(),
    }
    timeoutRef.current = setTimeout(() => finishTypingPhase(thread, index, message, restMs), typingMs)
  }

  const finishTypingPhase = (thread: ActiveThread, index: number, message: Message, restMs: number) => {
    clearKeystrokeInterval()
    setTypingSenderId(null)
    setTypingDraftText(null)
    applyReveal(thread, index, message, restMs)

    // A clickable notification that's linked to a real side-chat pauses the
    // main thread right here - only a tap (real or auto-scripted) moves the
    // story forward from this point.
    const opensLinkedThread =
      thread.kind === "main" &&
      message.type === "notification" &&
      Boolean(message.notificationClickable) &&
      Boolean(message.linkedParticipantId)
    if (opensLinkedThread) {
      pendingMainResumeIndexRef.current = index + 1
      runningPhaseRef.current = null
      return
    }

    const isReturn = thread.kind === "sub" && Boolean(message.returnToParent)
    startRestingPhase(thread, index, message, restMs, isReturn)
  }

  const startRestingPhase = (
    thread: ActiveThread,
    index: number,
    message: Message,
    restMs: number,
    isReturn: boolean,
  ) => {
    runningPhaseRef.current = {
      type: "resting",
      thread,
      index,
      message,
      isOwnTextMessage: false,
      text: "",
      typingMs: 0,
      restMs,
      isReturn,
      startedAt: Date.now(),
    }
    timeoutRef.current = setTimeout(() => {
      if (isReturn) {
        setActiveThread({ kind: "main" })
        setSubRevealCount(0)
        runningPhaseRef.current = null
        advance({ kind: "main" }, pendingMainResumeIndexRef.current)
      } else {
        advance(thread, index + 1)
      }
    }, restMs)
  }

  const play = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setIsPlaying(true)
    setIsPaused(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    setRevealCount(0)
    setActiveThread({ kind: "main" })
    setSubRevealCount(0)
    resetHistory({ thread: { kind: "main" }, revealCount: 0, subRevealCount: 0 })
    advance({ kind: "main" }, 0)
  }

  // Freezes playback exactly where it is - the current message stays
  // partially "typed", the banner stays up, nothing advances - until
  // resume() is called.
  const pause = () => {
    if (!isPlaying || isPaused) return
    clearPendingTimeout()
    clearKeystrokeInterval()
    const phase = runningPhaseRef.current
    if (phase) {
      const elapsed = Date.now() - phase.startedAt
      const duration = phase.type === "typing" ? phase.typingMs : phase.restMs
      const remainingMs = Math.max(0, duration - elapsed)
      pausedPhaseRef.current = { ...phase, remainingMs }
    } else {
      pausedPhaseRef.current = null
    }
    if (bannerHoldRef.current) {
      const elapsed = Date.now() - bannerHoldRef.current.startedAt
      pausedBannerRemainingRef.current = Math.max(0, bannerHoldRef.current.holdMs - elapsed)
      bannerHoldRef.current = null
      clearBannerTimeouts()
    } else {
      pausedBannerRemainingRef.current = null
    }
    runningPhaseRef.current = null
    setIsPaused(true)
  }

  // Picks up exactly where pause() left off - or, if the user stepped
  // back/forward manually in the meantime (so there's no remembered phase),
  // simply keeps playing forward from wherever the preview is now sitting.
  const resume = () => {
    if (!isPlaying || !isPaused) return
    setIsPaused(false)

    if (pausedBannerRemainingRef.current != null) {
      rescheduleBannerHide(pausedBannerRemainingRef.current)
      pausedBannerRemainingRef.current = null
    }

    const phase = pausedPhaseRef.current
    pausedPhaseRef.current = null

    if (phase) {
      if (phase.type === "typing") {
        // How far through the original typing duration we already were,
        // so an own-text message resumes its keystrokes instead of
        // retyping the whole thing.
        const fractionElapsed = phase.typingMs > 0 ? 1 - phase.remainingMs / phase.typingMs : 1
        const startFromChar = phase.isOwnTextMessage
          ? Math.min(phase.text.length, Math.floor(fractionElapsed * phase.text.length))
          : 0
        runningPhaseRef.current = { ...phase, typingMs: phase.remainingMs, startedAt: Date.now() }
        beginTypingSimulation(phase.message, phase.isOwnTextMessage, phase.text, phase.remainingMs, startFromChar)
        timeoutRef.current = setTimeout(
          () => finishTypingPhase(phase.thread, phase.index, phase.message, phase.restMs),
          Math.max(0, phase.remainingMs),
        )
      } else {
        runningPhaseRef.current = { ...phase, restMs: phase.remainingMs, startedAt: Date.now() }
        timeoutRef.current = setTimeout(() => {
          if (phase.isReturn) {
            setActiveThread({ kind: "main" })
            setSubRevealCount(0)
            runningPhaseRef.current = null
            advance({ kind: "main" }, pendingMainResumeIndexRef.current)
          } else {
            advance(phase.thread, phase.index + 1)
          }
        }, Math.max(0, phase.remainingMs))
      }
      return
    }

    // Nothing was mid-flight (e.g. the user had stepped manually, or
    // playback was sitting idle waiting for a notification tap) - just
    // keep going forward from the current position.
    const idx = activeThread.kind === "main" ? revealCount : subRevealCount
    advance(activeThread, idx)
  }

  const freezeForManualStep = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setTypingSenderId(null)
    setTypingDraftText(null)
    setIsPlaying(true)
    setIsPaused(true)
  }

  // Shared by the cold-start and warm cases of stepForward(): instantly
  // reveals message `index` of `thread` and applies whatever branch it
  // triggers (opening a linked side-chat, or returning from one).
  const revealNextLive = (thread: ActiveThread, index: number) => {
    const msgs = thread.kind === "main" ? messagesRef.current : subConversationsRef.current[thread.participantId] ?? []
    if (index >= msgs.length) {
      setIsPlaying(false)
      setIsPaused(false)
      return
    }
    const message = msgs[index]
    const { restMs } = prepareMessageTiming(message)
    applyReveal(thread, index, message, restMs)

    if (
      thread.kind === "main" &&
      message.type === "notification" &&
      message.notificationClickable &&
      message.linkedParticipantId
    ) {
      const participantId = message.linkedParticipantId
      pendingMainResumeIndexRef.current = index + 1
      dismissBanner()
      setActiveThread({ kind: "sub", participantId })
      setSubRevealCount(0)
      pushHistory({ thread: { kind: "sub", participantId }, revealCount: index + 1, subRevealCount: 0 })
      return
    }
    if (thread.kind === "sub" && message.returnToParent) {
      setActiveThread({ kind: "main" })
      setSubRevealCount(0)
      pushHistory({ thread: { kind: "main" }, revealCount: pendingMainResumeIndexRef.current, subRevealCount: 0 })
    }
  }

  // Reveals exactly one more message (no typing animation, no waiting) and
  // freezes there - like stepping a video forward one frame.
  const stepForward = () => {
    // If we've stepped back earlier, just replay the remembered future
    // state instead of recomputing it.
    if (historyIndexRef.current < historyRef.current.length - 1) {
      freezeForManualStep()
      historyIndexRef.current += 1
      const snap = historyRef.current[historyIndexRef.current]
      syncStepState()
      setActiveThread(snap.thread)
      setRevealCount(snap.revealCount)
      setSubRevealCount(snap.subRevealCount)
      return
    }

    // Cold start - nothing has played yet.
    if (!isPlaying) {
      freezeForManualStep()
      setRevealCount(0)
      setActiveThread({ kind: "main" })
      setSubRevealCount(0)
      resetHistory({ thread: { kind: "main" }, revealCount: 0, subRevealCount: 0 })
      dismissBanner()
      revealNextLive({ kind: "main" }, 0)
      return
    }

    freezeForManualStep()
    const thread = activeThread
    const idx = thread.kind === "main" ? revealCount : subRevealCount
    revealNextLive(thread, idx)
  }

  // Hides the most recently revealed message and freezes there - like
  // stepping a video backward one frame. Walks the recorded history so
  // side-chat boundaries are undone correctly instead of guessed at.
  const stepBack = () => {
    if (historyIndexRef.current <= 0) return
    freezeForManualStep()
    dismissBanner()
    historyIndexRef.current -= 1
    const snap = historyRef.current[historyIndexRef.current]
    syncStepState()
    setActiveThread(snap.thread)
    setRevealCount(snap.revealCount)
    setSubRevealCount(snap.subRevealCount)
  }

  // Opens the side-chat linked to `participantId` (called once a clickable
  // notification is actually tapped, live or auto-scripted): pauses the
  // main thread and starts playing that participant's own messages instead.
  const openLinkedConversation = (participantId: string) => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setIsPaused(false)
    setActiveThread({ kind: "sub", participantId })
    setSubRevealCount(0)
    pushHistory({ thread: { kind: "sub", participantId }, revealCount: pendingMainResumeIndexRef.current, subRevealCount: 0 })
    advance({ kind: "sub", participantId }, 0)
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
    /** True while a play session is active but frozen (paused, or mid manual step). */
    isPaused,
    play,
    stop,
    /** Freezes playback exactly where it is. */
    pause,
    /** Continues playback from exactly where it was frozen. */
    resume,
    /** Reveals the next message instantly and freezes there. */
    stepForward,
    /** Hides the last revealed message and freezes there. */
    stepBack,
    /** Whether stepBack() would currently do anything. */
    canStepBack: stepState.canStepBack,
    /** Whether stepForward() would currently do anything. */
    canStepForward: stepState.canStepForward,
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
