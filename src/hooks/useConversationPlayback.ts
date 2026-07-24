import { useEffect, useRef, useState } from "react"
import type { Message } from "@/types/message"
import { computeRevealTiming } from "@/utils/messageTiming"
import { playMessageSound } from "@/utils/sound"

interface UseConversationPlaybackOptions {
  /** Play the little "pop" sound whenever a new message is revealed. */
  soundEnabled?: boolean
  /**
   * Id of the "you" participant. Typing dots represent someone else composing
   * a message, so they should never show up for your own outgoing messages -
   * only for the other participant's.
   */
  selfId?: string
}

export const useConversationPlayback = (
  messages: Message[],
  { soundEnabled = true, selfId }: UseConversationPlaybackOptions = {},
) => {
  const [revealCount, setRevealCount] = useState(messages.length)
  const [typingSenderId, setTypingSenderId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearPendingTimeout = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
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
    setIsPlaying(false)
    setTypingSenderId(null)
    setRevealCount(messages.length)
  }

  const play = () => {
    clearPendingTimeout()
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

      // Only show typing dots for incoming messages from the other person;
      // your own outgoing messages never show a typing bubble for yourself.
      if (message.type !== "system" && message.senderId !== selfId) {
        setTypingSenderId(message.senderId)
      }

      timeoutRef.current = setTimeout(() => {
        setTypingSenderId(null)
        setRevealCount(index + 1)
        if (soundEnabled && message.type !== "system") {
          playMessageSound()
        }

        timeoutRef.current = setTimeout(() => step(index + 1), restMs)
      }, typingMs)
    }

    // Kick off with the first message's own delay before it appears.
    step(0)
  }

  useEffect(() => () => clearPendingTimeout(), [])

  return {
    /** How many messages (in order) should currently be rendered. */
    revealCount,
    /** senderId of whoever is "typing" right now, or null. */
    typingSenderId,
    isPlaying,
    play,
    stop,
  }
}
