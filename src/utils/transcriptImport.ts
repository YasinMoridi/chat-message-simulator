import type { Conversation, Participant } from "@/types/conversation"
import type { Message, MessageStatus } from "@/types/message"
import { generateId } from "@/utils/helpers"

/**
 * Reverse of buildConversationTranscript (src/utils/textExport.ts): takes the
 * narrative .txt transcript a user downloaded (or hand-wrote in the same
 * shape) and rebuilds a full Conversation - participants, the main thread,
 * and every linked sub-conversation - matching exactly what generated it.
 *
 * This is intentionally a mirror of renderThread's branching: the same
 * fixed label strings (in whichever of fa/en the file uses) mark thread
 * boundaries, notification/back-navigation jumps, and returns to the
 * parent thread, so we can walk the flat line list with a small context
 * stack instead of needing any lookahead grammar.
 */

const PARTICIPANT_COLORS = ["#22c55e", "#0b84ff", "#f97316", "#a855f7", "#ef4444", "#14b8a6"]
const pickColor = (index: number) => PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length]

type Lang = "fa" | "en"

interface LangLabels {
  headerPrefix: string
  participantsLinePrefix: string
  youWord: string
  mainStart: string
  mainEnd: string
  systemPrefix: string
  imagePrefix: string
  notificationLine: string
  notifContentPrefix: string
  notifOverrideNamePrefix: string
  notifOverrideAppPrefix: string
  notifOverrideAvatarPrefix: string
  notifNotClickable: string
  notifClickableManual: string
  notifAutoOpenPrefix: string
  notifOpenDelayPrefix: string
  hiddenLine: string
  backAvailable: string
  backAutoPrefix: string
  backManualOnly: string
  goesHome: string
  waitsAtHome: string
  subThreadDeadEnd: string
  statusPrefix: string
  delayMid: string
  jumpFromNotificationHint: string
  jumpFromHomeHint: string
  subThreadHeaderHint: string
  endOfSubHint: string
  missingSubHint: string
}

const LANGS: Record<Lang, LangLabels> = {
  fa: {
    headerPrefix: "متن کامل گفتگو: ",
    participantsLinePrefix: "شرکت‌کننده‌ها (",
    youWord: "شما",
    mainStart: "=== شروع چت اصلی ===",
    mainEnd: "=== پایان چت اصلی ===",
    systemPrefix: "[پیام سیستمی]",
    imagePrefix: "[عکس]: ",
    notificationLine: "🔔 نوتیفیکیشن نمایش داده می‌شه:",
    notifContentPrefix: "محتوا/content:",
    notifOverrideNamePrefix: "- اسم فرستنده‌ی نوتیف (به‌جای فرستنده‌ی واقعی):",
    notifOverrideAppPrefix: "- اسم اپ نوتیف:",
    notifOverrideAvatarPrefix: "- آواتار نوتیف:",
    notifNotClickable: "- قابل کلیک نیست، فقط نمایش داده می‌شه و می‌ره کنار.",
    notifClickableManual: "- قابل کلیکه (باید دستی روش زده بشه تا باز شه).",
    notifAutoOpenPrefix: "- خودش بعد از",
    notifOpenDelayPrefix: "- بعد از زده شدن،",
    hiddenLine: "(این پیام مخفیه و توی پخش نمایش داده نمی‌شه)",
    backAvailable: "- دکمه‌ی برگشت (Back) روی هدر فعاله - می‌شه از این چت زد بیرون.",
    backAutoPrefix: "- بعد از",
    backManualOnly: "- فقط با زدن دستی دکمه‌ی برگشت از این چت خارج می‌شیم.",
    goesHome: "--- می‌ریم به صفحه‌ی لیست چت‌ها (Home) ---",
    waitsAtHome: "(صفحه‌ی لیست چت‌ها همینجا می‌مونه تا کسی دستی یه مخاطب رو بزنه)",
    subThreadDeadEnd: "(هیچ برگشتی به چت اصلی تعریف نشده - داستان همینجا توی این چت جانبی تموم می‌شه)",
    statusPrefix: "وضعیت:",
    delayMid: "تاخیر قبل از این پیام:",
    jumpFromNotificationHint: "با زدن این نوتیف",
    jumpFromHomeHint: "توی صفحه‌ی لیست چت‌ها",
    subThreadHeaderHint: "شروع شد",
    endOfSubHint: "پایان چت جداگانه",
    missingSubHint: "هشدار: قرار بود چت جداگانه",
  },
  en: {
    headerPrefix: "Full conversation transcript: ",
    participantsLinePrefix: "Participants (",
    youWord: "You",
    mainStart: "=== MAIN CHAT START ===",
    mainEnd: "=== MAIN CHAT END ===",
    systemPrefix: "[system message]",
    imagePrefix: "[image]: ",
    notificationLine: "🔔 Notification banner appears:",
    notifContentPrefix: "محتوا/content:",
    notifOverrideNamePrefix: "- notification sender name (overrides real sender):",
    notifOverrideAppPrefix: "- notification app name:",
    notifOverrideAvatarPrefix: "- notification avatar:",
    notifNotClickable: "- not clickable, just shows and slides away.",
    notifClickableManual: "- clickable (needs a manual tap to open).",
    notifAutoOpenPrefix: "- auto-taps itself after",
    notifOpenDelayPrefix: "- after being tapped, takes",
    hiddenLine: "(this message is hidden and is not shown during playback)",
    backAvailable: "- Back button is enabled on the header - this chat can be exited here.",
    backAutoPrefix: "- Automatically leaves for the chat-list (Home) screen after",
    backManualOnly: "- Only leaves this chat if the back button is tapped manually.",
    goesHome: "--- Goes to the chat-list (Home) screen ---",
    waitsAtHome: "(The chat-list screen just sits here until a contact is tapped manually)",
    subThreadDeadEnd: "(No return to the main chat is set - the story ends here in this side chat)",
    statusPrefix: "status:",
    delayMid: "delay before this message:",
    jumpFromNotificationHint: "Tapping this notification jumps into",
    jumpFromHomeHint: "On the chat-list screen,",
    subThreadHeaderHint: "begins ---",
    endOfSubHint: "End of separate chat",
    missingSubHint: "was supposed to open",
  },
}

const detectLanguage = (lines: string[]): Lang => {
  for (const raw of lines) {
    const line = raw.trim()
    if (line === LANGS.fa.mainStart) return "fa"
    if (line === LANGS.en.mainStart) return "en"
  }
  return "fa"
}

const extractQuoted = (line: string, lang: Lang): string | null => {
  if (lang === "fa") {
    const match = line.match(/«([^»]+)»/)
    return match ? match[1].trim() : null
  }
  const match = line.match(/"([^"]+)"/)
  return match ? match[1].trim() : null
}

const extractMs = (line: string): number | undefined => {
  const match = line.match(/(\d+)\s*ms/)
  return match ? Number(match[1]) : undefined
}

const parseTimestamp = (raw: string): string => {
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/)
  if (!match) return new Date().toISOString()
  const [, y, mo, d, h, mi, s] = match
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  if (Number.isNaN(date.getTime())) return new Date().toISOString()
  return date.toISOString()
}

const isEndOfSubConversation = (line: string, L: LangLabels) =>
  line.startsWith("---") && line.includes(L.endOfSubHint)

const isSubThreadHeader = (line: string, L: LangLabels) =>
  line.startsWith("---") && line.includes(L.subThreadHeaderHint)

const isMissingSubConversation = (line: string, L: LangLabels) => line.includes(L.missingSubHint)

const isJumpLine = (line: string, L: LangLabels) => line.startsWith(">>>") && line.endsWith(">>>")

const isJumpFromHome = (line: string, L: LangLabels) => line.includes(L.jumpFromHomeHint)

interface ParsedMember {
  name: string
  isSelf: boolean
}

const parseParticipantsLine = (line: string, L: LangLabels): ParsedMember[] => {
  const afterPrefix = line.slice(L.participantsLinePrefix.length)
  const closeParenIdx = afterPrefix.indexOf(")")
  if (closeParenIdx === -1) return []
  const rest = afterPrefix.slice(closeParenIdx + 1)
  const colonIdx = rest.indexOf(":")
  if (colonIdx === -1) return []
  const namesPart = rest.slice(colonIdx + 1).trim()
  if (!namesPart) return []
  const selfSuffix = ` (${L.youWord})`
  return namesPart
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (entry.endsWith(selfSuffix)) {
        return { name: entry.slice(0, -selfSuffix.length).trim(), isSelf: true }
      }
      return { name: entry, isSelf: false }
    })
}

const parseStatusDelayLine = (line: string, L: LangLabels): { status: MessageStatus; delayMs?: number } => {
  const withoutPrefix = line.slice(L.statusPrefix.length).trim()
  const midIdx = withoutPrefix.indexOf(L.delayMid)
  const statusWord = (midIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, midIdx))
    .replace(/\|$/, "")
    .trim()
  const validStatuses: MessageStatus[] = ["sent", "delivered", "read"]
  const status = (validStatuses as string[]).includes(statusWord) ? (statusWord as MessageStatus) : "sent"
  const delayMs = midIdx === -1 ? undefined : extractMs(withoutPrefix.slice(midIdx))
  return { status, delayMs }
}

export interface TranscriptImportResult {
  conversation: Conversation
  warnings: string[]
}

/**
 * Parses a narrative transcript (as produced by buildConversationTranscript)
 * back into a full Conversation. Throws with a user-facing message if the
 * text doesn't contain a recognizable main-chat marker at all.
 */
export const parseConversationTranscript = (rawText: string): TranscriptImportResult => {
  const warnings: string[] = []
  const lines = rawText.replace(/\r\n/g, "\n").split("\n")
  const lang = detectLanguage(lines)
  const L = LANGS[lang]

  let title = ""
  let declaredMembers: ParsedMember[] = []
  let mainStartIdx = -1

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx].trim()
    if (!title && line.startsWith(L.headerPrefix)) {
      title = line.slice(L.headerPrefix.length).trim()
    }
    if (line.startsWith(L.participantsLinePrefix)) {
      declaredMembers = parseParticipantsLine(line, L)
    }
    if (line === L.mainStart) {
      mainStartIdx = idx
      break
    }
  }

  if (mainStartIdx === -1) {
    throw new Error(
      lang === "fa"
        ? "خطی به شکل «=== شروع چت اصلی ===» توی متن پیدا نشد. مطمئن شو کل فایل ترنسکریپت رو پیست/آپلود کردی."
        : 'Could not find a "=== MAIN CHAT START ===" line. Make sure you pasted/uploaded the full transcript file.',
    )
  }

  const participants: Participant[] = []
  const nameToId = new Map<string, string>()
  let selfId = ""

  const ensureParticipant = (name: string): string => {
    const key = name.trim().toLowerCase()
    const existing = nameToId.get(key)
    if (existing) return existing
    const id = generateId()
    participants.push({ id, name: name.trim(), status: "online", color: pickColor(participants.length) })
    nameToId.set(key, id)
    return id
  }

  declaredMembers.forEach((member) => {
    const id = ensureParticipant(member.name)
    if (member.isSelf) selfId = id
  })
  const declaredMemberIds = declaredMembers.map((member) => nameToId.get(member.name.trim().toLowerCase())!)

  const resolveSenderId = (name: string): string => {
    if (name.trim() === L.youWord) {
      if (!selfId) selfId = ensureParticipant(L.youWord)
      return selfId
    }
    return ensureParticipant(name)
  }

  const mainMessages: Message[] = []
  const mainSenderIds = new Set<string>()
  const subConversations = new Map<string, Message[]>()

  interface Ctx {
    messages: Message[]
    isMain: boolean
  }
  const stack: Ctx[] = [{ messages: mainMessages, isMain: true }]

  const messageHeaderRe = /^\[(\d+)\]\s+(.+?)\s+-\s+(.+)$/
  const n = lines.length
  let i = mainStartIdx + 1

  outer: while (i < n) {
    const line = lines[i].trim()
    const top = stack[stack.length - 1]

    if (!line) {
      i += 1
      continue
    }

    if (top.isMain && line === L.mainEnd) {
      break
    }

    if (!top.isMain) {
      if (line === L.subThreadDeadEnd) {
        i += 1
        continue
      }
      if (isEndOfSubConversation(line, L)) {
        stack.pop()
        i += 1
        continue
      }
    }

    if (line.startsWith("<<<")) {
      const last = top.messages[top.messages.length - 1]
      if (last) last.returnToParent = true
      i += 1
      continue
    }

    const headerMatch = line.match(messageHeaderRe)
    if (!headerMatch) {
      warnings.push(lang === "fa" ? `یک خط ناشناخته نادیده گرفته شد: ${line.slice(0, 60)}` : `Skipped an unrecognized line: ${line.slice(0, 60)}`)
      i += 1
      continue
    }

    const [, , tsRaw, senderNameRaw] = headerMatch
    const senderId = resolveSenderId(senderNameRaw.trim())
    if (top.isMain) mainSenderIds.add(senderId)

    const message: Message = {
      id: generateId(),
      senderId,
      content: "",
      timestamp: parseTimestamp(tsRaw),
      type: "text",
      status: "sent",
    }
    const contentLines: string[] = []
    i += 1

    // Gathers every line that belongs to THIS message - type-specific
    // content, the status/delay line, hidden flag, back-navigation lines -
    // stopping (without consuming) as soon as we hit the next message
    // header or any thread-transition/closing marker.
    while (i < n) {
      const bl = lines[i].trim()
      if (!bl) {
        i += 1
        continue
      }
      if (
        messageHeaderRe.test(bl) ||
        bl.startsWith(">>>") ||
        bl.startsWith("<<<") ||
        bl === L.mainEnd ||
        bl === L.goesHome ||
        bl === L.waitsAtHome ||
        bl === L.subThreadDeadEnd ||
        isSubThreadHeader(bl, L) ||
        isEndOfSubConversation(bl, L) ||
        isMissingSubConversation(bl, L)
      ) {
        break
      }
      if (bl.startsWith(L.statusPrefix)) {
        const parsed = parseStatusDelayLine(bl, L)
        message.status = parsed.status
        message.delayMs = parsed.delayMs
        i += 1
        continue
      }
      if (bl.startsWith(L.systemPrefix)) {
        message.type = "system"
        contentLines.push(bl.slice(L.systemPrefix.length).trim())
        i += 1
        continue
      }
      if (bl.startsWith(L.imagePrefix)) {
        message.type = "image"
        message.imageUrl = bl.slice(L.imagePrefix.length).trim()
        i += 1
        continue
      }
      if (bl === L.notificationLine) {
        message.type = "notification"
        i += 1
        continue
      }
      if (bl.startsWith(L.notifContentPrefix)) {
        contentLines.push(bl.slice(L.notifContentPrefix.length).trim())
        i += 1
        continue
      }
      if (bl.startsWith(L.notifOverrideNamePrefix)) {
        message.notificationOverride = {
          ...(message.notificationOverride ?? { enabled: true }),
          enabled: true,
          senderName: bl.slice(L.notifOverrideNamePrefix.length).trim(),
        }
        i += 1
        continue
      }
      if (bl.startsWith(L.notifOverrideAppPrefix)) {
        message.notificationOverride = {
          ...(message.notificationOverride ?? { enabled: true }),
          enabled: true,
          appName: bl.slice(L.notifOverrideAppPrefix.length).trim(),
        }
        i += 1
        continue
      }
      if (bl.startsWith(L.notifOverrideAvatarPrefix)) {
        message.notificationOverride = {
          ...(message.notificationOverride ?? { enabled: true }),
          enabled: true,
          avatarUrl: bl.slice(L.notifOverrideAvatarPrefix.length).trim(),
        }
        i += 1
        continue
      }
      if (bl === L.notifNotClickable) {
        message.notificationClickable = false
        i += 1
        continue
      }
      if (bl === L.notifClickableManual) {
        message.notificationClickable = true
        message.notificationAutoOpen = false
        i += 1
        continue
      }
      if (bl.startsWith(L.notifAutoOpenPrefix)) {
        message.notificationClickable = true
        message.notificationAutoOpen = true
        message.notificationAutoOpenDelayMs = extractMs(bl)
        i += 1
        continue
      }
      if (bl.startsWith(L.notifOpenDelayPrefix)) {
        message.notificationOpenDelayMs = extractMs(bl)
        i += 1
        continue
      }
      if (bl === L.hiddenLine) {
        message.isHidden = true
        i += 1
        continue
      }
      if (bl === L.backAvailable) {
        message.backNavigation = { ...(message.backNavigation ?? {}), enabled: true }
        i += 1
        continue
      }
      if (bl.startsWith(L.backAutoPrefix)) {
        message.backNavigation = {
          ...(message.backNavigation ?? { enabled: true }),
          enabled: true,
          autoOpen: true,
          autoOpenDelayMs: extractMs(bl),
        }
        i += 1
        continue
      }
      if (bl === L.backManualOnly) {
        message.backNavigation = { ...(message.backNavigation ?? { enabled: true }), enabled: true, autoOpen: false }
        i += 1
        continue
      }
      contentLines.push(bl)
      i += 1
    }

    message.content = contentLines.join("\n")
    top.messages.push(message)

    // Trailing transition markers between this message and whatever comes
    // next: a notification/back-nav jump into a linked thread, or nothing.
    let pendingIsHomeAuto = false
    while (i < n) {
      const ml = lines[i].trim()
      if (!ml) {
        i += 1
        continue
      }
      if (isJumpLine(ml, L)) {
        if (isJumpFromHome(ml, L)) pendingIsHomeAuto = true
        i += 1
        continue
      }
      if (isMissingSubConversation(ml, L)) {
        const name = extractQuoted(ml, lang)
        warnings.push(
          lang === "fa"
            ? `چت جداگانه‌ای برای «${name ?? "?"}» لینک شده بود ولی توی متن پیدا نشد.`
            : `A separate chat for "${name ?? "?"}" was linked but not found in the text.`,
        )
        i += 1
        continue
      }
      if (ml === L.goesHome || ml === L.waitsAtHome) {
        i += 1
        continue
      }
      if (isSubThreadHeader(ml, L)) {
        const name = extractQuoted(ml, lang)
        if (name) {
          const pid = ensureParticipant(name)
          if (pendingIsHomeAuto) {
            message.backNavigation = { ...(message.backNavigation ?? { enabled: true }), autoSelectParticipantId: pid }
          } else {
            message.linkedParticipantId = pid
          }
          if (!subConversations.has(pid)) subConversations.set(pid, [])
          stack.push({ messages: subConversations.get(pid)!, isMain: false })
        }
        i += 1
        continue outer
      }
      break
    }
  }

  if (!selfId) {
    if (declaredMemberIds.length > 0) {
      selfId = declaredMemberIds[0]
    } else if (participants.length > 0) {
      selfId = participants[0].id
    }
    if (selfId) {
      warnings.push(
        lang === "fa"
          ? "مشخص نبود کدوم شرکت‌کننده «شما» هست؛ اولین نفر به‌عنوان شما در نظر گرفته شد."
          : "Couldn't tell which participant was \"you\"; the first one was used as you.",
      )
    }
  }

  const memberIds = declaredMemberIds.length > 0 ? declaredMemberIds : Array.from(mainSenderIds)
  if (selfId && !memberIds.includes(selfId)) memberIds.unshift(selfId)

  // Self needs to be participants[0] - that's what the app treats as "you"
  // for both direct chats (loadConversation points activeParticipantId at
  // participants[0]) and groups (always participants[0]).
  const ordered = selfId
    ? [participants.find((p) => p.id === selfId)!, ...participants.filter((p) => p.id !== selfId)]
    : participants

  const isGroup = memberIds.length > 2
  const conversation: Conversation = {
    id: generateId(),
    participants: ordered,
    messages: mainMessages,
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    groupName: isGroup ? title || "Group Chat" : undefined,
    subConversations:
      subConversations.size > 0
        ? Array.from(subConversations.entries()).map(([participantId, messages]) => ({ participantId, messages }))
        : undefined,
    memberIds,
  }

  return { conversation, warnings }
}
