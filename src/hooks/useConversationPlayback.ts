import { useEffect, useRef, useState } from "react"
import type { Message } from "@/types/message"
import { computeRevealTiming } from "@/utils/messageTiming"
import { playMessageSound } from "@/utils/sound"

interface UseConversationPlaybackOptions {
  /** Play the little "pop" sound whenever a new message is revealed. */
  soundEnabled?: boolean
  /**
   * The participant treated as "you". When the message about to be revealed
   * belongs to this participant, we simulate real on-device typing (letters
   * appearing progressively in the message input) instead of the generic
   * "...” dots bubble used for everyone else.
   */
  selfId?: string
  /** Every chat's own (visible) messages, keyed by chat id. */
  chats?: Record<string, Message[]>
  /** Which chat the preview should be showing/playing while nothing else has redirected it. */
  initialChatId?: string
  /**
   * Multiplier applied to how long selfId's own text messages take to
   * "type" (both the keystroke simulation and its length-derived duration).
   * 1 is the default pace; below 1 slows it down, above 1 speeds it up.
   */
  typingSpeed?: number
}

/**
 * Which chat is currently being animated/shown. "home" is the simulated
 * chat-list screen a message's backNavigation can send playback to - it
 * never advances on its own, it just sits there until a contact is tapped
 * (openFromHome) or the user steps back in history.
 */
export type ActiveThread = { kind: "chat"; chatId: string } | { kind: "home" }

/** A single point in the playback timeline - used to step back/forward. */
interface HistorySnapshot {
  thread: ActiveThread
  /** How many messages of EACH chat had been revealed at this point. */
  revealCounts: Record<string, number>
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

const emptyChats: Record<string, Message[]> = {}

export const useConversationPlayback = (
  { soundEnabled = true, selfId, chats = emptyChats, initialChatId = "", typingSpeed = 1 }: UseConversationPlaybackOptions = {},
) => {
  // How many messages of EACH chat have been revealed - preserved per chat
  // id, the same way the old build kept a separate counter for "main" and
  // for whichever one side-chat was open, just generalized to any number
  // of independent chats.
  const [revealCounts, setRevealCounts] = useState<Record<string, number>>({})
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
  // Which chat the preview is currently showing. Starts at initialChatId
  // unless a clickable, linked notification (or backNavigation) has moved
  // it elsewhere.
  const [activeThread, setActiveThread] = useState<ActiveThread>({ kind: "chat", chatId: initialChatId })
  // Mirrors historyRef/historyIndexRef purely so the UI can enable/disable
  // the step back/forward buttons - the refs below are the source of truth.
  const [stepState, setStepState] = useState({ canStepBack: false, canStepForward: false })
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bannerTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const keystrokeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Kept fresh via effect below so the resume-after-linked-chat continuation
  // (which can fire long after `play()` was originally called) always sees
  // the latest props instead of a stale closure.
  const chatsRef = useRef(chats)
  const selfIdRef = useRef(selfId)
  const soundEnabledRef = useRef(soundEnabled)
  const typingSpeedRef = useRef(typingSpeed)
  useEffect(() => {
    chatsRef.current = chats
    selfIdRef.current = selfId
    soundEnabledRef.current = soundEnabled
    typingSpeedRef.current = typingSpeed
  })

  // Which chat/index to resume once the currently-open linked (or
  // home-opened) chat returns or hits a returnToParent message. Only ever
  // holds one level - exactly like the old build's single main-resume
  // slot, just generalized from "main" to "whichever chat we left".
  const pendingResumeRef = useRef<{ chatId: string; index: number } | null>(null)

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
  // two moves ago", which would be ambiguous once linked chats are involved.
  const historyRef = useRef<HistorySnapshot[]>([
    { thread: { kind: "chat", chatId: initialChatId }, revealCounts: {} },
  ])
  const historyIndexRef = useRef(0)

  // Whether there's at least one more message to reveal live from `thread`
  // at its current reveal count - i.e. content that genuinely exists but
  // hasn't been stepped into yet, as opposed to a future already recorded
  // in history from an earlier rewind. Folding this into canStepForward
  // means the forward control stays enabled while a live play session is
  // running, instead of only ever allowing forward motion through
  // already-visited territory.
  const hasMoreToRevealLive = (thread: ActiveThread, counts: Record<string, number>) => {
    if (thread.kind === "home") return false
    const msgs = chatsRef.current[thread.chatId] ?? []
    const idx = counts[thread.chatId] ?? 0
    return idx < msgs.length
  }

  const syncStepState = () => {
    const current = historyRef.current[historyIndexRef.current]
    setStepState({
      canStepBack: historyIndexRef.current > 0,
      canStepForward:
        historyIndexRef.current < historyRef.current.length - 1 ||
        hasMoreToRevealLive(current.thread, current.revealCounts),
    })
  }

  // Keeps the buttons honest any time the underlying data changes shape
  // (messages added/removed while idle, a linked chat's own messages
  // changing, etc.) - not just right after a reveal/step/play call.
  useEffect(() => {
    syncStepState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, activeThread, revealCounts])

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

  // Keep everything visible by default (e.g. while editing in the builder) -
  // every chat fully revealed, not just the one currently on screen.
  useEffect(() => {
    if (isPlaying) return
    setRevealCounts(
      Object.fromEntries(Object.entries(chats).map(([chatId, msgs]) => [chatId, msgs.length])),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, chats])

  // Follows whichever chat is being edited/previewed elsewhere in the app,
  // as long as nothing is actively playing right now.
  useEffect(() => {
    if (isPlaying) return
    setActiveThread({ kind: "chat", chatId: initialChatId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, initialChatId])

  const stop = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    pendingResumeRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    const thread: ActiveThread = { kind: "chat", chatId: initialChatId }
    setActiveThread(thread)
    setRevealCounts(
      Object.fromEntries(Object.entries(chatsRef.current).map(([chatId, msgs]) => [chatId, msgs.length])),
    )
    resetHistory({ thread, revealCounts: {} })
  }

  // Works out how long a message should "type" for and how long to wait
  // after, including the real-keystroke simulation for the current
  // participant's own text messages. Shared by every chat, since the logic
  // doesn't depend on which one it's playing.
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
      // A speed of 1 reproduces the original fixed bounds exactly; higher
      // speeds shrink them (types faster), lower speeds stretch them (types
      // slower). Guard against a zero/negative value reaching here somehow.
      const speed = typingSpeedRef.current > 0 ? typingSpeedRef.current : 1
      const minKeystrokeMs = MIN_KEYSTROKE_MS / speed
      const maxKeystrokeMs = MAX_KEYSTROKE_MS / speed
      const minOwnTypingMs = MIN_OWN_TYPING_MS / speed
      const maxOwnTypingMs = MAX_OWN_TYPING_MS / speed
      const keystrokeDelay = Math.min(maxKeystrokeMs, Math.max(minKeystrokeMs, maxOwnTypingMs / text.length))
      typingMs = Math.min(maxOwnTypingMs, Math.max(minOwnTypingMs, text.length * keystrokeDelay))
      // No artificial pause after typing finishes - the message sends the
      // instant the simulated keystrokes finish, purely auto-timed from its
      // own length. (message.delayMs is intentionally ignored here now.)
      restMs = 0
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
    onComplete?: () => void,
  ) => {
    if (message.type !== "system" && message.type !== "notification") {
      setTypingSenderId(message.senderId)
    }
    if (isOwnTextMessage) {
      const remainingChars = text.length - startFromChar
      if (remainingChars <= 0 || typingMs <= 0) {
        setTypingDraftText(text)
        // Fire asynchronously (not mid-render) even in the already-done case,
        // so callers can rely on onComplete always landing on its own tick.
        if (onComplete) {
          clearPendingTimeout()
          timeoutRef.current = setTimeout(onComplete, 0)
        }
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
          // Reveal is triggered right here, by the same clock that just
          // rendered the final character - never by a second, independently
          // scheduled timer that could drift and fire a beat early.
          onComplete?.()
        }
      }, keystrokeDelay)
    } else {
      setTypingDraftText(null)
    }
  }

  // Applies the visible effects of a message becoming revealed - bumping
  // that chat's reveal counter, playing the pop sound, showing a banner if
  // it's a notification, and recording a history snapshot for step
  // back/forward.
  const applyReveal = (thread: ActiveThread, index: number, message: Message, restMs: number) => {
    if (thread.kind === "home") return
    const newCount = index + 1
    const nextRevealCounts = { ...revealCounts, [thread.chatId]: newCount }
    setRevealCounts(nextRevealCounts)
    if (soundEnabledRef.current && message.type !== "system") {
      playMessageSound()
    }
    if (message.type === "notification") {
      showBanner(message, restMs, { persist: Boolean(message.notificationClickable) })
    }
    pushHistory({ thread, revealCounts: nextRevealCounts })
  }

  const advance = (thread: ActiveThread, index: number) => {
    if (thread.kind === "home") {
      // The home screen never plays anything by itself - it just waits
      // for a contact to be tapped (openFromHome).
      setIsPlaying(false)
      setIsPaused(false)
      return
    }
    const msgs = chatsRef.current[thread.chatId] ?? []
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
    if (isOwnTextMessage) {
      beginTypingSimulation(message, isOwnTextMessage, text, typingMs, 0, () =>
        finishTypingPhase(thread, index, message, restMs),
      )
    } else {
      beginTypingSimulation(message, isOwnTextMessage, text, typingMs)
      timeoutRef.current = setTimeout(() => finishTypingPhase(thread, index, message, restMs), typingMs)
    }
  }

  const finishTypingPhase = (thread: ActiveThread, index: number, message: Message, restMs: number) => {
    clearKeystrokeInterval()
    setTypingSenderId(null)
    setTypingDraftText(null)
    applyReveal(thread, index, message, restMs)

    // A clickable notification that's linked to another chat pauses right
    // here - only a tap (real or auto-scripted) moves the story forward
    // from this point.
    const opensLinkedThread =
      thread.kind === "chat" &&
      message.type === "notification" &&
      Boolean(message.notificationClickable) &&
      Boolean(message.linkedChatId)
    if (opensLinkedThread) {
      pendingResumeRef.current = { chatId: thread.chatId, index: index + 1 }
      runningPhaseRef.current = null
      return
    }

    const isReturn = thread.kind === "chat" && Boolean(message.returnToParent)
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
      if (isReturn && pendingResumeRef.current) {
        const target: ActiveThread = { kind: "chat", chatId: pendingResumeRef.current.chatId }
        setActiveThread(target)
        runningPhaseRef.current = null
        advance(target, pendingResumeRef.current.index)
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
    pendingResumeRef.current = null
    setIsPlaying(true)
    setIsPaused(false)
    setTypingSenderId(null)
    setTypingDraftText(null)
    const thread: ActiveThread = { kind: "chat", chatId: initialChatId }
    setRevealCounts({ [initialChatId]: 0 })
    setActiveThread(thread)
    resetHistory({ thread, revealCounts: { [initialChatId]: 0 } })
    advance(thread, 0)
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
        if (phase.isOwnTextMessage) {
          beginTypingSimulation(
            phase.message,
            phase.isOwnTextMessage,
            phase.text,
            phase.remainingMs,
            startFromChar,
            () => finishTypingPhase(phase.thread, phase.index, phase.message, phase.restMs),
          )
        } else {
          beginTypingSimulation(phase.message, phase.isOwnTextMessage, phase.text, phase.remainingMs, startFromChar)
          timeoutRef.current = setTimeout(
            () => finishTypingPhase(phase.thread, phase.index, phase.message, phase.restMs),
            Math.max(0, phase.remainingMs),
          )
        }
      } else {
        runningPhaseRef.current = { ...phase, restMs: phase.remainingMs, startedAt: Date.now() }
        timeoutRef.current = setTimeout(() => {
          if (phase.isReturn && pendingResumeRef.current) {
            const target: ActiveThread = { kind: "chat", chatId: pendingResumeRef.current.chatId }
            setActiveThread(target)
            runningPhaseRef.current = null
            advance(target, pendingResumeRef.current.index)
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
    const idx = activeThread.kind === "chat" ? revealCounts[activeThread.chatId] ?? 0 : 0
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
  // triggers (opening a linked chat, or returning from one).
  const revealNextLive = (thread: ActiveThread, index: number) => {
    if (thread.kind === "home") {
      setIsPlaying(false)
      setIsPaused(false)
      return
    }
    const msgs = chatsRef.current[thread.chatId] ?? []
    if (index >= msgs.length) {
      setIsPlaying(false)
      setIsPaused(false)
      return
    }
    const message = msgs[index]
    const { restMs } = prepareMessageTiming(message)
    applyReveal(thread, index, message, restMs)

    if (message.type === "notification" && message.notificationClickable && message.linkedChatId) {
      const chatId = message.linkedChatId
      pendingResumeRef.current = { chatId: thread.chatId, index: index + 1 }
      dismissBanner()
      const target: ActiveThread = { kind: "chat", chatId }
      setActiveThread(target)
      const nextRevealCounts = { ...revealCounts, [chatId]: 0 }
      setRevealCounts(nextRevealCounts)
      pushHistory({ thread: target, revealCounts: nextRevealCounts })
      return
    }
    if (message.returnToParent && pendingResumeRef.current) {
      const target: ActiveThread = { kind: "chat", chatId: pendingResumeRef.current.chatId }
      setActiveThread(target)
      pushHistory({ thread: target, revealCounts })
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
      setRevealCounts(snap.revealCounts)
      return
    }

    // Cold start - nothing has played yet.
    if (!isPlaying) {
      freezeForManualStep()
      const thread: ActiveThread = { kind: "chat", chatId: initialChatId }
      setActiveThread(thread)
      setRevealCounts({ [initialChatId]: 0 })
      resetHistory({ thread, revealCounts: { [initialChatId]: 0 } })
      dismissBanner()
      revealNextLive(thread, 0)
      return
    }

    if (activeThread.kind === "home") return

    freezeForManualStep()
    const thread = activeThread
    const idx = revealCounts[thread.chatId] ?? 0
    revealNextLive(thread, idx)
  }

  // Hides the most recently revealed message and freezes there - like
  // stepping a video backward one frame. Walks the recorded history so
  // linked-chat boundaries are undone correctly instead of guessed at.
  const stepBack = () => {
    if (historyIndexRef.current <= 0) return
    freezeForManualStep()
    dismissBanner()
    historyIndexRef.current -= 1
    const snap = historyRef.current[historyIndexRef.current]
    syncStepState()
    setActiveThread(snap.thread)
    setRevealCounts(snap.revealCounts)
  }

  // Pure computation (no state writes) of every history snapshot between
  // `startThread`/`startCounts` and the very end of the story, following
  // linked-chat detours along the way exactly like revealNextLive does
  // live, message by message - just without any timers. Used by
  // jumpToEnd() to seek straight to the last frame in one go, the way
  // scrubbing a video timeline to the end doesn't play every frame in
  // between.
  const computeSnapshotsToEnd = (startThread: ActiveThread, startCounts: Record<string, number>) => {
    const snapshots: HistorySnapshot[] = []
    let curThread = startThread
    let curCounts = startCounts
    let pendingResume = pendingResumeRef.current
    let lastMessage: Message | null = null

    // Safety valve: a malformed/cyclic script (e.g. two chats whose
    // messages keep returning to each other) should never hang the tab.
    let guard = 0
    const GUARD_LIMIT = 100000
    while (guard++ < GUARD_LIMIT) {
      if (curThread.kind === "home") break
      const msgs = chatsRef.current[curThread.chatId] ?? []
      const idx = curCounts[curThread.chatId] ?? 0
      if (idx >= msgs.length) break
      const message = msgs[idx]
      lastMessage = message

      curCounts = { ...curCounts, [curThread.chatId]: idx + 1 }

      const opensLinkedThread =
        message.type === "notification" && Boolean(message.notificationClickable) && Boolean(message.linkedChatId)

      if (opensLinkedThread) {
        pendingResume = { chatId: curThread.chatId, index: idx + 1 }
        curThread = { kind: "chat", chatId: message.linkedChatId! }
        curCounts = { ...curCounts, [curThread.chatId]: 0 }
        snapshots.push({ thread: curThread, revealCounts: curCounts })
        continue
      }

      if (message.returnToParent && pendingResume) {
        curThread = { kind: "chat", chatId: pendingResume.chatId }
        snapshots.push({ thread: curThread, revealCounts: curCounts })
        continue
      }

      snapshots.push({ thread: curThread, revealCounts: curCounts })
    }

    return { snapshots, pendingResume, lastMessage }
  }

  // Jumps straight to the end of the story - like scrubbing a video all
  // the way to its last frame - instead of waiting for playback to finish
  // or clicking stepForward one message at a time.
  const jumpToEnd = () => {
    freezeForManualStep()
    dismissBanner()
    const current = historyRef.current[historyIndexRef.current]
    const { snapshots, pendingResume, lastMessage } = computeSnapshotsToEnd(current.thread, current.revealCounts)
    if (snapshots.length === 0) return

    historyRef.current = [...historyRef.current.slice(0, historyIndexRef.current + 1), ...snapshots]
    historyIndexRef.current = historyRef.current.length - 1
    pendingResumeRef.current = pendingResume
    syncStepState()

    const last = snapshots[snapshots.length - 1]
    setActiveThread(last.thread)
    setRevealCounts(last.revealCounts)

    // Show the final message's banner if it's a notification, matching
    // what would be on screen had we stepped there one message at a time.
    if (lastMessage && lastMessage.type === "notification") {
      showBanner(lastMessage, 0, { persist: Boolean(lastMessage.notificationClickable) })
    }
  }

  // Jumps straight back to the very first frame - the counterpart to
  // jumpToEnd().
  const jumpToStart = () => {
    if (historyIndexRef.current <= 0) return
    freezeForManualStep()
    dismissBanner()
    historyIndexRef.current = 0
    pendingResumeRef.current = null
    const snap = historyRef.current[0]
    syncStepState()
    setActiveThread(snap.thread)
    setRevealCounts(snap.revealCounts)
  }

  // Opens the chat linked to `chatId` (called once a clickable notification
  // is actually tapped, live or auto-scripted): pauses the current chat and
  // starts playing that chat's own messages instead.
  const openLinkedConversation = (chatId: string) => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setIsPaused(false)
    const target: ActiveThread = { kind: "chat", chatId }
    setActiveThread(target)
    const nextRevealCounts = { ...revealCounts, [chatId]: 0 }
    setRevealCounts(nextRevealCounts)
    pushHistory({ thread: target, revealCounts: nextRevealCounts })
    advance(target, 0)
  }

  // Leaves whichever chat is currently open for the simulated home screen -
  // triggered when the currently-last-shown message has backNavigation.
  // enabled and the header's back button is tapped. Remembers where this
  // chat paused so a later returnToParent (from a chat opened off the home
  // screen) can still resume it right where it left off.
  const goHome = () => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    if (activeThread.kind === "chat") {
      pendingResumeRef.current = { chatId: activeThread.chatId, index: revealCounts[activeThread.chatId] ?? 0 }
    }
    setTypingSenderId(null)
    setTypingDraftText(null)
    setIsPaused(false)
    setActiveThread({ kind: "home" })
    pushHistory({ thread: { kind: "home" }, revealCounts })
  }

  // Tapping a contact on the home screen: opens a real, separate chat with
  // them - same mechanism a clickable, linked notification uses.
  const openFromHome = (chatId: string) => {
    clearPendingTimeout()
    clearKeystrokeInterval()
    dismissBanner()
    runningPhaseRef.current = null
    pausedPhaseRef.current = null
    pausedBannerRemainingRef.current = null
    setIsPaused(false)
    const target: ActiveThread = { kind: "chat", chatId }
    setActiveThread(target)
    const nextRevealCounts = { ...revealCounts, [chatId]: 0 }
    setRevealCounts(nextRevealCounts)
    pushHistory({ thread: target, revealCounts: nextRevealCounts })
    if (isPlaying) {
      advance(target, 0)
    }
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
    /** How many messages (in order) of the currently active chat should currently be rendered. */
    revealCount: activeThread.kind === "chat" ? revealCounts[activeThread.chatId] ?? 0 : 0,
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
    /** Jumps straight to the end of the story, like seeking a video to its last frame. */
    jumpToEnd,
    /** Jumps straight back to the very first frame. */
    jumpToStart,
    /** Whether stepBack() would currently do anything. */
    canStepBack: stepState.canStepBack,
    /** Whether stepForward() would currently do anything. */
    canStepForward: stepState.canStepForward,
    /** The message the notification banner is currently showing, if any. */
    bannerMessage,
    /** Whether the banner should be in its "shown" (vs sliding out) state. */
    bannerVisible,
    /** Which chat is currently active - a real chat id, or the simulated home screen. */
    activeThread,
    /** Opens (and starts playing) the chat linked to a tapped notification. */
    openLinkedConversation,
    /** Leaves the currently open chat for the simulated home (chat list) screen. */
    goHome,
    /** Opens the chat for a contact tapped on the home screen. */
    openFromHome,
  }
}
