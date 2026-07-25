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
  /**
   * Only meaningful when type is "notification". When true, the banner can
   * be tapped during live playback - mimicking a real OS notification that
   * opens the app when you tap it.
   */
  notificationClickable?: boolean
  /**
   * Only meaningful when notificationClickable is true. How long (in
   * milliseconds) after being tapped the banner waits before "opening" into
   * the full chat, so the tap doesn't feel instantaneous.
   */
  notificationOpenDelayMs?: number
  /**
   * Only meaningful when notificationClickable is true. When true, nobody
   * has to actually tap the banner during playback - it "taps itself"
   * automatically after notificationAutoOpenDelayMs, then follows the same
   * press/open timing as a real tap (notificationOpenDelayMs). Lets the
   * whole open-the-chat beat be scripted up front instead of requiring a
   * live click every time the conversation is played back or recorded.
   */
  notificationAutoOpen?: boolean
  /**
   * Only meaningful when notificationAutoOpen is true. How long (in
   * milliseconds) after the banner finishes appearing before it "taps
   * itself".
   */
  notificationAutoOpenDelayMs?: number
  /**
   * Only meaningful when notificationClickable is true. Id of the
   * participant this notification actually belongs to. When set, tapping
   * (or auto-tapping) the banner opens a real, separate chat containing
   * only "you" and this participant - built from that participant's entry
   * in conversation.subConversations - instead of just revealing the rest
   * of the current conversation.
   */
  linkedParticipantId?: string
  /**
   * Only meaningful for a message that lives inside a sub-conversation
   * (conversation.subConversations). When true, once this message finishes
   * revealing, playback closes this side-chat and resumes the parent
   * conversation right where it paused. Ignored everywhere else - if no
   * message in a sub-conversation sets this, playback simply ends inside
   * that side-chat once its messages run out.
   */
  returnToParent?: boolean
}

/**
 * Shared shape for "here's a message to add/update" payloads - used by both
 * the main conversation and any sub-conversation, so MessageForm doesn't
 * need to know which one it's feeding.
 */
export interface MessageDraftPayload {
  senderId: string
  content: string
  imageUrl?: string
  timestamp: string
  type: MessageType
  status: MessageStatus
  delayMs?: number
  notificationOverride?: Message["notificationOverride"]
  notificationClickable?: boolean
  notificationOpenDelayMs?: number
  notificationAutoOpen?: boolean
  notificationAutoOpenDelayMs?: number
  linkedParticipantId?: string
  returnToParent?: boolean
}

/** Default delay (ms) applied to a message when none is set. */
export const DEFAULT_MESSAGE_DELAY_MS = 1200
/** Default wait (ms) between tapping a clickable notification and it opening the chat. */
export const DEFAULT_NOTIFICATION_OPEN_DELAY_MS = 700
/** Default wait (ms) after a clickable notification appears before it auto-taps itself. */
export const DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS = 1500

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
