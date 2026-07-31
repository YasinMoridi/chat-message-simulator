import { useEffect, useMemo, useRef, useState } from "react"
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS, type Transform } from "@dnd-kit/utilities"
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import type { Message, MessageStatus, MessageType } from "@/types/message"
import type { Participant } from "@/types/conversation"
import {
  DEFAULT_MESSAGE_DELAY_MS,
  DEFAULT_NOTIFICATION_OPEN_DELAY_MS,
  DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS,
} from "@/types/message"
import { useConversationStore } from "@/store/conversationStore"
import { MessageForm, type AvailableChatOption } from "@/components/editor/MessageForm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/utils/cn"
import { formatTimestamp, generateId, getChatMembers, getChatTitle } from "@/utils/helpers"
import { parseConversationTranscript } from "@/utils/transcriptImport"
import { useTranslation } from "@/i18n/useTranslation"
import type { TranslationTree } from "@/i18n/translations"

const toDateInputValue = (iso: string) => {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

/** Colors cycled through when easy mode auto-creates a participant for a name it doesn't recognize. */
const EASY_MODE_PARTICIPANT_COLORS = ["#22c55e", "#0b84ff", "#f97316", "#a855f7", "#ef4444", "#14b8a6"]
const pickEasyModeParticipantColor = (participantCount: number) =>
  EASY_MODE_PARTICIPANT_COLORS[participantCount % EASY_MODE_PARTICIPANT_COLORS.length]

/** A line that starts a new entry: "Name: message" (name can't contain ":", "[", "]", or start with < / >). */
const NAMED_LINE_REGEX = /^([^\s:<>[\]][^:[\]]*):\s*(.*)$/

/** Tokenizes a `[...]` tag block, respecting "quoted values with spaces". */
const TAG_TOKEN_REGEX = /(?:[^\s"]+|"[^"]*")+/g

type EasyTags = Record<string, string | true>

/** Splits "content [tag tag=value]" into { text, tagBlock }. tagBlock is null if there's no trailing bracket. */
const splitTrailingTagBlock = (line: string): { text: string; tagBlock: string | null } => {
  const match = line.match(/^([\s\S]*?)(?:\s*\[([^[\]]*)\])?$/)
  if (!match) return { text: line, tagBlock: null }
  return { text: (match[1] ?? "").trimEnd(), tagBlock: match[2] ?? null }
}

const parseEasyTags = (tagBlock: string): EasyTags => {
  const tokens = tagBlock.match(TAG_TOKEN_REGEX) ?? []
  const tags: EasyTags = {}
  tokens.forEach((token) => {
    const cleaned = token.replace(/"/g, "")
    const eqIndex = cleaned.indexOf("=")
    if (eqIndex === -1) {
      tags[cleaned.toLowerCase()] = true
    } else {
      tags[cleaned.slice(0, eqIndex).toLowerCase()] = cleaned.slice(eqIndex + 1)
    }
  })
  return tags
}

/** Wraps a tag value in quotes if it contains whitespace, so it round-trips through parseEasyTags. */
const quoteTagValue = (value: string) => (/\s/.test(value) ? `"${value}"` : value)

interface EasyMessageFields {
  type: MessageType
  status: MessageStatus
  delayMs: number
  isHidden?: boolean
  imageUrl?: string
  notificationOverride?: Message["notificationOverride"]
  notificationClickable?: boolean
  notificationOpenDelayMs?: number
  notificationAutoOpen?: boolean
  notificationAutoOpenDelayMs?: number
  /** Raw `link=Name` value from the tag block - resolved to a chat id by the caller. */
  linkedChatName?: string
  returnToParent?: boolean
}

/** Turns a parsed tag map into the full set of message fields easy mode understands. */
const fieldsFromEasyTags = (tags: EasyTags): EasyMessageFields => {
  let type: MessageType = "text"
  const validTypes: MessageType[] = ["text", "system", "image", "notification"]
  if (typeof tags.type === "string" && validTypes.includes(tags.type.toLowerCase() as MessageType)) {
    type = tags.type.toLowerCase() as MessageType
  } else if (tags.notification) type = "notification"
  else if (tags.system) type = "system"
  else if (tags.image) type = "image"

  let status: MessageStatus = "sent"
  if (typeof tags.status === "string") {
    const lowered = tags.status.toLowerCase()
    if (lowered === "sent" || lowered === "delivered" || lowered === "read") status = lowered
  }

  let delayMs = DEFAULT_MESSAGE_DELAY_MS
  if (typeof tags.delay === "string") {
    const seconds = Number(tags.delay)
    if (!Number.isNaN(seconds) && seconds >= 0) delayMs = Math.round(seconds * 1000)
  }

  const isHidden = tags.hidden === true ? true : undefined
  const imageUrl = type === "image" && typeof tags.image === "string" ? tags.image : undefined

  const overrideSenderName = typeof tags.as === "string" ? tags.as : undefined
  const overrideAppName = typeof tags.app === "string" ? tags.app : undefined
  const overrideAvatarUrl = typeof tags.avatar === "string" ? tags.avatar : undefined
  const notificationOverride =
    type === "notification" && (overrideSenderName || overrideAppName || overrideAvatarUrl)
      ? {
          enabled: true,
          senderName: overrideSenderName,
          appName: overrideAppName,
          avatarUrl: overrideAvatarUrl,
        }
      : undefined

  const hasClickable = Boolean(tags.clickable || tags.opens || tags.auto)
  const notificationClickable = type === "notification" && hasClickable ? true : undefined

  let notificationOpenDelayMs: number | undefined
  if (type === "notification" && hasClickable) {
    const seconds = typeof tags.opens === "string" ? Number(tags.opens) : NaN
    notificationOpenDelayMs =
      !Number.isNaN(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : DEFAULT_NOTIFICATION_OPEN_DELAY_MS
  }

  let notificationAutoOpen: boolean | undefined
  let notificationAutoOpenDelayMs: number | undefined
  if (type === "notification" && tags.auto) {
    notificationAutoOpen = true
    const seconds = typeof tags.auto === "string" ? Number(tags.auto) : NaN
    notificationAutoOpenDelayMs =
      !Number.isNaN(seconds) && seconds >= 0
        ? Math.round(seconds * 1000)
        : DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS
  }

  const linkedChatName =
    type === "notification" && hasClickable && typeof tags.link === "string" && tags.link.trim()
      ? tags.link.trim()
      : undefined

  const returnToParent = tags.return === true ? true : undefined

  return {
    type,
    status,
    delayMs,
    isHidden,
    imageUrl,
    notificationOverride,
    notificationClickable,
    notificationOpenDelayMs,
    notificationAutoOpen,
    notificationAutoOpenDelayMs,
    linkedChatName,
    returnToParent,
  }
}

/** The inverse of fieldsFromEasyTags - only emits tags for values that differ from the defaults. */
const easyTagsFromMessage = (
  message: Message,
  participants: Participant[],
  chatTitleById: Map<string, string>,
): string => {
  const tags: string[] = []
  if (message.type === "notification") tags.push("notification")
  else if (message.type === "system") tags.push("system")
  else if (message.type === "image") {
    tags.push(`image=${quoteTagValue(message.imageUrl ?? "")}`)
  }

  const delayMs = message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS
  if (delayMs !== DEFAULT_MESSAGE_DELAY_MS) {
    tags.push(`delay=${delayMs / 1000}`)
  }
  if (message.status !== "sent") tags.push(`status=${message.status}`)
  if (message.isHidden) tags.push("hidden")
  if (message.returnToParent) tags.push("return")

  if (message.type === "notification") {
    if (message.notificationClickable) tags.push("clickable")
    if (message.notificationClickable) {
      const opensMs = message.notificationOpenDelayMs ?? DEFAULT_NOTIFICATION_OPEN_DELAY_MS
      if (opensMs !== DEFAULT_NOTIFICATION_OPEN_DELAY_MS) tags.push(`opens=${opensMs / 1000}`)
    }
    if (message.notificationAutoOpen) {
      const autoMs = message.notificationAutoOpenDelayMs ?? DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS
      tags.push(`auto=${autoMs / 1000}`)
    }
    if (message.notificationOverride?.enabled) {
      if (message.notificationOverride.senderName) {
        tags.push(`as=${quoteTagValue(message.notificationOverride.senderName)}`)
      }
      if (message.notificationOverride.appName) {
        tags.push(`app=${quoteTagValue(message.notificationOverride.appName)}`)
      }
      if (message.notificationOverride.avatarUrl) {
        tags.push(`avatar=${quoteTagValue(message.notificationOverride.avatarUrl)}`)
      }
    }
    if (message.notificationClickable && message.linkedChatId) {
      const title = chatTitleById.get(message.linkedChatId)
      if (title) tags.push(`link=${quoteTagValue(title)}`)
    }
  }

  void participants
  return tags.length ? `[${tags.join(" ")}]` : ""
}

const MessageRow = ({
  message,
  onEdit,
  onDelete,
  isActionsOpen,
  onToggleActions,
  t,
}: {
  message: Message
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onToggleVisibility: () => void
  isActionsOpen: boolean
  onToggleActions: () => void
  t: TranslationTree
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: message.id,
    animateLayoutChanges: () => false,
  })

  const isHidden = Boolean(message.isHidden)
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: "none",
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm hover:bg-slate-50",
        isHidden && "bg-slate-50 text-slate-500",
        isDragging && "ring-2 ring-slate-900/20",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        className="hidden cursor-grab sm:inline-flex"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </Button>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "text-sm font-medium break-words whitespace-normal sm:truncate",
            isHidden ? "text-slate-500" : "text-slate-900",
          )}
          title={message.content}
        >
          {message.content}
        </div>
        <div className="text-xs text-slate-500">
          {message.type} - {formatTimestamp(message.timestamp)}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          <span className="sr-only">{t.builder.edit}</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="hidden sm:inline-flex" onClick={onDelete}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.builder.delete}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon"
          className={cn(isActionsOpen && "bg-slate-100")}
          onClick={onToggleActions}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">{t.builder.moreActions}</span>
        </Button>
      </div>
    </div>
  )
}

export const ConversationBuilder = () => {
  const { t } = useTranslation()
  const conversation = useConversationStore((state) => state.conversation)
  const { participants, chats } = conversation
  const activeChatId = useConversationStore((state) => state.activeChatId)
  const setActiveChatId = useConversationStore((state) => state.setActiveChatId)
  const activeParticipantId = useConversationStore((state) => state.activeParticipantId)
  const addParticipant = useConversationStore((state) => state.addParticipant)
  const createChat = useConversationStore((state) => state.createChat)
  const ensureChatMember = useConversationStore((state) => state.ensureChatMember)
  const findOrCreateChatWithMembers = useConversationStore((state) => state.findOrCreateChatWithMembers)
  const addMessageAction = useConversationStore((state) => state.addMessage)
  const updateMessageAction = useConversationStore((state) => state.updateMessage)
  const deleteMessageAction = useConversationStore((state) => state.deleteMessage)
  const duplicateMessageAction = useConversationStore((state) => state.duplicateMessage)
  const setMessagesAction = useConversationStore((state) => state.setMessages)
  const loadConversation = useConversationStore((state) => state.loadConversation)

  // Fall back to the first chat if the one that was open got deleted (or
  // nothing has ever been selected yet).
  useEffect(() => {
    if (chats.some((chat) => chat.id === activeChatId)) return
    if (chats[0]) setActiveChatId(chats[0].id)
  }, [chats, activeChatId, setActiveChatId])

  const activeChat = chats.find((chat) => chat.id === activeChatId) ?? chats[0] ?? null
  const chatMembers = useMemo(
    () => (activeChat ? getChatMembers(conversation, activeChat) : []),
    [conversation, activeChat],
  )

  // Every chat, offered as a notification's or back-navigation's link
  // target - including the one currently open, since nothing stops a
  // message from (unusually) linking back to its own chat.
  const availableChats: AvailableChatOption[] = useMemo(
    () =>
      chats.map((chat) => {
        const members = getChatMembers(conversation, chat)
        const isDirect = members.length === 2
        const title = getChatTitle(members, chat.name)
        return {
          id: chat.id,
          label: isDirect ? `${t.builder.chatWithPrefix} ${title}` : title,
        }
      }),
    [chats, conversation, t.builder.chatWithPrefix],
  )
  const chatTitleById = useMemo(
    () => new Map(availableChats.map((chat) => [chat.id, chat.label])),
    [availableChats],
  )

  const [editingId, setEditingId] = useState<string | null>(null)
  const [openActionsId, setOpenActionsId] = useState<string | null>(null)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [viewMode, setViewMode] = useState<"standard" | "easy" | "transcript">("standard")
  const [easyInput, setEasyInput] = useState("")
  const [easyError, setEasyError] = useState<string | null>(null)
  const [transcriptInput, setTranscriptInput] = useState("")
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const [transcriptWarnings, setTranscriptWarnings] = useState<string[]>([])
  const transcriptFileInputRef = useRef<HTMLInputElement | null>(null)
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  // Create-chat dialog state.
  const [isCreateChatOpen, setIsCreateChatOpen] = useState(false)
  const [newChatMemberIds, setNewChatMemberIds] = useState<string[]>([])
  const [newChatName, setNewChatName] = useState("")

  const openCreateChatDialog = () => {
    setNewChatMemberIds([])
    setNewChatName("")
    setIsCreateChatOpen(true)
  }

  const handleCreateChat = () => {
    if (newChatMemberIds.length === 0) return
    const id = createChat(newChatMemberIds, newChatName)
    setActiveChatId(id)
    setIsCreateChatOpen(false)
    setEditingId(null)
    setOpenActionsId(null)
    setIsAddOpen(false)
  }

  const messages = activeChat?.messages ?? []
  const setMessages = (next: Message[]) => {
    if (activeChat) setMessagesAction(activeChat.id, next)
  }
  const addMessage = (payload: Parameters<typeof addMessageAction>[1]) => {
    if (activeChat) addMessageAction(activeChat.id, payload)
  }
  const updateMessage = (messageId: string, updates: Partial<Message>) => {
    if (activeChat) updateMessageAction(activeChat.id, messageId, updates)
  }
  const deleteMessage = (messageId: string) => {
    if (activeChat) deleteMessageAction(activeChat.id, messageId)
  }
  const duplicateMessage = (messageId: string) => {
    if (activeChat) duplicateMessageAction(activeChat.id, messageId)
  }

  const { globalDate, hasMixedDates } = useMemo(() => {
    if (messages.length === 0) {
      return { globalDate: "", hasMixedDates: false }
    }
    const dateValues = messages.map((message) => toDateInputValue(message.timestamp))
    const uniqueDates = new Set(dateValues)
    return {
      globalDate: uniqueDates.size === 1 ? dateValues[0] : "",
      hasMixedDates: uniqueDates.size > 1,
    }
  }, [messages])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
  )

  const restrictToVerticalAxis = ({ transform }: { transform: Transform }) => ({
    ...transform,
    x: 0,
  })

  const moveMessage = (messageId: string, direction: -1 | 1) => {
    const index = messages.findIndex((message) => message.id === messageId)
    const targetIndex = index + direction
    if (index === -1 || targetIndex < 0 || targetIndex >= messages.length) return
    setMessages(arrayMove(messages, index, targetIndex))
  }

  const handleGlobalDateChange = (value: string) => {
    if (!value || messages.length === 0) return
    const target = new Date(`${value}T00:00`)
    if (Number.isNaN(target.getTime())) return
    setMessages(
      messages.map((message) => {
        const current = new Date(message.timestamp)
        if (Number.isNaN(current.getTime())) return message
        const updated = new Date(current)
        updated.setFullYear(target.getFullYear(), target.getMonth(), target.getDate())
        return { ...message, timestamp: updated.toISOString() }
      }),
    )
  }

  // Who "<" stands for in the currently active chat.
  const threadSelfId = chatMembers.some((member) => member.id === activeParticipantId)
    ? activeParticipantId
    : chatMembers[0]?.id ?? ""

  const resolveReceiverId = () =>
    chatMembers.find((participant) => participant.id !== threadSelfId)?.id ?? chatMembers[0]?.id ?? ""

  const showToast = (message: string, tone: "success" | "error" = "success") => {
    setToast({ message, tone })
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, 2400)
  }

  useEffect(
    () => () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    },
    [],
  )

  const buildEasyTextForMessages = (msgs: Message[]) =>
    msgs
      .map((message) => {
        const participant = participants.find((candidate) => candidate.id === message.senderId)
        const marker = participant ? `${participant.name}:` : "Unknown:"
        const tagsStr = easyTagsFromMessage(message, participants, chatTitleById)
        return [marker, message.content, tagsStr].filter((part) => part !== "").join(" ")
      })
      .join("\n")

  const buildEasyText = () => buildEasyTextForMessages(messages)

  // The whole story in one file: every chat, each under its own heading -
  // so exporting for translation doesn't lose anything sitting in another tab.
  const buildFullEasyExportText = () =>
    chats
      .map((chat) => {
        const title = chatTitleById.get(chat.id) ?? chat.name ?? t.builder.newChat
        return `# ${title}\n${buildEasyTextForMessages(chat.messages)}`
      })
      .join("\n\n")

  const handleExportEasyText = () => {
    const text = buildFullEasyExportText()
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${(activeChat?.name || "conversation").trim().replace(/\s+/g, "-").toLowerCase()}-easy.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    showToast(t.builder.easyModeExported)
  }

  const handleViewModeChange = (mode: "standard" | "easy" | "transcript") => {
    setEditingId(null)
    setOpenActionsId(null)
    setEasyError(null)
    if (mode === "easy") {
      setEasyInput(buildEasyText())
    }
    if (mode === "transcript") {
      setTranscriptError(null)
      setTranscriptWarnings([])
    }
    setViewMode(mode)
  }

  // Full-project rebuild from a narrative .txt transcript (paste or file
  // upload) - unlike easy mode, this replaces everything: every
  // participant and every chat.
  const handleApplyTranscript = () => {
    if (!transcriptInput.trim()) {
      setTranscriptError(t.builder.transcriptEmpty)
      return
    }
    if (!window.confirm(t.builder.transcriptConfirmOverwrite)) return
    try {
      const { conversation: parsed, warnings } = parseConversationTranscript(transcriptInput)
      loadConversation(parsed)
      setTranscriptError(null)
      setTranscriptWarnings(warnings)
      setViewMode("standard")
      showToast(warnings.length > 0 ? t.builder.transcriptAppliedWithWarnings : t.builder.transcriptApplied)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setTranscriptError(`${t.builder.transcriptParseError}: ${message}`)
      showToast(t.builder.transcriptParseError, "error")
    }
  }

  const handleTranscriptFileChange = async (file: File | null) => {
    if (!file) return
    try {
      const text = await file.text()
      setTranscriptInput(text)
      setTranscriptError(null)
    } catch {
      setTranscriptError(t.builder.transcriptParseError)
    }
  }

  const handleEasyApply = () => {
    if (!activeChat || !threadSelfId) {
      setEasyError(t.builder.easyModeAtLeastOneParticipant)
      showToast(t.builder.easyModeAtLeastOneParticipant, "error")
      return
    }

    type RawEntry = { marker: string; textParts: string[]; tags: EasyTags }
    const rawEntries: RawEntry[] = []
    let hadContinuationWithoutEntry = false

    easyInput.split("\n").forEach((rawLine) => {
      const trimmed = rawLine.trim()
      if (!trimmed) return

      let marker: string | null = null
      let rest = ""
      const namedMatch = trimmed.match(NAMED_LINE_REGEX)
      if (namedMatch) {
        marker = namedMatch[1].trim()
        rest = namedMatch[2]
      }

      const { text, tagBlock } = splitTrailingTagBlock(marker === null ? trimmed : rest)
      const tags = tagBlock !== null ? parseEasyTags(tagBlock) : {}

      if (marker !== null) {
        rawEntries.push({ marker, textParts: text ? [text] : [], tags })
        return
      }

      if (rawEntries.length === 0) {
        hadContinuationWithoutEntry = true
        return
      }
      const last = rawEntries[rawEntries.length - 1]
      if (text) last.textParts.push(text)
      Object.assign(last.tags, tags)
    })

    if (hadContinuationWithoutEntry || rawEntries.length === 0) {
      setEasyError(t.builder.easyModeStartLine)
      showToast(t.builder.easyModeStartLine, "error")
      return
    }

    // Auto-create a participant for any name that isn't already one of ours.
    const nameToId = new Map<string, string>()
    participants.forEach((participant) => nameToId.set(participant.name.trim().toLowerCase(), participant.id))
    rawEntries.forEach((entry) => {
      const key = entry.marker.toLowerCase()
      if (nameToId.has(key)) return
      addParticipant({
        name: entry.marker,
        status: "online",
        color: pickEasyModeParticipantColor(nameToId.size),
      })
      const created = useConversationStore.getState().conversation.participants.at(-1)
      if (created) nameToId.set(key, created.id)
    })
    // Everyone the script actually gives a line to is chatting in this chat,
    // whether they were just created or already existed as a benched
    // roster character.
    const usedKeys = new Set(rawEntries.map((entry) => entry.marker.toLowerCase()))
    usedKeys.forEach((key) => {
      const participantId = nameToId.get(key)
      if (participantId) ensureChatMember(activeChat.id, participantId)
    })

    // Auto-create a participant for any `link=Name` notification target
    // that isn't already on the roster (a chat name it already matches
    // takes priority and doesn't need one).
    const chatTitlesLower = new Map(availableChats.map((chat) => [chat.label.toLowerCase(), chat.id]))
    rawEntries.forEach((entry) => {
      const linkName = typeof entry.tags.link === "string" ? entry.tags.link.trim() : ""
      if (!linkName) return
      if (chatTitlesLower.has(linkName.toLowerCase())) return
      const key = linkName.toLowerCase()
      if (nameToId.has(key)) return
      addParticipant({
        name: linkName,
        status: "online",
        color: pickEasyModeParticipantColor(nameToId.size),
      })
      const created = useConversationStore.getState().conversation.participants.at(-1)
      if (created) nameToId.set(key, created.id)
    })

    const finalEntries: Array<
      { senderId: string; content: string; linkedChatId?: string } & EasyMessageFields
    > = []

    rawEntries.forEach((entry) => {
      const senderId = nameToId.get(entry.marker.toLowerCase())
      if (!senderId) return

      const fields = fieldsFromEasyTags(entry.tags)
      const content = entry.textParts.filter(Boolean).join("\n")
      if (!content && fields.type !== "image") return

      // `link=` resolves to an existing chat by title first; failing that,
      // to a (auto-created if needed) direct chat between "you" and the
      // named participant - same convenience the old per-participant
      // side-chats offered.
      let linkedChatId: string | undefined
      if (fields.linkedChatName) {
        const byTitle = chatTitlesLower.get(fields.linkedChatName.toLowerCase())
        if (byTitle) {
          linkedChatId = byTitle
        } else {
          const participantId = nameToId.get(fields.linkedChatName.toLowerCase())
          if (participantId) {
            linkedChatId = useConversationStore
              .getState()
              .findOrCreateChatWithMembers([threadSelfId, participantId])
          }
        }
      }

      finalEntries.push({ senderId, content, linkedChatId, ...fields })
    })

    if (finalEntries.length === 0) {
      setEasyError(t.builder.easyModeNothingToApply)
      showToast(t.builder.easyModeNothingToApply, "error")
      return
    }

    const now = Date.now()
    const nextMessages: Message[] = finalEntries.map((entry, index) => {
      const existing = messages[index]
      return {
        id: existing?.id ?? generateId(),
        timestamp: existing?.timestamp ?? new Date(now + index * 1000).toISOString(),
        senderId: entry.senderId,
        content: entry.content,
        imageUrl: entry.imageUrl,
        type: entry.type,
        status: entry.status,
        delayMs: entry.delayMs,
        isHidden: entry.isHidden,
        notificationOverride: entry.notificationOverride,
        notificationClickable: entry.notificationClickable,
        notificationOpenDelayMs: entry.notificationOpenDelayMs,
        notificationAutoOpen: entry.notificationAutoOpen,
        notificationAutoOpenDelayMs: entry.notificationAutoOpenDelayMs,
        linkedChatId: entry.linkedChatId,
        returnToParent: entry.returnToParent,
      }
    })

    setMessages(nextMessages)
    setEasyError(null)
    showToast(t.builder.easyModeApplied)
  }

  const hasHidden = messages.some((message) => message.isHidden)
  const hasVisible = messages.some((message) => !message.isHidden)
  const activeParticipant = participants.find((participant) => participant.id === threadSelfId)
  const receiverParticipant = participants.find(
    (participant) => participant.id === resolveReceiverId(),
  )

  const handleChatTabChange = (chatId: string) => {
    if (chatId === activeChatId) return
    setActiveChatId(chatId)
    setEditingId(null)
    setOpenActionsId(null)
    setIsAddOpen(false)
    setEasyError(null)
    if (viewMode === "easy") setEasyInput("")
  }

  const chatTabLabel = (chatId: string) => availableChats.find((chat) => chat.id === chatId)?.label ?? ""

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {activeChat ? chatTabLabel(activeChat.id) : t.builder.title}
          </h3>
          <p className="text-xs text-slate-500">{t.builder.subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={openCreateChatDialog}
            disabled={participants.length === 0}
          >
            <Plus className="h-3.5 w-3.5" />
            {t.builder.newChat}
          </Button>
          {chats.map((chat) => (
            <Button
              key={chat.id}
              type="button"
              size="sm"
              variant={activeChatId === chat.id ? "default" : "outline"}
              onClick={() => handleChatTabChange(chat.id)}
            >
              {chatTabLabel(chat.id)}
            </Button>
          ))}
        </div>

        {!activeChat ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
            {participants.length === 0 ? t.builder.noParticipantsYet : t.builder.noChatsYet}
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t.builder.messagesLabel}</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-slate-500">{messages.length} {t.builder.total}</span>
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <Label className="text-[10px] uppercase text-slate-400">{t.builder.globalDate}</Label>
                    <Input
                      type="date"
                      value={globalDate}
                      onChange={(event) => handleGlobalDateChange(event.target.value)}
                      className="h-8 w-[145px] text-xs"
                      disabled={messages.length === 0}
                    />
                    <span className="text-xs text-slate-400">
                      {hasMixedDates ? t.builder.mixedDates : t.builder.keepsTimeOfDay}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setMessages(messages.map((message) => ({ ...message, isHidden: true })))
                    }
                    disabled={!hasVisible}
                  >
                    {t.builder.hideAll}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setMessages(messages.map((message) => ({ ...message, isHidden: false })))
                    }
                    disabled={!hasHidden}
                  >
                    {t.builder.showAll}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                <div className="space-y-1">
                  <div className="text-xs font-semibold uppercase text-slate-400">{t.builder.editorView}</div>
                  <p className="text-xs text-slate-500">{t.builder.editorViewDescription}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={viewMode === "standard" ? "default" : "outline"}
                    onClick={() => handleViewModeChange("standard")}
                  >
                    {t.builder.standard}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={viewMode === "easy" ? "default" : "outline"}
                    onClick={() => handleViewModeChange("easy")}
                  >
                    {t.builder.easy}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={viewMode === "transcript" ? "default" : "outline"}
                    onClick={() => handleViewModeChange("transcript")}
                  >
                    {t.builder.transcript}
                  </Button>
                </div>
              </div>
              {viewMode === "transcript" ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <Label className="text-xs uppercase text-slate-400">{t.builder.transcriptEditor}</Label>
                  <p className="mt-1 text-xs text-slate-500">{t.builder.transcriptEditorDescription}</p>
                  <div className="mt-3 space-y-2">
                    <input
                      ref={transcriptFileInputRef}
                      type="file"
                      accept=".txt,text/plain"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0] ?? null
                        void handleTranscriptFileChange(file)
                        event.target.value = ""
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => transcriptFileInputRef.current?.click()}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      {t.builder.transcriptUploadButton}
                    </Button>
                    <Textarea
                      value={transcriptInput}
                      onChange={(event) => {
                        setTranscriptInput(event.target.value)
                        if (transcriptError) setTranscriptError(null)
                      }}
                      placeholder={t.builder.transcriptPastePlaceholder}
                      className="min-h-[280px] resize-y font-mono"
                      dir="auto"
                    />
                    {transcriptError ? (
                      <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{transcriptError}</div>
                    ) : null}
                    {transcriptWarnings.length > 0 ? (
                      <div className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        <div className="font-semibold">{t.builder.transcriptWarningsTitle}</div>
                        <ul className="list-disc space-y-0.5 pr-4">
                          {transcriptWarnings.map((warning, index) => (
                            <li key={index}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={handleApplyTranscript}>
                      {t.builder.transcriptApply}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setTranscriptInput("")
                        setTranscriptError(null)
                        setTranscriptWarnings([])
                      }}
                    >
                      {t.builder.clear}
                    </Button>
                  </div>
                </div>
              ) : viewMode === "easy" ? (
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Label className="text-xs uppercase text-slate-400">{t.builder.easyEditor}</Label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="gap-1.5"
                        onClick={handleExportEasyText}
                      >
                        <Download className="h-3.5 w-3.5" />
                        {t.builder.exportEasyTxt}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEasyInput(buildEasyText())}
                      >
                        {t.builder.refresh}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-2">
                    <Textarea
                      value={easyInput}
                      onChange={(event) => {
                        setEasyInput(event.target.value)
                        if (easyError) setEasyError(null)
                      }}
                      placeholder={`${activeParticipant?.name ?? "Sender"}: message\n${receiverParticipant?.name ?? "Receiver"}: message\nSarah: hi, joining the chat\n${receiverParticipant?.name ?? "Receiver"}: Delivery update [notification clickable auto=1.5 opens=0.7 as="Sarah" app=Instagram link="Sarah"]`}
                      className="min-h-[280px] resize-y font-mono"
                    />
                    <div className="space-y-1 text-xs text-slate-500">
                      <p>
                        Start every line with <span className="font-semibold">Name:</span>{t.builder.easyHelpNameNote}
                      </p>
                      <p>
                        {t.builder.easyHelpTagsIntro}{" "}
                        <span className="font-mono font-semibold">[brackets]</span>{t.builder.easyHelpTagsBody}
                        <span className="font-mono">notification</span> /{" "}
                        <span className="font-mono">system</span> /{" "}
                        <span className="font-mono">image=url</span>; delivery -{" "}
                        <span className="font-mono">delay=2</span> (seconds),{" "}
                        <span className="font-mono">status=read</span>,{" "}
                        <span className="font-mono">hidden</span>; and for notifications -{" "}
                        <span className="font-mono">clickable</span>,{" "}
                        <span className="font-mono">opens=0.7</span> (seconds to open after tap),{" "}
                        <span className="font-mono">auto=1.5</span> (auto-taps itself after this many
                        seconds, no click needed),{" "}
                        <span className="font-mono">as="Name"</span>,{" "}
                        <span className="font-mono">app="App"</span>,{" "}
                        <span className="font-mono">avatar=url</span>,{" "}
                        <span className="font-mono">link="Name"</span> (opens a separate chat with
                        that person, or an existing chat with that title, when tapped). Example:{" "}
                        <span className="font-mono">
                          {receiverParticipant?.name ?? "Receiver"}: New message [notification clickable auto=1.5 as="Sarah" link="Sarah"]
                        </span>
                      </p>
                    </div>
                    {easyError ? (
                      <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
                        {easyError}
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={handleEasyApply}>
                      {t.builder.applyChanges}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        setEasyInput("")
                        setEasyError(null)
                      }}
                    >
                      {t.builder.clear}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {messages.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                      {t.builder.noMessagesYet}
                    </div>
                  ) : null}
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictToVerticalAxis]}
                    onDragEnd={({ active, over }) => {
                      if (!over || active.id === over.id) return
                      const oldIndex = messages.findIndex((message) => message.id === active.id)
                      const newIndex = messages.findIndex((message) => message.id === over.id)
                      if (oldIndex === -1 || newIndex === -1) return
                      setMessages(arrayMove(messages, oldIndex, newIndex))
                    }}
                  >
                    <SortableContext
                      items={messages.map((message) => message.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-2">
                        {messages.map((message) => {
                          const canMoveUp = messages[0]?.id !== message.id
                          const canMoveDown = messages[messages.length - 1]?.id !== message.id
                          const isActionsOpen = openActionsId === message.id
                          return (
                            <div key={message.id} className="space-y-2">
                              <MessageRow
                                message={message}
                                t={t}
                                onEdit={() => {
                                  setEditingId(message.id)
                                  setIsAdvancedOpen(false)
                                  setOpenActionsId(null)
                                }}
                                onToggleVisibility={() =>
                                  updateMessage(message.id, { isHidden: !message.isHidden })
                                }
                                onDuplicate={() => {
                                  duplicateMessage(message.id)
                                  setOpenActionsId(null)
                                }}
                                onDelete={() => {
                                  deleteMessage(message.id)
                                  setOpenActionsId(null)
                                }}
                                isActionsOpen={isActionsOpen}
                                onToggleActions={() =>
                                  setOpenActionsId((current) => (current === message.id ? null : message.id))
                                }
                              />
                              {isActionsOpen ? (
                                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
                                  <div className="flex items-center gap-1 sm:hidden">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => moveMessage(message.id, -1)}
                                      disabled={!canMoveUp}
                                    >
                                      <ArrowUp className="h-4 w-4" />
                                      <span className="sr-only">{t.builder.moveUp}</span>
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => moveMessage(message.id, 1)}
                                      disabled={!canMoveDown}
                                    >
                                      <ArrowDown className="h-4 w-4" />
                                      <span className="sr-only">{t.builder.moveDown}</span>
                                    </Button>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      updateMessage(message.id, { isHidden: !message.isHidden })
                                      setOpenActionsId(null)
                                    }}
                                  >
                                    {message.isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                                    {message.isHidden ? t.builder.showInChat : t.builder.hideFromChat}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                      duplicateMessage(message.id)
                                      setOpenActionsId(null)
                                    }}
                                  >
                                    <Copy className="h-4 w-4" />
                                    {t.builder.duplicate}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="sm:hidden"
                                    onClick={() => {
                                      deleteMessage(message.id)
                                      setOpenActionsId(null)
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    {t.builder.delete}
                                  </Button>
                                </div>
                              ) : null}
                              {editingId === message.id ? (
                                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                  <MessageForm
                                    key={message.id}
                                    participants={chatMembers}
                                    availableChats={availableChats}
                                    initial={message}
                                    defaultSenderId={activeParticipantId}
                                    compact
                                    advancedOpen={isAdvancedOpen}
                                    onToggleAdvanced={() => setIsAdvancedOpen((prev) => !prev)}
                                    onJumpToLinkedChat={handleChatTabChange}
                                    onSubmit={(payload) => {
                                      updateMessage(message.id, payload)
                                      setEditingId(null)
                                    }}
                                    onCancel={() => setEditingId(null)}
                                    submitLabel={t.messageForm.saveChanges}
                                  />
                                </div>
                              ) : null}
                            </div>
                          )
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                </>
              )}
            </div>
            {viewMode === "standard" ? (
              <>
                <Separator />
                <div className="space-y-3">
                  {isAddOpen ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <MessageForm
                        key={`new-${activeChat.id}`}
                        participants={chatMembers}
                        availableChats={availableChats}
                        initial={null}
                        defaultSenderId={activeParticipantId}
                        compact
                        resetOnSubmit
                        onJumpToLinkedChat={handleChatTabChange}
                        onSubmit={(payload) => {
                          addMessage(payload)
                        }}
                        submitLabel={t.messageForm.addMessage}
                      />
                    </div>
                  ) : null}
                  <Button
                    type="button"
                    className="w-full"
                    variant={isAddOpen ? "outline" : "default"}
                    onClick={() => setIsAddOpen((prev) => !prev)}
                  >
                    {isAddOpen ? t.builder.hideAddMessage : t.messageForm.addMessage}
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>

      <Dialog open={isCreateChatOpen} onOpenChange={setIsCreateChatOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.builder.createChatTitle}</DialogTitle>
            <DialogDescription>{t.builder.createChatDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase text-slate-400">{t.builder.chatNameLabel}</Label>
              <Input
                value={newChatName}
                onChange={(event) => setNewChatName(event.target.value)}
                placeholder={t.builder.chatNamePlaceholder}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs uppercase text-slate-400">{t.builder.selectMembersLabel}</Label>
              {participants.length === 0 ? (
                <p className="text-xs text-slate-500">{t.builder.noParticipantsYet}</p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto">
                  {participants.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                    >
                      <span className="text-sm text-slate-700">{participant.name}</span>
                      <Switch
                        checked={newChatMemberIds.includes(participant.id)}
                        onCheckedChange={(checked) =>
                          setNewChatMemberIds((prev) =>
                            checked ? [...prev, participant.id] : prev.filter((id) => id !== participant.id),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setIsCreateChatOpen(false)}>
                {t.builder.createChatCancel}
              </Button>
              <Button onClick={handleCreateChat} disabled={newChatMemberIds.length === 0}>
                {t.builder.createChatSubmit}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {toast ? (
        <div
          className="pointer-events-none fixed top-5 left-1/2 z-50 w-[90%] -translate-x-1/2 sm:w-auto"
          aria-live="polite"
        >
          <div
            className={cn(
              "rounded-full px-4 py-2 text-sm font-medium shadow-lg",
              toast.tone === "success"
                ? "bg-emerald-500 text-white"
                : "bg-red-600 text-white",
            )}
          >
            {toast.message}
          </div>
        </div>
      ) : null}
    </TooltipProvider>
  )
}
