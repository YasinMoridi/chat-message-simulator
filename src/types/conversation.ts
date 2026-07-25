import type { Message } from "./message"

export type ParticipantStatus = "online" | "offline" | "typing" | "empty"

export interface Participant {
  id: string
  name: string
  avatarUrl?: string
  isVerified?: boolean
  status: ParticipantStatus
  color: string
}

export interface ConversationMetadata {
  createdAt: string
  updatedAt: string
}

/**
 * A separate, real chat thread with a single participant - e.g. the "chat
 * with Sara" a clickable notification opens. Rendered with exactly two
 * participants ("you" + this one), completely independent from the main
 * conversation's message list. At most one of these exists per participant.
 */
export interface SubConversation {
  participantId: string
  messages: Message[]
}

export interface Conversation {
  id: string
  participants: Participant[]
  messages: Message[]
  metadata: ConversationMetadata
  groupName?: string
  /** Side-chats that clickable notifications can open. Keyed by participantId. */
  subConversations?: SubConversation[]
  /**
   * Which of `participants` (the roster) are actually chatting in this main
   * conversation right now - lets you keep a big cast of characters around
   * without every one of them joining as soon as they exist. 2 members ->
   * a direct chat; 3+ -> a group. Missing/empty means "everyone in the
   * roster" (how conversations saved before this field existed behave).
   */
  memberIds?: string[]
}
