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
import { getSelfParticipantId } from "@/components/layout/ChatLayout"
import { MessageForm } from "@/components/editor/MessageForm"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/utils/cn"
import { formatTimestamp, generateId } from "@/utils/helpers"
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
  /** Raw `link=Name` value from the tag block - resolved to a participant id by the caller, which has the roster. */
  linkedParticipantName?: string
  /** Only meaningful inside a linked chat's own thread - see Message["returnToParent"]. */
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

  const linkedParticipantName =
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
    linkedParticipantName,
    returnToParent,
  }
}

/** The inverse of fieldsFromEasyTags - only emits tags for values that differ from the defaults. */
const easyTagsFromMessage = (message: Message, participants: Participant[]): string => {
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
    if (message.notificationClickable && message.linkedParticipantId) {
      const linkedParticipant = participants.find(
        (participant) => participant.id === message.linkedParticipantId,
      )
      if (linkedParticipant) {
        tags.push(`link=${quoteTagValue(linkedParticipant.name)}`)
      }
    }
  }

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
  const mainMessages = useConversationStore((state) => state.conversation.messages)
  const groupName = useConversationStore((state) => state.conversation.groupName)
  const participants = useConversationStore((state) => state.conversation.participants)
  const memberIds = useConversationStore((state) => state.conversation.memberIds)
  const subConversations = useConversationStore((state) => state.conversation.subConversations)
  const activeParticipantId = useConversationStore((state) => state.activeParticipantId)
  const mainAddMessage = useConversationStore((state) => state.addMessage)
  const addParticipant = useConversationStore((state) => state.addParticipant)
  const ensureConversationMember = useConversationStore((state) => state.ensureConversationMember)
  const mainUpdateMessage = useConversationStore((state) => state.updateMessage)
  const mainDeleteMessage = useConversationStore((state) => state.deleteMessage)
  const mainDuplicateMessage = useConversationStore((state) => state.duplicateMessage)
  const mainSetMessages = useConversationStore((state) => state.setMessages)
  const addSubConversationMessage = useConversationStore((state) => state.addSubConversationMessage)
  const updateSubConversationMessage = useConversationStore((state) => state.updateSubConversationMessage)
  const deleteSubConversationMessage = useConversationStore((state) => state.deleteSubConversationMessage)
  const duplicateSubConversationMessage = useConversationStore(
    (state) => state.duplicateSubConversationMessage,
  )
  const setSubConversationMessages = useConversationStore((state) => state.setSubConversationMessages)
  const loadConversation = useConversationStore((state) => state.loadConversation)

  // Who's actually chatting in this conversation right now, as opposed to
  // the full character roster - the sender dropdown should only offer
  // these, so a benched character never accidentally ends up talking here.
  const chatMembers = useMemo(() => {
    const ids = memberIds && memberIds.length ? memberIds : participants.map((participant) => participant.id)
    const members = participants.filter((participant) => ids.includes(participant.id))
    return members.length ? members : participants
  }, [participants, memberIds])

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

  // Which chat this whole builder is currently editing - the main
  // conversation, or one linked participant's own separate side-chat
  // (opened via a clickable+linked notification back in the main
  // conversation). Everything below - the message list, standard/easy
  // editors, add-message form - operates on whichever thread is active, so
  // a linked chat gets exactly the same authoring tools as the main one
  // instead of a cramped nested editor.
  const [activeThreadTab, setActiveThreadTab] = useState<"main" | string>("main")

  // Every participant with a side-chat of their own: either because some
  // notification in the main conversation currently links to them, or
  // because they already have messages written (even if that notification
  // was since unlinked/deleted) - so nothing already written ever becomes
  // unreachable.
  const linkedThreadParticipants = useMemo(() => {
    const ids = new Set<string>()
    mainMessages.forEach((message) => {
      if (message.type === "notification" && message.notificationClickable && message.linkedParticipantId) {
        ids.add(message.linkedParticipantId)
      }
    })
    ;(subConversations ?? []).forEach((thread) => {
      if (thread.messages.length > 0) ids.add(thread.participantId)
    })
    return Array.from(ids)
      .map((id) => participants.find((participant) => participant.id === id))
      .filter((participant): participant is Participant => Boolean(participant))
  }, [mainMessages, subConversations, participants])

  // Fall back to the main tab if the thread that was open got unlinked/deleted.
  useEffect(() => {
    if (activeThreadTab === "main") return
    if (linkedThreadParticipants.some((participant) => participant.id === activeThreadTab)) return
    setActiveThreadTab("main")
  }, [activeThreadTab, linkedThreadParticipants])

  const isSubTab = activeThreadTab !== "main"
  const subParticipantId = isSubTab ? activeThreadTab : null
  const subOtherParticipant = subParticipantId
    ? participants.find((participant) => participant.id === subParticipantId) ?? null
    : null
  const subSelfId = getSelfParticipantId(participants, activeParticipantId)
  const subSelfParticipant = participants.find((participant) => participant.id === subSelfId) ?? null
  // The two people in the currently-open linked chat - "you" plus whoever
  // it's actually with. Null when the main conversation is active, or when
  // either side can't be resolved (e.g. no participants at all yet).
  const subThreadMembers = useMemo(
    () => (subOtherParticipant && subSelfParticipant ? [subSelfParticipant, subOtherParticipant] : null),
    [subOtherParticipant, subSelfParticipant],
  )

  // Everything below reads/writes through these instead of the main-only
  // bindings above, so the exact same UI (list, standard editor, easy
  // editor, add-message form) works whether "main" or a linked participant's
  // thread is currently open.
  const messages = isSubTab
    ? (subConversations ?? []).find((thread) => thread.participantId === subParticipantId)?.messages ?? []
    : mainMessages
  const threadMembers = isSubTab && subThreadMembers ? subThreadMembers : chatMembers
  const setMessages = (next: Message[]) => {
    if (isSubTab && subParticipantId) setSubConversationMessages(subParticipantId, next)
    else mainSetMessages(next)
  }
  const addMessage = (payload: Parameters<typeof mainAddMessage>[0]) => {
    if (isSubTab && subParticipantId) addSubConversationMessage(subParticipantId, payload)
    else mainAddMessage(payload)
  }
  const updateMessage = (messageId: string, updates: Partial<Message>) => {
    if (isSubTab && subParticipantId) updateSubConversationMessage(subParticipantId, messageId, updates)
    else mainUpdateMessage(messageId, updates)
  }
  const deleteMessage = (messageId: string) => {
    if (isSubTab && subParticipantId) deleteSubConversationMessage(subParticipantId, messageId)
    else mainDeleteMessage(messageId)
  }
  const duplicateMessage = (messageId: string) => {
    if (isSubTab && subParticipantId) duplicateSubConversationMessage(subParticipantId, messageId)
    else mainDuplicateMessage(messageId)
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

  // Who "<" stands for in the currently active thread - the main
  // conversation's activeParticipantId picker, or "you" in a linked chat.
  const threadSelfId = isSubTab ? subSelfId : activeParticipantId

  const resolveReceiverId = () => {
    if (isSubTab) return subOtherParticipant?.id ?? ""
    const fallback = chatMembers[0]?.id ?? ""
    if (!activeParticipantId) return fallback
    return chatMembers.find((participant) => participant.id !== activeParticipantId)?.id ?? fallback
  }

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
        const tagsStr = easyTagsFromMessage(message, participants)
        return [marker, message.content, tagsStr].filter((part) => part !== "").join(" ")
      })
      .join("\n")

  const buildEasyText = () => buildEasyTextForMessages(messages)

  // The whole story in one file: the main conversation plus every linked
  // side-chat that actually has messages, each under its own heading - so
  // exporting for translation doesn't lose anything sitting in a side tab.
  const buildFullEasyExportText = () => {
    const sections: string[] = [`# ${t.builder.mainThreadTab}\n${buildEasyTextForMessages(mainMessages)}`]
    linkedThreadParticipants.forEach((participant) => {
      const thread = (subConversations ?? []).find((entry) => entry.participantId === participant.id)
      const msgs = thread?.messages ?? []
      if (msgs.length === 0) return
      sections.push(`# ${t.builder.threadTabPrefix} ${participant.name}\n${buildEasyTextForMessages(msgs)}`)
    })
    return sections.join("\n\n")
  }

  const handleExportEasyText = () => {
    const text = buildFullEasyExportText()
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `${(groupName || "conversation").trim().replace(/\s+/g, "-").toLowerCase()}-easy.txt`
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
  // participant, the main conversation, and every linked side-chat.
  const handleApplyTranscript = () => {
    if (!transcriptInput.trim()) {
      setTranscriptError(t.builder.transcriptEmpty)
      return
    }
    if (!window.confirm(t.builder.transcriptConfirmOverwrite)) return
    try {
      const { conversation, warnings } = parseConversationTranscript(transcriptInput)
      loadConversation(conversation)
      setTranscriptError(null)
      setTranscriptWarnings(warnings)
      setViewMode("standard")
      setActiveThreadTab("main")
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
    if (!threadSelfId) {
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
    // Only relevant in the main conversation - a linked chat's two members
    // (self and the other participant) already exist by definition.
    const nameToId = new Map<string, string>()
    participants.forEach((participant) => nameToId.set(participant.name.trim().toLowerCase(), participant.id))
    if (!isSubTab) {
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
      // Everyone the script actually gives a line to is chatting in this main
      // conversation, whether they were just created or already existed as a
      // benched roster character. (nameToId also holds every OTHER roster
      // participant for lookup purposes, so only touch the ones this script
      // actually used.)
      const usedKeys = new Set(rawEntries.map((entry) => entry.marker.toLowerCase()))
      usedKeys.forEach((key) => {
        const participantId = nameToId.get(key)
        if (participantId) ensureConversationMember(participantId)
      })

      // Auto-create a participant for any `link=Name` notification target that
      // isn't already on the roster - deliberately NOT added as a main-chat
      // member, since they only exist inside the linked side-chat.
      rawEntries.forEach((entry) => {
        const linkName = typeof entry.tags.link === "string" ? entry.tags.link.trim() : ""
        if (!linkName) return
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
    }

    let hadNameOutsideSubThread = false
    const finalEntries: Array<
      { senderId: string; content: string; linkedParticipantId?: string } & EasyMessageFields
    > = []

    rawEntries.forEach((entry) => {
      const senderId = nameToId.get(entry.marker.toLowerCase())
      if (!senderId) return

      // A linked chat is only ever between "you" and the one other person it
      // belongs to - a name that resolves to someone else doesn't belong here.
      if (isSubTab && !threadMembers.some((member) => member.id === senderId)) {
        hadNameOutsideSubThread = true
        return
      }

      const fields = fieldsFromEasyTags(entry.tags)
      const content = entry.textParts.filter(Boolean).join("\n")
      if (!content && fields.type !== "image") return

      // A notification's `link=` only makes sense in the main conversation -
      // a linked chat can't itself open another linked chat.
      const linkedParticipantId =
        !isSubTab && fields.linkedParticipantName
          ? nameToId.get(fields.linkedParticipantName.toLowerCase())
          : undefined

      finalEntries.push({ senderId, content, linkedParticipantId, ...fields })
    })

    if (hadNameOutsideSubThread) {
      setEasyError(t.builder.easyModeSubOnlyArrows)
      showToast(t.builder.easyModeSubOnlyArrows, "error")
      return
    }
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
        linkedParticipantId: entry.linkedParticipantId,
        returnToParent: isSubTab ? entry.returnToParent : undefined,
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

  const handleThreadTabChange = (tab: "main" | string) => {
    if (tab === activeThreadTab) return
    setActiveThreadTab(tab)
    setEditingId(null)
    setOpenActionsId(null)
    setIsAddOpen(false)
    setEasyError(null)
    // The easy editor's text belongs to whichever thread was open when it
    // was last (re)generated - switch it over so it doesn't show the wrong
    // conversation, or get accidentally applied to the wrong one.
    if (viewMode === "easy") setEasyInput("")
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            {isSubTab && subOtherParticipant
              ? t.messageForm.linkedThreadEditorTitle.replace("{name}", subOtherParticipant.name)
              : t.builder.title}
          </h3>
          <p className="text-xs text-slate-500">
            {isSubTab ? t.builder.threadTabHint : t.builder.subtitle}
          </p>
        </div>

        {linkedThreadParticipants.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <Button
              type="button"
              size="sm"
              variant={activeThreadTab === "main" ? "default" : "outline"}
              onClick={() => handleThreadTabChange("main")}
            >
              {t.builder.mainThreadTab}
            </Button>
            {linkedThreadParticipants.map((participant) => (
              <Button
                key={participant.id}
                type="button"
                size="sm"
                variant={activeThreadTab === participant.id ? "default" : "outline"}
                onClick={() => handleThreadTabChange(participant.id)}
              >
                {t.builder.threadTabPrefix} {participant.name}
              </Button>
            ))}
          </div>
        ) : null}

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
                  placeholder={
                    isSubTab
                      ? `${activeParticipant?.name ?? "You"}: message\n${receiverParticipant?.name ?? "Them"}: message [delay=1.5]\n${activeParticipant?.name ?? "You"}: Return message [return]`
                      : `${activeParticipant?.name ?? "Sender"}: message\n${receiverParticipant?.name ?? "Receiver"}: message\nSarah: hi, joining the chat\n${receiverParticipant?.name ?? "Receiver"}: Delivery update [notification clickable auto=1.5 opens=0.7 as="Sarah" app=Instagram link="Sarah"]`
                  }
                  className="min-h-[280px] resize-y font-mono"
                />
                <div className="space-y-1 text-xs text-slate-500">
                  {isSubTab ? (
                    <p>
                      Start every line with <span className="font-semibold">Name:</span> - either{" "}
                      {activeParticipant?.name ?? "you"} or {receiverParticipant?.name ?? "them"} - it's
                      just the two of you, so no other names or <span className="font-mono">link=</span> here.
                      Add <span className="font-mono">[return]</span> to a line to have playback jump back to
                      the main conversation right after that message.
                    </p>
                  ) : (
                    <p>
                      Start every line with <span className="font-semibold">Name:</span>{t.builder.easyHelpNameNote}
                    </p>
                  )}
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
                    that person when tapped - auto-creates them if new). Example:{" "}
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
                                participants={threadMembers}
                                rosterParticipants={isSubTab ? undefined : participants}
                                initial={message}
                                defaultSenderId={isSubTab ? subOtherParticipant?.id : activeParticipantId}
                                compact
                                advancedOpen={isAdvancedOpen}
                                onToggleAdvanced={() => setIsAdvancedOpen((prev) => !prev)}
                                isSubMessage={isSubTab}
                                onJumpToLinkedThread={handleThreadTabChange}
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
                    key={isSubTab ? `new-${activeThreadTab}` : "new"}
                    participants={threadMembers}
                    rosterParticipants={isSubTab ? undefined : participants}
                    initial={null}
                    defaultSenderId={isSubTab ? subOtherParticipant?.id : activeParticipantId}
                    compact
                    resetOnSubmit
                    isSubMessage={isSubTab}
                    onJumpToLinkedThread={handleThreadTabChange}
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
      </div>
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
