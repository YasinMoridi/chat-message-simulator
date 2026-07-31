import { format } from "date-fns"
import type { Chat, Conversation, Participant } from "@/types/conversation"

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
 * than are actually chatting in any one chat - `chat.memberIds` narrows it
 * down to who's actually "in" this particular chat.
 */
export const getChatMembers = (conversation: Conversation, chat: Chat): Participant[] => {
  const idSet = new Set(chat.memberIds)
  const members = conversation.participants.filter((participant) => idSet.has(participant.id))
  return members.length ? members : conversation.participants
}

/** A chat is a "group" once 3+ of its members are actually chatting together. */
export const isGroupChat = (members: Participant[]) => members.length > 2

/** Builds a display title for a chat from its resolved members and optional custom name. */
export const getChatTitle = (members: Participant[], chatName?: string) => {
  const names = members.map((participant) => participant.name).filter(Boolean)
  if (members.length > 2) {
    return chatName?.trim() || "Group Chat"
  }
  if (names.length === 0) return "New Chat"
  if (names.length === 1) return names[0]
  return `${names[0]} & ${names[1]}`
}

/** Set-equality check on two lists of participant ids, ignoring order/duplicates. */
export const sameMemberSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  if (setA.size !== new Set(b).size) return false
  return b.every((id) => setA.has(id))
}

export const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/**
 * Reads an image file, downsizes it so its longest edge is at most
 * `maxDimension` px, and re-encodes it as JPEG at `quality` - returning a
 * much smaller data URL than the raw file. Avatars (and any other image
 * stored straight into the conversation) get persisted as base64 inside a
 * single localStorage key, which most browsers cap around 5-10MB total per
 * site; a handful of full-resolution phone photos can eat that whole
 * budget by themselves; once it's blown, saves start failing - so does the
 * FileReader step on later uploads (the browser stalls doing anything else
 * with device storage while it's near quota). Shrinking every image before
 * it's stored keeps the whole conversation - avatars, message images, all
 * of it - well under that limit.
 * Falls back to the plain (uncompressed) data URL if the browser can't
 * decode/draw the image for any reason, so a valid file is never rejected
 * outright just because compression didn't work.
 */
export const readImageAsCompressedDataUrl = (
  file: File,
  maxDimension = 512,
  quality = 0.82,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const rawDataUrl = reader.result as string
      const image = new Image()
      image.onload = () => {
        const longestEdge = Math.max(image.width, image.height)
        const scale = Math.min(1, maxDimension / longestEdge)
        const width = Math.max(1, Math.round(image.width * scale))
        const height = Math.max(1, Math.round(image.height * scale))
        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          resolve(rawDataUrl)
          return
        }
        ctx.drawImage(image, 0, 0, width, height)
        try {
          resolve(canvas.toDataURL("image/jpeg", quality))
        } catch {
          resolve(rawDataUrl)
        }
      }
      image.onerror = () => resolve(rawDataUrl)
      image.src = rawDataUrl
    }
    reader.readAsDataURL(file)
  })
