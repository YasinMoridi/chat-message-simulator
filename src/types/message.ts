export type MessageType = "text" | "system" | "image" | "notification"
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
   * visible message before it appears when played back.
   */
  delayMs?: number
  /**
   * Only meaningful when type is "notification". Lets that entry show a
   * different name/app/avatar than the chosen sender - e.g. simulate a
   * notification arriving from an unrelated app or contact.
   */
  notificationOverride?: {
    enabled: boolean
    senderName?: string
    appName?: string
    avatarUrl?: string
  }
}

/** Default delay (ms) applied to a message when none is set. */
export const DEFAULT_MESSAGE_DELAY_MS = 1200
