import { format } from "date-fns"
import type { Conversation } from "@/types/conversation"

export const generateId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `id-${Math.random().toString(36).slice(2, 10)}`
}

export const formatTimestamp = (timestamp: string) => {
  try {
    return format(new Date(timestamp), "p")
  } catch {
    return ""
  }
}

export const formatDateSeparator = (timestamp: string) => {
  try {
    return format(new Date(timestamp), "MMM d, yyyy")
  } catch {
    return ""
  }
}

export const formatInstagramDateSeparator = (timestamp: string) => {
  try {
    return format(new Date(timestamp), "d MMM 'AT' HH:mm").toUpperCase()
  } catch {
    return ""
  }
}

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max)

/**
 * The roster (`conversation.participants`) can hold far more characters
 * than are actually chatting right now - `memberIds` narrows it down to
 * who's actually "in" this conversation. Falls back to the whole roster
 * for conversations saved before this field existed.
 */
export const getConversationMembers = (conversation: Conversation) => {
  const ids = conversation.memberIds
  if (!ids || ids.length === 0) return conversation.participants
  const idSet = new Set(ids)
  const members = conversation.participants.filter((participant) => idSet.has(participant.id))
  return members.length ? members : conversation.participants
}

/** A conversation is a "group" once 3+ of the roster are actually chatting together. */
export const isGroupConversation = (conversation: Conversation) =>
  getConversationMembers(conversation).length > 2

export const getConversationTitle = (conversation: Conversation) => {
  const members = getConversationMembers(conversation)
  const names = members.map((participant) => participant.name).filter(Boolean)
  if (members.length > 2) {
    return conversation.groupName?.trim() || "Group Chat"
  }
  if (names.length === 0) return "New Chat"
  if (names.length === 1) return names[0]
  return `${names[0]} & ${names[1]}`
}

export const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
