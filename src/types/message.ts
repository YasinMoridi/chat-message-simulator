export type MessageType = "text" | "system" | "image"
export type MessageStatus = "sent" | "delivered" | "read"

export interface Message {
  id: string
  senderId: string
  content: string
  imageUrl?: string
  timestamp: string
  type: MessageType
  status: MessageStatus
  isHidden?: boolean
  /**
   * How long (in milliseconds) this message should wait after the previous
   * visible message before it appears when rendering a video export.
   * Only used by the video export feature; has no effect on images.
   */
  delayMs?: number
}

/** Default delay (ms) applied to a message when none is set. */
export const DEFAULT_MESSAGE_DELAY_MS = 1200
