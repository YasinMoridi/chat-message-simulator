import type { Chat, Conversation, Participant } from "@/types/conversation"
import type { Message, MessageStatus } from "@/types/message"
import { generateId } from "@/utils/helpers"

/**
 * Reverse of buildConversationTranscript (src/utils/textExport.ts): takes
 * the narrative .txt transcript a user downloaded (or hand-wrote in the
 * same shape) and rebuilds a full Conversation - every participant and
 * every chat - matching exactly what generated it.
 *
 * This is intentionally a mirror of renderThread's branching: the same
 * fixed label strings (in whichever of fa/en the file uses) mark chat
 * boundaries, notification/back-navigation jumps, and returns to whichever
 * chat opened this one, so we can walk the flat line list with a small
 * context stack instead of needing any lookahead grammar.
 *
 * Every chat in the project gets its own top-level "=== CHAT START ==="
 * section (with the real content), and a linked notification/back-
 * navigation jump into that SAME chat from elsewhere in the file only
 * re-prints a "--- Chat begins here ---" marker with no content of its
 * own (see textExport.ts) - so a chat referenced by title that's already
 * been (or will be) seen as its own top-level section is only ever parsed
 * once; only a nested reference to a title with no top-level section of
 * its own gets its content parsed straight out of that nested block.
 */

const PARTICIPANT_COLORS = ["#22c55e", "#0b84ff", "#f97316", "#a855f7", "#ef4444", "#14b8a6"]
const pickColor = (index: number) => PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length]

type Lang = "fa" | "en"

interface LangLabels {
  headerPrefix: string
  participantsLinePrefix: string
  youWord: string
  chatStartPrefix: string
  chatStartSuffix: string
  chatEndPrefix: string
  chatEndSuffix: string
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
  linkedChatDeadEnd: string
  statusPrefix: string
  delayMid: string
  jumpFromHomeHint: string
  linkedChatHeaderHint: string
  endOfLinkedChatHint: string
  missingChatHint: string
}

const LANGS: Record<Lang, LangLabels> = {
  fa: {
    headerPrefix: "متن کامل گفتگو: ",
    participantsLinePrefix: "شرکت‌کننده‌ها (",
    youWord: "شما",
    chatStartPrefix: "=== شروع چت: ",
    chatStartSuffix: " ===",
    chatEndPrefix: "=== پایان چت: ",
    chatEndSuffix: " ===",
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
    linkedChatDeadEnd: "(هیچ برگشتی تعریف نشده - داستان همینجا توی این چت تموم می‌شه)",
    statusPrefix: "وضعیت:",
    delayMid: "تاخیر قبل از این پیام:",
    jumpFromHomeHint: "توی صفحه‌ی لیست چت‌ها",
    linkedChatHeaderHint: "از اینجا شروع شد",
    endOfLinkedChatHint: "پایان چت",
    missingChatHint: "هشدار: قرار بود چتی",
  },
  en: {
    headerPrefix: "Full conversation transcript: ",
    participantsLinePrefix: "Participants (",
    youWord: "You",
    chatStartPrefix: "=== CHAT START: ",
    chatStartSuffix: " ===",
    chatEndPrefix: "=== CHAT END: ",
    chatEndSuffix: " ===",
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
    linkedChatDeadEnd: "(No return is set - the story ends here in this chat)",
    statusPrefix: "status:",
    delayMid: "delay before this message:",
    jumpFromHomeHint: "On the chat-list screen,",
    linkedChatHeaderHint: "begins here ---",
    endOfLinkedChatHint: "End of chat",
    missingChatHint: "was supposed to open",
  },
}

const detectLanguage = (lines: string[]): Lang => {
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith(LANGS.fa.chatStartPrefix)) return "fa"
    if (line.startsWith(LANGS.en.chatStartPrefix)) return "en"
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

const isChatStart = (line: string, L: LangLabels) =>
  line.startsWith(L.chatStartPrefix) && line.endsWith(L.chatStartSuffix)
const chatStartTitle = (line: string, L: LangLabels) =>
  line.slice(L.chatStartPrefix.length, line.length - L.chatStartSuffix.length).trim()

const isChatEnd = (line: string, L: LangLabels) => line.startsWith(L.chatEndPrefix) && line.endsWith(L.chatEndSuffix)

const isEndOfLinkedChat = (line: string, L: LangLabels) =>
  line.startsWith("---") && line.includes(L.endOfLinkedChatHint)

const isLinkedChatHeader = (line: string, L: LangLabels) =>
  line.startsWith("---") && line.includes(L.linkedChatHeaderHint)

const isMissingChat = (line: string, L: LangLabels) => line.includes(L.missingChatHint)

const isJumpLine = (line: string) => line.startsWith(">>>") && line.endsWith(">>>")

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
  const statusWord = (midIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, midIdx)).replace(/\|$/, "").trim()
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
 * text doesn't contain a recognizable chat-start marker at all.
 */
export const parseConversationTranscript = (rawText: string): TranscriptImportResult => {
  const warnings: string[] = []
  const lines = rawText.replace(/\r\n/g, "\n").split("\n")
  const lang = detectLanguage(lines)
  const L = LANGS[lang]

  const trimmedLines = lines.map((line) => line.trim())

  // Pass 1: find every top-level "=== CHAT START: TITLE ===" marker so
  // links to a chat title that appears later in the file (or the same
  // title appearing again as a nested link) can still be resolved to the
  // one real chat, instead of accidentally duplicating its content.
  const topLevelTitles: string[] = []
  trimmedLines.forEach((line) => {
    if (isChatStart(line, L)) topLevelTitles.push(chatStartTitle(line, L))
  })

  if (topLevelTitles.length === 0) {
    throw new Error(
      lang === "fa"
        ? "خطی به شکل «=== شروع چت: ... ===» توی متن پیدا نشد. مطمئن شو کل فایل ترنسکریپت رو پیست/آپلود کردی."
        : 'Could not find a "=== CHAT START: ... ===" line. Make sure you pasted/uploaded the full transcript file.',
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

  const resolveSenderId = (name: string): string => {
    if (name.trim() === L.youWord) {
      if (!selfId) selfId = ensureParticipant(L.youWord)
      return selfId
    }
    return ensureParticipant(name)
  }

  interface ChatBuild {
    id: string
    title: string
    declaredMemberIds: string[]
    senderIds: Set<string>
    messages: Message[]
  }

  // One build entry per unique top-level title - the canonical home for
  // that chat's content, whichever occurrence (top-level or nested) we
  // end up actually parsing lines from first.
  const chatsByTitle = new Map<string, ChatBuild>()
  topLevelTitles.forEach((title) => {
    if (chatsByTitle.has(title)) return
    chatsByTitle.set(title, { id: generateId(), title, declaredMemberIds: [], senderIds: new Set(), messages: [] })
  })

  const getOrCreateChatByTitle = (title: string): ChatBuild => {
    const existing = chatsByTitle.get(title)
    if (existing) return existing
    const created: ChatBuild = { id: generateId(), title, declaredMemberIds: [], senderIds: new Set(), messages: [] }
    chatsByTitle.set(title, created)
    return created
  }

  interface Ctx {
    chat: ChatBuild
    /** True once this chat's canonical content has already been parsed elsewhere - skip lines, don't record messages. */
    isDuplicate: boolean
  }

  const messageHeaderRe = /^\[(\d+)\]\s+(.+?)\s+-\s+(.+)$/
  const n = trimmedLines.length
  const alreadyParsedTitles = new Set<string>()

  let i = 0
  const stack: Ctx[] = []

  while (i < n) {
    const line = trimmedLines[i]

    if (stack.length === 0) {
      // Looking for the next top-level chat section.
      if (!isChatStart(line, L)) {
        i += 1
        continue
      }
      const title = chatStartTitle(line, L)
      const chat = getOrCreateChatByTitle(title)
      const isDuplicate = alreadyParsedTitles.has(title)
      alreadyParsedTitles.add(title)
      stack.push({ chat, isDuplicate })
      i += 1
      // Right after chatStart: an optional "Participants (...): ..." line.
      if (i < n && trimmedLines[i].startsWith(L.participantsLinePrefix)) {
        const declared = parseParticipantsLine(trimmedLines[i], L)
        if (!isDuplicate) {
          declared.forEach((member) => {
            const id = ensureParticipant(member.name)
            if (member.isSelf) selfId = id
            chat.declaredMemberIds.push(id)
          })
        }
        i += 1
      }
      continue
    }

    const top = stack[stack.length - 1]

    if (!line) {
      i += 1
      continue
    }

    if (stack.length === 1 && isChatEnd(line, L)) {
      stack.pop()
      i += 1
      continue
    }

    if (stack.length > 1) {
      if (line === L.linkedChatDeadEnd) {
        i += 1
        continue
      }
      if (isEndOfLinkedChat(line, L)) {
        stack.pop()
        i += 1
        continue
      }
    }

    if (line.startsWith("<<<")) {
      if (!top.isDuplicate) {
        const last = top.chat.messages[top.chat.messages.length - 1]
        if (last) last.returnToParent = true
      }
      i += 1
      continue
    }

    const headerMatch = line.match(messageHeaderRe)
    if (!headerMatch) {
      warnings.push(
        lang === "fa" ? `یک خط ناشناخته نادیده گرفته شد: ${line.slice(0, 60)}` : `Skipped an unrecognized line: ${line.slice(0, 60)}`,
      )
      i += 1
      continue
    }

    const [, , tsRaw, senderNameRaw] = headerMatch
    const senderId = resolveSenderId(senderNameRaw.trim())
    if (!top.isDuplicate) top.chat.senderIds.add(senderId)

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
    // header or any chat-transition/closing marker.
    while (i < n) {
      const bl = trimmedLines[i]
      if (!bl) {
        i += 1
        continue
      }
      if (
        messageHeaderRe.test(bl) ||
        bl.startsWith(">>>") ||
        bl.startsWith("<<<") ||
        isChatEnd(bl, L) ||
        bl === L.goesHome ||
        bl === L.waitsAtHome ||
        bl === L.linkedChatDeadEnd ||
        isLinkedChatHeader(bl, L) ||
        isEndOfLinkedChat(bl, L) ||
        isMissingChat(bl, L)
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
    if (!top.isDuplicate) top.chat.messages.push(message)

    // Trailing transition markers between this message and whatever comes
    // next: a notification/back-nav jump into a linked chat, or nothing.
    let pendingIsHomeAuto = false
    while (i < n) {
      const ml = trimmedLines[i]
      if (!ml) {
        i += 1
        continue
      }
      if (isJumpLine(ml)) {
        if (isJumpFromHome(ml, L)) pendingIsHomeAuto = true
        i += 1
        continue
      }
      if (isMissingChat(ml, L)) {
        const name = extractQuoted(ml, lang)
        warnings.push(
          lang === "fa"
            ? `چتی به اسم «${name ?? "?"}» لینک شده بود ولی توی متن پیدا نشد.`
            : `A chat named "${name ?? "?"}" was linked but not found in the text.`,
        )
        i += 1
        continue
      }
      if (ml === L.goesHome || ml === L.waitsAtHome) {
        i += 1
        continue
      }
      if (isLinkedChatHeader(ml, L)) {
        const name = extractQuoted(ml, lang)
        if (name) {
          const linkedChat = getOrCreateChatByTitle(name)
          const isDuplicate = alreadyParsedTitles.has(name)
          alreadyParsedTitles.add(name)
          if (!top.isDuplicate) {
            if (pendingIsHomeAuto) {
              message.backNavigation = { ...(message.backNavigation ?? { enabled: true }), autoSelectChatId: linkedChat.id }
            } else {
              message.linkedChatId = linkedChat.id
            }
          }
          stack.push({ chat: linkedChat, isDuplicate })
        }
        i += 1
        break
      }
      break
    }
  }

  if (!selfId) {
    const firstDeclared = Array.from(chatsByTitle.values()).find((c) => c.declaredMemberIds.length > 0)
    if (firstDeclared) {
      selfId = firstDeclared.declaredMemberIds[0]
    } else if (participants.length > 0) {
      selfId = participants[0].id
    }
    if (selfId) {
      warnings.push(
        lang === "fa"
          ? "مشخص نبود کدوم شرکت‌کننده «شما» هست؛ اولین نفر به‌عنوان شما در نظر گرفته شد."
          : 'Couldn\'t tell which participant was "you"; the first one was used as you.',
      )
    }
  }

  // Self needs to be participants[0] - that's what the app treats as "you"
  // (loadConversation points activeParticipantId at participants[0]).
  const ordered = selfId
    ? [participants.find((p) => p.id === selfId)!, ...participants.filter((p) => p.id !== selfId)]
    : participants

  const chats: Chat[] = Array.from(chatsByTitle.values()).map((build) => {
    const memberIds =
      build.declaredMemberIds.length > 0 ? build.declaredMemberIds : Array.from(build.senderIds)
    if (selfId && !memberIds.includes(selfId)) memberIds.unshift(selfId)
    const isGroup = memberIds.length > 2
    return {
      id: build.id,
      name: isGroup ? build.title || undefined : undefined,
      memberIds,
      messages: build.messages,
    }
  })

  const conversation: Conversation = {
    id: generateId(),
    participants: ordered,
    chats,
    metadata: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }

  return { conversation, warnings }
}
