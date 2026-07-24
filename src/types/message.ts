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

/**
 * A message that hasn't been added yet - mirrors what's currently typed in
 * the "new message" form, so the preview can show it live as a bubble
 * before it's actually submitted.
 */
export interface DraftMessage {
  senderId: string
  content: string
  imageUrl?: string
  type: MessageType
}

/** id given to the temporary bubble rendered for a DraftMessage in the preview. */
export const DRAFT_MESSAGE_ID = "__draft-preview__"
