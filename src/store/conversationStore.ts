import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import { defaultLayoutId } from "../constants/layouts"
import type { Chat, Conversation, Participant } from "../types/conversation"
import type { Message, MessageStatus, MessageType, DraftMessage } from "../types/message"
import { DEFAULT_MESSAGE_DELAY_MS } from "../types/message"
import type { LayoutId, ThemeId } from "../types/layout"
import { generateId, sameMemberSet } from "../utils/helpers"

export type ExportFormat = "png" | "jpeg"
export type ExportCaptureMode = "viewport" | "full" | "screens"

export interface ExportSettings {
  presetId: string
  width: number
  height: number
  scale: number
  format: ExportFormat
  quality: number
  captureMode: ExportCaptureMode
}

export type AppLanguage = "en" | "fa"

/**
 * Which fields a bulk-edit pass should touch. Every field is opt-in - only
 * the ones present get applied, so the panel can flip on just "date" or
 * just "status" without disturbing the rest of each message.
 */
export interface BulkMessageUpdate {
  /** "YYYY-MM-DD" - replaces the date portion of every affected message's timestamp. */
  date?: string
  /** When true (default), each message keeps its own time-of-day; only the date changes. */
  keepTimeOfDay?: boolean
  senderId?: string
  status?: MessageStatus
  delayMs?: number
}

export interface UiState {
  activeView: "editor" | "preview"
  showChrome: boolean
  /** Show the OS-style "new message" notification banner at the top of the screen. */
  showNotificationBanner: boolean
  zoom: number
  isSidebarOpen: boolean
  activePanel: "messages" | "participants" | "settings" | "export"
  autoFit: boolean
  /**
   * Multiplier applied to how long your own text messages take to
   * "type" during playback. 1 is the default pace; below 1 slows it down,
   * above 1 speeds it up.
   */
  typingSpeed: number
}

type Snapshot = {
  conversation: Conversation
  activeChatId: string
  layoutId: LayoutId
  themeId: ThemeId
  activeParticipantId: string
  backgroundImageUrl: string
  backgroundImageOpacity: number
  backgroundColor: string
  exportSettings: ExportSettings
}

interface HistoryState {
  past: Snapshot[]
  future: Snapshot[]
}

export interface MessagePayload {
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
  linkedChatId?: string
  returnToParent?: boolean
  backNavigation?: Message["backNavigation"]
}

interface ConversationStore {
  conversation: Conversation
  /** Which chat is currently being edited (ConversationBuilder) and shown in the preview. */
  activeChatId: string
  layoutId: LayoutId
  themeId: ThemeId
  activeParticipantId: string
  backgroundImageUrl: string
  backgroundImageOpacity: number
  backgroundColor: string
  exportSettings: ExportSettings
  ui: UiState
  /**
   * Free-typed names used for the notification sender-name override across
   * any conversation - lets the picker in MessageForm offer previously used
   * custom names instead of forcing a fresh retype (or a full Participant)
   * every time.
   */
  notificationSenderNames: string[]
  /** Which language the app's own UI (labels, settings, buttons) is shown in. */
  language: AppLanguage
  /**
   * Live mirror of whatever's currently typed in the "new message" form -
   * lets the preview show it as a bubble before it's actually submitted.
   */
  draftMessage: DraftMessage | null
  history: HistoryState
  lastAutosaveAt: number | null
  setLayout: (layoutId: LayoutId) => void
  setTheme: (themeId: ThemeId) => void
  setActiveParticipant: (participantId: string) => void
  setActiveChatId: (chatId: string) => void
  setBackgroundImageUrl: (url: string) => void
  setBackgroundImageOpacity: (opacity: number) => void
  clearBackgroundImage: () => void
  setBackgroundColor: (color: string) => void
  setLastAutosaveAt: (timestamp: number | null) => void
  addParticipant: (participant: Omit<Participant, "id">) => void
  updateParticipant: (participantId: string, updates: Partial<Participant>) => void
  removeParticipant: (participantId: string) => void
  /** Creates a brand-new, independent chat with exactly the given members. Returns its id. */
  createChat: (memberIds: string[], name?: string) => string
  renameChat: (chatId: string, name: string) => void
  deleteChat: (chatId: string) => void
  updateChatMembers: (chatId: string, memberIds: string[]) => void
  /** Adds a roster participant to a chat, without flipping them off if they're already in it. */
  ensureChatMember: (chatId: string, participantId: string) => void
  /**
   * Finds an existing chat whose members are exactly `memberIds`, or
   * creates one if none exists. Returns its id.
   */
  findOrCreateChatWithMembers: (memberIds: string[], name?: string) => string
  addMessage: (chatId: string, payload: MessagePayload) => void
  updateMessage: (chatId: string, messageId: string, updates: Partial<Message>) => void
  deleteMessage: (chatId: string, messageId: string) => void
  duplicateMessage: (chatId: string, messageId: string) => void
  setMessages: (chatId: string, messages: Message[]) => void
  /** Applies the same change(s) - date, sender, status, delay - to one chat, or every chat at once. */
  bulkUpdateMessages: (chatId: string | "all", updates: BulkMessageUpdate) => void
  setExportSettings: (settings: Partial<ExportSettings>) => void
  setUi: (updates: Partial<UiState>) => void
  addNotificationSenderName: (name: string) => void
  setLanguage: (language: AppLanguage) => void
  setDraftMessage: (draft: DraftMessage | null) => void
  resetConversation: () => void
  loadConversation: (conversation: Conversation) => void
  undo: () => void
  redo: () => void
  saveSnapshot: () => void
  clearSnapshot: () => void
}

const defaultParticipants: Participant[] = [
  {
    id: "p1",
    name: "Avery",
    status: "online",
    color: "#22c55e",
  },
  {
    id: "p2",
    name: "Jordan",
    status: "typing",
    color: "#0b84ff",
  },
]

const removedDefaultAvatarUrls = new Set([
  "https://i.pravatar.cc/100?img=12",
  "https://i.pravatar.cc/100?img=32",
])
const removedDefaultAvatarPatterns = [/avatar-avery/i, /avatar-jordan/i]

const normalizeParticipants = (participants: Participant[]) =>
  participants.map((participant) => {
    const { avatarUrl } = participant
    if (!avatarUrl) return participant
    const isRemovedDefaultAvatar =
      removedDefaultAvatarUrls.has(avatarUrl) ||
      removedDefaultAvatarPatterns.some((pattern) => pattern.test(avatarUrl))
    return isRemovedDefaultAvatar ? { ...participant, avatarUrl: undefined } : participant
  })

const defaultMessageSeed: Array<{
  senderId: string
  content: string
  type: MessageType
  status: MessageStatus
}> = [
  {
    senderId: "p1",
    content: "Morning. I expanded the chat mockup layout so it feels closer to a real thread.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p2",
    content: "Good. The short demo was too tidy and it hid the long-conversation problem.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "Exactly. Once the conversation got dense, people couldn’t tell how to review older messages.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p2",
    content: "And exports only made sense if the important part happened to be inside the device viewport.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "So I’m splitting it into two actions: capture the current viewport, or export every visible message.",
    type: "text",
    status: "delivered",
  },
  {
    senderId: "p2",
    content: "That solves the screenshot problem. We still need a clearer way to move through the preview itself.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "I’m adding jump controls for top and latest, plus a status callout when the thread is taller than the phone.",
    type: "text",
    status: "delivered",
  },
  {
    senderId: "p2",
    content: "Perfect. It should feel obvious without adding weird chrome inside the fake app UI.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "Also removing the bundled SVG avatars. Default mocks will use initials until the user uploads real images.",
    type: "text",
    status: "delivered",
  },
  {
    senderId: "p2",
    content: "Better. Neutral defaults make the generator feel less pre-scripted.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "I left hidden messages out of the full export on purpose. If it’s hidden in the builder, it stays hidden everywhere.",
    type: "text",
    status: "delivered",
  },
  {
    senderId: "p2",
    content: "Good call. Otherwise export behavior gets surprising fast.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p2",
    content: "System note: long threads now get dedicated preview guidance and an all-messages export mode.",
    type: "system",
    status: "sent",
  },
  {
    senderId: "p1",
    content: "I’m keeping the phone preview fixed-height so editing still feels like composing on a real device.",
    type: "text",
    status: "delivered",
  },
  {
    senderId: "p2",
    content: "That’s the right tradeoff. The editor stays readable, and the export can grow when it needs to.",
    type: "text",
    status: "read",
  },
  {
    senderId: "p1",
    content: "Ship it. This seed thread should make the new behavior obvious the moment the app loads.",
    type: "text",
    status: "sent",
  },
]

const buildDefaultConversation = (): Conversation => {
  const updatedAt = new Date()
  const firstTimestamp = updatedAt.getTime() - (defaultMessageSeed.length - 1) * 60_000
  const participants = normalizeParticipants(defaultParticipants)
  const chat: Chat = {
    id: "chat-1",
    memberIds: participants.map((participant) => participant.id),
    messages: defaultMessageSeed.map((message, index) => ({
      id: `m${index + 1}`,
      ...message,
      timestamp: new Date(firstTimestamp + index * 60_000).toISOString(),
      delayMs: DEFAULT_MESSAGE_DELAY_MS,
    })),
  }
  return {
    id: "conv-1",
    participants,
    chats: [chat],
    metadata: {
      createdAt: new Date(firstTimestamp).toISOString(),
      updatedAt: updatedAt.toISOString(),
    },
  }
}

const defaultExportSettings: ExportSettings = {
  presetId: "iphone-14-pro",
  width: 393,
  height: 852,
  scale: 2,
  format: "png",
  quality: 0.95,
  captureMode: "viewport",
}

const defaultUiState: UiState = {
  activeView: "editor",
  showChrome: true,
  showNotificationBanner: true,
  zoom: 1,
  isSidebarOpen: true,
  activePanel: "messages",
  autoFit: true,
  typingSpeed: 1,
}

const STORAGE_KEY = "chat-sim-storage"
/** Applies the enabled fields of a BulkMessageUpdate to a single message. */
const applyBulkUpdate = (message: Message, updates: BulkMessageUpdate): Message => {
  let next = message
  if (updates.date) {
    const [year, month, day] = updates.date.split("-").map(Number)
    if (!Number.isNaN(year) && !Number.isNaN(month) && !Number.isNaN(day)) {
      const original = new Date(message.timestamp)
      const nextDate = new Date(original)
      nextDate.setFullYear(year, month - 1, day)
      if (updates.keepTimeOfDay === false) {
        nextDate.setHours(0, 0, 0, 0)
      }
      next = { ...next, timestamp: nextDate.toISOString() }
    }
  }
  if (updates.senderId) {
    next = { ...next, senderId: updates.senderId }
  }
  if (updates.status) {
    next = { ...next, status: updates.status }
  }
  if (updates.delayMs !== undefined) {
    next = { ...next, delayMs: updates.delayMs }
  }
  return next
}

const HISTORY_LIMIT = 3

const buildSnapshot = (state: ConversationStore): Snapshot => ({
  conversation: state.conversation,
  activeChatId: state.activeChatId,
  layoutId: state.layoutId,
  themeId: state.themeId,
  activeParticipantId: state.activeParticipantId,
  backgroundImageUrl: state.backgroundImageUrl,
  backgroundImageOpacity: state.backgroundImageOpacity,
  backgroundColor: state.backgroundColor,
  exportSettings: state.exportSettings,
})

const pushHistory = (state: ConversationStore): HistoryState => {
  const past = [...state.history.past, buildSnapshot(state)]
  return {
    past: past.slice(-HISTORY_LIMIT),
    future: [],
  }
}

/** Touches metadata.updatedAt - shared by every mutation below. */
const touchMetadata = (conversation: Conversation): Conversation => ({
  ...conversation,
  metadata: { ...conversation.metadata, updatedAt: new Date().toISOString() },
})

const mapChat = (conversation: Conversation, chatId: string, updater: (chat: Chat) => Chat): Conversation => ({
  ...conversation,
  chats: conversation.chats.map((chat) => (chat.id === chatId ? updater(chat) : chat)),
})

/**
 * Best-effort migration of a legacy single-main-chat conversation (from
 * before independent, user-built chats existed) into the current
 * `chats[]` shape. Accepts loosely-typed input since old exports/persisted
 * state won't type-check against the current Conversation interface.
 */
const migrateLegacyConversation = (raw: Record<string, unknown>): Conversation => {
  const participants = normalizeParticipants((raw.participants as Participant[]) ?? [])
  const legacyMemberIds =
    (raw.memberIds as string[] | undefined) && (raw.memberIds as string[]).length
      ? (raw.memberIds as string[])
      : participants.map((participant) => participant.id)
  const legacyGroupName = raw.groupName as string | undefined
  const legacyTitle = raw.title as string | undefined
  const legacyMessages = ((raw.messages as Message[] | undefined) ?? []).map((message) => ({
    ...message,
    delayMs: message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS,
  }))
  const legacySubConversations =
    (raw.subConversations as Array<{ participantId: string; messages: Message[] }> | undefined) ?? []

  const mainChatId = generateId()
  const chats: Chat[] = [
    {
      id: mainChatId,
      name: legacyMemberIds.length > 2 ? legacyGroupName ?? legacyTitle : undefined,
      memberIds: legacyMemberIds,
      messages: legacyMessages,
    },
  ]

  // Each old side-chat becomes its own top-level chat between "self" (the
  // first roster participant, matching the old convention) and the one
  // participant it belonged to.
  const selfId = participants[0]?.id
  const participantIdToChatId = new Map<string, string>()
  legacySubConversations.forEach((entry) => {
    const chatId = generateId()
    participantIdToChatId.set(entry.participantId, chatId)
    chats.push({
      id: chatId,
      memberIds: selfId ? [selfId, entry.participantId] : [entry.participantId],
      messages: entry.messages.map((message) => ({
        ...message,
        delayMs: message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS,
      })),
    })
  })

  // Remap old linkedParticipantId / backNavigation.autoSelectParticipantId
  // references (on any message, in any old thread) to the new chat ids.
  const remapMessage = (message: Message & { linkedParticipantId?: string }): Message => {
    const next: Message = { ...message }
    if (message.linkedParticipantId) {
      const targetChatId = participantIdToChatId.get(message.linkedParticipantId)
      if (targetChatId) next.linkedChatId = targetChatId
      delete (next as { linkedParticipantId?: string }).linkedParticipantId
    }
    if (next.backNavigation) {
      const legacyBackNav = next.backNavigation as typeof next.backNavigation & {
        autoSelectParticipantId?: string
      }
      if (legacyBackNav.autoSelectParticipantId) {
        const targetChatId = participantIdToChatId.get(legacyBackNav.autoSelectParticipantId)
        next.backNavigation = {
          ...legacyBackNav,
          autoSelectChatId: targetChatId,
        }
        delete (next.backNavigation as { autoSelectParticipantId?: string }).autoSelectParticipantId
      }
    }
    return next
  }

  const migratedChats = chats.map((chat) => ({ ...chat, messages: chat.messages.map(remapMessage) }))

  return {
    id: (raw.id as string) ?? generateId(),
    participants,
    chats: migratedChats,
    metadata: (raw.metadata as Conversation["metadata"]) ?? {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
}

/** True once a conversation is already in the current chats[]-based shape. */
const isCurrentShape = (raw: unknown): raw is Conversation =>
  Boolean(raw) && Array.isArray((raw as { chats?: unknown }).chats)

const normalizeLoadedConversation = (raw: Conversation | Record<string, unknown>): Conversation => {
  if (isCurrentShape(raw)) {
    return {
      ...raw,
      participants: normalizeParticipants(raw.participants),
      chats: raw.chats.length
        ? raw.chats
        : [{ id: generateId(), memberIds: raw.participants.map((p) => p.id), messages: [] }],
    }
  }
  return migrateLegacyConversation(raw as Record<string, unknown>)
}

export const useConversationStore = create<ConversationStore>()(
  persist(
    (set, get) => ({
      conversation: buildDefaultConversation(),
      activeChatId: "chat-1",
      layoutId: defaultLayoutId,
      themeId: "light",
      activeParticipantId: defaultParticipants[0].id,
      backgroundImageUrl: "",
      backgroundImageOpacity: 0.35,
      backgroundColor: "",
      exportSettings: defaultExportSettings,
      ui: defaultUiState,
      notificationSenderNames: [],
      language: "en",
      draftMessage: null,
      history: { past: [], future: [] },
      lastAutosaveAt: null,
      setLayout: (layoutId) => set((state) => ({ layoutId, history: pushHistory(state) })),
      setTheme: (themeId) => set((state) => ({ themeId, history: pushHistory(state) })),
      setActiveParticipant: (participantId) =>
        set((state) => ({
          activeParticipantId: participantId,
          history: pushHistory(state),
        })),
      setActiveChatId: (chatId) => set({ activeChatId: chatId }),
      setBackgroundImageUrl: (url) =>
        set((state) => ({ backgroundImageUrl: url, history: pushHistory(state) })),
      setBackgroundImageOpacity: (opacity) =>
        set((state) => ({ backgroundImageOpacity: opacity, history: pushHistory(state) })),
      clearBackgroundImage: () =>
        set((state) => ({ backgroundImageUrl: "", history: pushHistory(state) })),
      setBackgroundColor: (color) =>
        set((state) => ({ backgroundColor: color, history: pushHistory(state) })),
      setLastAutosaveAt: (timestamp) => set({ lastAutosaveAt: timestamp }),
      addParticipant: (participant) =>
        set((state) => {
          const newParticipant: Participant = { id: generateId(), ...participant }
          const nextParticipants = [...state.conversation.participants, newParticipant]
          return {
            conversation: touchMetadata({ ...state.conversation, participants: nextParticipants }),
            history: pushHistory(state),
          }
        }),
      updateParticipant: (participantId, updates) =>
        set((state) => ({
          conversation: touchMetadata({
            ...state.conversation,
            participants: state.conversation.participants.map((participant) =>
              participant.id === participantId ? { ...participant, ...updates } : participant,
            ),
          }),
          history: pushHistory(state),
        })),
      removeParticipant: (participantId) =>
        set((state) => {
          const remaining = state.conversation.participants.filter(
            (participant) => participant.id !== participantId,
          )
          const activeParticipantId =
            state.activeParticipantId === participantId && remaining.length
              ? remaining[0].id
              : state.activeParticipantId
          return {
            activeParticipantId,
            conversation: touchMetadata({
              ...state.conversation,
              participants: remaining,
              chats: state.conversation.chats.map((chat) => ({
                ...chat,
                memberIds: chat.memberIds.filter((id) => id !== participantId),
                messages: chat.messages.filter((message) => message.senderId !== participantId),
              })),
            }),
            history: pushHistory(state),
          }
        }),
      createChat: (memberIds, name) => {
        const validIds = new Set(get().conversation.participants.map((participant) => participant.id))
        const filteredMemberIds = memberIds.filter((id) => validIds.has(id))
        const newChat: Chat = { id: generateId(), name: name?.trim() || undefined, memberIds: filteredMemberIds, messages: [] }
        set((state) => ({
          conversation: touchMetadata({ ...state.conversation, chats: [...state.conversation.chats, newChat] }),
          history: pushHistory(state),
        }))
        return newChat.id
      },
      renameChat: (chatId, name) =>
        set((state) => ({
          conversation: touchMetadata(
            mapChat(state.conversation, chatId, (chat) => ({ ...chat, name: name.trim() || undefined })),
          ),
          history: pushHistory(state),
        })),
      deleteChat: (chatId) =>
        set((state) => {
          const remainingChats = state.conversation.chats.filter((chat) => chat.id !== chatId)
          return {
            conversation: touchMetadata({ ...state.conversation, chats: remainingChats }),
            activeChatId:
              state.activeChatId === chatId ? remainingChats[0]?.id ?? "" : state.activeChatId,
            history: pushHistory(state),
          }
        }),
      updateChatMembers: (chatId, memberIds) =>
        set((state) => {
          const validIds = new Set(state.conversation.participants.map((participant) => participant.id))
          const filtered = memberIds.filter((id) => validIds.has(id))
          return {
            conversation: touchMetadata(
              mapChat(state.conversation, chatId, (chat) => ({ ...chat, memberIds: filtered })),
            ),
            history: pushHistory(state),
          }
        }),
      ensureChatMember: (chatId, participantId) =>
        set((state) => {
          const chat = state.conversation.chats.find((entry) => entry.id === chatId)
          if (!chat || chat.memberIds.includes(participantId)) return state
          return {
            conversation: touchMetadata(
              mapChat(state.conversation, chatId, (entry) => ({
                ...entry,
                memberIds: [...entry.memberIds, participantId],
              })),
            ),
            history: pushHistory(state),
          }
        }),
      findOrCreateChatWithMembers: (memberIds, name) => {
        const existing = get().conversation.chats.find((chat) => sameMemberSet(chat.memberIds, memberIds))
        if (existing) return existing.id
        return get().createChat(memberIds, name)
      },
      addMessage: (chatId, payload) =>
        set((state) => ({
          conversation: touchMetadata(
            mapChat(state.conversation, chatId, (chat) => ({
              ...chat,
              messages: [
                ...chat.messages,
                { id: generateId(), ...payload, delayMs: payload.delayMs ?? DEFAULT_MESSAGE_DELAY_MS },
              ],
            })),
          ),
          history: pushHistory(state),
        })),
      updateMessage: (chatId, messageId, updates) =>
        set((state) => ({
          conversation: touchMetadata(
            mapChat(state.conversation, chatId, (chat) => ({
              ...chat,
              messages: chat.messages.map((message) =>
                message.id === messageId ? { ...message, ...updates } : message,
              ),
            })),
          ),
          history: pushHistory(state),
        })),
      deleteMessage: (chatId, messageId) =>
        set((state) => ({
          conversation: touchMetadata(
            mapChat(state.conversation, chatId, (chat) => ({
              ...chat,
              messages: chat.messages.filter((message) => message.id !== messageId),
            })),
          ),
          history: pushHistory(state),
        })),
      duplicateMessage: (chatId, messageId) =>
        set((state) => {
          const chat = state.conversation.chats.find((entry) => entry.id === chatId)
          const message = chat?.messages.find((entry) => entry.id === messageId)
          if (!chat || !message) return state
          const copy: Message = { ...message, id: generateId(), timestamp: new Date().toISOString() }
          return {
            conversation: touchMetadata(
              mapChat(state.conversation, chatId, (entry) => ({ ...entry, messages: [...entry.messages, copy] })),
            ),
            history: pushHistory(state),
          }
        }),
      setMessages: (chatId, messages) =>
        set((state) => ({
          conversation: touchMetadata(mapChat(state.conversation, chatId, (chat) => ({ ...chat, messages }))),
          history: pushHistory(state),
        })),
      bulkUpdateMessages: (chatId, updates) =>
        set((state) => ({
          conversation: touchMetadata({
            ...state.conversation,
            chats: state.conversation.chats.map((chat) =>
              chatId === "all" || chat.id === chatId
                ? { ...chat, messages: chat.messages.map((message) => applyBulkUpdate(message, updates)) }
                : chat,
            ),
          }),
          history: pushHistory(state),
        })),
      setExportSettings: (settings) =>
        set((state) => ({
          exportSettings: {
            ...state.exportSettings,
            ...settings,
          },
          history: pushHistory(state),
        })),
      setUi: (updates) => set((state) => ({ ui: { ...state.ui, ...updates } })),
      addNotificationSenderName: (name) =>
        set((state) => {
          const trimmed = name.trim()
          if (!trimmed) return {}
          const withoutDuplicate = state.notificationSenderNames.filter(
            (existing) => existing.toLowerCase() !== trimmed.toLowerCase(),
          )
          return { notificationSenderNames: [trimmed, ...withoutDuplicate].slice(0, 30) }
        }),
      setLanguage: (language) => set({ language }),
      setDraftMessage: (draft) => set({ draftMessage: draft }),
      resetConversation: () =>
        set((state) => {
          const conversation = buildDefaultConversation()
          return {
            conversation,
            activeChatId: conversation.chats[0]?.id ?? "",
            activeParticipantId: defaultParticipants[0].id,
            layoutId: defaultLayoutId,
            themeId: "light",
            backgroundImageUrl: "",
            backgroundImageOpacity: 0.35,
            backgroundColor: "",
            exportSettings: { ...defaultExportSettings },
            ui: { ...defaultUiState },
            draftMessage: null,
            lastAutosaveAt: null,
            history: pushHistory(state),
          }
        }),
      loadConversation: (conversation) => {
        const normalized = normalizeLoadedConversation(conversation)
        set((state) => ({
          conversation: normalized,
          activeChatId: normalized.chats[0]?.id ?? "",
          activeParticipantId: normalized.participants[0]?.id ?? "",
          history: pushHistory(state),
        }))
      },
      undo: () =>
        set((state) => {
          if (state.history.past.length === 0) return state
          const previous = state.history.past[state.history.past.length - 1]
          return {
            conversation: previous.conversation,
            activeChatId: previous.activeChatId,
            layoutId: previous.layoutId,
            themeId: previous.themeId,
            activeParticipantId: previous.activeParticipantId,
            backgroundImageUrl: previous.backgroundImageUrl,
            backgroundImageOpacity: previous.backgroundImageOpacity,
            backgroundColor: previous.backgroundColor,
            exportSettings: previous.exportSettings,
            history: {
              past: state.history.past.slice(0, -1),
              future: [buildSnapshot(state), ...state.history.future].slice(0, HISTORY_LIMIT),
            },
          }
        }),
      redo: () =>
        set((state) => {
          if (state.history.future.length === 0) return state
          const next = state.history.future[0]
          return {
            conversation: next.conversation,
            activeChatId: next.activeChatId,
            layoutId: next.layoutId,
            themeId: next.themeId,
            activeParticipantId: next.activeParticipantId,
            backgroundImageUrl: next.backgroundImageUrl,
            backgroundImageOpacity: next.backgroundImageOpacity,
            backgroundColor: next.backgroundColor,
            exportSettings: next.exportSettings,
            history: {
              past: [...state.history.past, buildSnapshot(state)].slice(-HISTORY_LIMIT),
              future: state.history.future.slice(1),
            },
          }
        }),
      saveSnapshot: () => {
        const snapshot = get()
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              conversation: snapshot.conversation,
              activeChatId: snapshot.activeChatId,
              layoutId: snapshot.layoutId,
              themeId: snapshot.themeId,
              activeParticipantId: snapshot.activeParticipantId,
              exportSettings: snapshot.exportSettings,
            }),
          )
        } catch (error) {
          console.error("Failed to save snapshot", error)
        }
      },
      clearSnapshot: () => {
        try {
          localStorage.removeItem(STORAGE_KEY)
        } catch (error) {
          console.error("Failed to clear snapshot", error)
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      version: 6,
      migrate: (state) => {
        if (!state) return state
        const typed = state as Record<string, unknown> & {
          conversation: Record<string, unknown>
          activeChatId?: string
          exportSettings?: Partial<ExportSettings>
        }
        const conversation = normalizeLoadedConversation(typed.conversation as Conversation)
        return {
          ...typed,
          conversation,
          activeChatId: typed.activeChatId ?? conversation.chats[0]?.id ?? "",
          exportSettings: {
            ...defaultExportSettings,
            ...typed.exportSettings,
          },
        }
      },
      partialize: (state) => ({
        conversation: state.conversation,
        activeChatId: state.activeChatId,
        layoutId: state.layoutId,
        themeId: state.themeId,
        activeParticipantId: state.activeParticipantId,
        backgroundImageUrl: state.backgroundImageUrl,
        backgroundImageOpacity: state.backgroundImageOpacity,
        backgroundColor: state.backgroundColor,
        exportSettings: state.exportSettings,
        lastAutosaveAt: state.lastAutosaveAt,
        notificationSenderNames: state.notificationSenderNames,
        language: state.language,
      }),
    },
  ),
)
