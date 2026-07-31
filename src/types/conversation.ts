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
 * A single, independent chat thread. Every chat is a peer of every other
 * one - there is no "main" chat anymore. `memberIds` is a subset of
 * `Conversation.participants` (the roster) chosen when the chat was
 * created; each chat can have a completely different cast. A
 * notification's `linkedChatId` (or `backNavigation.autoSelectChatId`) can
 * open any other chat, and a message's `returnToParent` hands control back
 * to whichever chat opened this one.
 */
export interface Chat {
  id: string
  /** Optional custom name; falls back to a name built from `memberIds` (see getChatTitle). */
  name?: string
  /** Subset of `participants` (the roster) who are actually chatting here. */
  memberIds: string[]
  messages: Message[]
}

export interface Conversation {
  id: string
  /** The full character roster - far more characters can exist here than are in any one chat. */
  participants: Participant[]
  /** Every chat, fully independent and level with each other. */
  chats: Chat[]
  metadata: ConversationMetadata
}
