import { format } from "date-fns"
import type { Chat, Conversation, Participant } from "@/types/conversation"
import type { Message } from "@/types/message"
import { getChatMembers, getChatTitle, isGroupChat } from "@/utils/helpers"

export type TranscriptLanguage = "fa" | "en"

interface Labels {
  header: (title: string) => string
  generatedAt: string
  participants: string
  you: string
  group: string
  direct: string
  chatStart: (title: string) => string
  chatEnd: (title: string) => string
  senderStatus: (status: string) => string
  delay: (ms: number) => string
  hidden: string
  imageLine: (url: string) => string
  systemLine: string
  notificationLine: string
  notificationOverrideName: (name: string) => string
  notificationOverrideApp: (app: string) => string
  notificationOverrideAvatar: (url: string) => string
  notificationNotClickable: string
  notificationClickableManual: string
  notificationAutoOpen: (delayMs: number) => string
  notificationOpenDelay: (delayMs: number) => string
  jumpToChatFromNotification: (name: string) => string
  jumpToChatFromHomeAuto: (name: string, delayMs: number) => string
  jumpToChatFromHomeManual: (name: string) => string
  backNavAvailable: string
  backNavAutoLeaves: (delayMs: number) => string
  backNavManualOnly: string
  goesHome: string
  waitsAtHome: string
  linkedChatHeader: (name: string) => string
  returnToParent: string
  linkedChatDeadEnd: string
  endOfLinkedChat: (name: string) => string
  missingChat: (name: string) => string
}

const participantName = (participants: Participant[], id: string, selfId: string, you: string) => {
  if (id === selfId) return you
  return participants.find((p) => p.id === id)?.name ?? id
}

const LABELS: Record<TranscriptLanguage, Labels> = {
  fa: {
    header: (title) => `متن کامل گفتگو: ${title}`,
    generatedAt: "تاریخ خروجی‌گیری",
    participants: "شرکت‌کننده‌ها",
    you: "شما",
    group: "گروهی",
    direct: "دو نفره",
    chatStart: (title) => `=== شروع چت: ${title} ===`,
    chatEnd: (title) => `=== پایان چت: ${title} ===`,
    senderStatus: (status) => `وضعیت: ${status}`,
    delay: (ms) => `تاخیر قبل از این پیام: ${ms}ms`,
    hidden: "(این پیام مخفیه و توی پخش نمایش داده نمی‌شه)",
    imageLine: (url) => `[عکس]: ${url}`,
    systemLine: "[پیام سیستمی]",
    notificationLine: "🔔 نوتیفیکیشن نمایش داده می‌شه:",
    notificationOverrideName: (name) => `  - اسم فرستنده‌ی نوتیف (به‌جای فرستنده‌ی واقعی): ${name}`,
    notificationOverrideApp: (app) => `  - اسم اپ نوتیف: ${app}`,
    notificationOverrideAvatar: (url) => `  - آواتار نوتیف: ${url}`,
    notificationNotClickable: "  - قابل کلیک نیست، فقط نمایش داده می‌شه و می‌ره کنار.",
    notificationClickableManual: "  - قابل کلیکه (باید دستی روش زده بشه تا باز شه).",
    notificationAutoOpen: (ms) => `  - خودش بعد از ${ms}ms خودکار باز می‌شه (لازم نیست کسی بزنه روش).`,
    notificationOpenDelay: (ms) => `  - بعد از زده شدن، ${ms}ms طول می‌کشه تا چت واقعا باز بشه.`,
    jumpToChatFromNotification: (name) =>
      `\n>>> با زدن این نوتیف، می‌ریم توی یه چت جدا و مستقل: «${name}» >>>`,
    jumpToChatFromHomeAuto: (name, ms) =>
      `\n>>> توی صفحه‌ی لیست چت‌ها، بعد از ${ms}ms خودکار روی «${name}» زده می‌شه و چتش باز می‌شه >>>`,
    jumpToChatFromHomeManual: (name) =>
      `\n>>> از صفحه‌ی لیست چت‌ها می‌شه رفت توی چت «${name}» (نیاز به کلیک دستی داره) >>>`,
    backNavAvailable: "  - دکمه‌ی برگشت (Back) روی هدر فعاله - می‌شه از این چت زد بیرون.",
    backNavAutoLeaves: (ms) => `  - بعد از ${ms}ms خودکار می‌زنه بیرون و می‌ره صفحه‌ی لیست چت‌ها (Home).`,
    backNavManualOnly: "  - فقط با زدن دستی دکمه‌ی برگشت از این چت خارج می‌شیم.",
    goesHome: "  --- می‌ریم به صفحه‌ی لیست چت‌ها (Home) ---",
    waitsAtHome: "  (صفحه‌ی لیست چت‌ها همینجا می‌مونه تا کسی دستی یه مخاطب رو بزنه)",
    linkedChatHeader: (name) => `\n--- چت «${name}» از اینجا شروع شد ---`,
    returnToParent: "\n<<< این پیام برمی‌گردونه به چتی که این‌جا رو باز کرده بود، دقیقا از همونجایی که مونده بود <<<",
    linkedChatDeadEnd: "(هیچ برگشتی تعریف نشده - داستان همینجا توی این چت تموم می‌شه)",
    endOfLinkedChat: (name) => `--- پایان چت «${name}» ---\n`,
    missingChat: (name) => `  [!] هشدار: قرار بود چتی به اسم «${name}» باز بشه ولی همچین چتی تعریف نشده.`,
  },
  en: {
    header: (title) => `Full conversation transcript: ${title}`,
    generatedAt: "Generated at",
    participants: "Participants",
    you: "You",
    group: "group",
    direct: "direct",
    chatStart: (title) => `=== CHAT START: ${title} ===`,
    chatEnd: (title) => `=== CHAT END: ${title} ===`,
    senderStatus: (status) => `status: ${status}`,
    delay: (ms) => `delay before this message: ${ms}ms`,
    hidden: "(this message is hidden and is not shown during playback)",
    imageLine: (url) => `[image]: ${url}`,
    systemLine: "[system message]",
    notificationLine: "🔔 Notification banner appears:",
    notificationOverrideName: (name) => `  - notification sender name (overrides real sender): ${name}`,
    notificationOverrideApp: (app) => `  - notification app name: ${app}`,
    notificationOverrideAvatar: (url) => `  - notification avatar: ${url}`,
    notificationNotClickable: "  - not clickable, just shows and slides away.",
    notificationClickableManual: "  - clickable (needs a manual tap to open).",
    notificationAutoOpen: (ms) => `  - auto-taps itself after ${ms}ms (no manual tap needed).`,
    notificationOpenDelay: (ms) => `  - after being tapped, takes ${ms}ms to actually open the chat.`,
    jumpToChatFromNotification: (name) =>
      `\n>>> Tapping this notification jumps into a separate, standalone chat: "${name}" >>>`,
    jumpToChatFromHomeAuto: (name, ms) =>
      `\n>>> On the chat-list screen, "${name}" is auto-tapped after ${ms}ms, opening their chat >>>`,
    jumpToChatFromHomeManual: (name) =>
      `\n>>> From the chat-list screen, "${name}" can be opened (needs a manual tap) >>>`,
    backNavAvailable: "  - Back button is enabled on the header - this chat can be exited here.",
    backNavAutoLeaves: (ms) => `  - Automatically leaves for the chat-list (Home) screen after ${ms}ms.`,
    backNavManualOnly: "  - Only leaves this chat if the back button is tapped manually.",
    goesHome: "  --- Goes to the chat-list (Home) screen ---",
    waitsAtHome: "  (The chat-list screen just sits here until a contact is tapped manually)",
    linkedChatHeader: (name) => `\n--- Chat "${name}" begins here ---`,
    returnToParent: "\n<<< This message returns to whichever chat opened this one, exactly where it left off <<<",
    linkedChatDeadEnd: "(No return is set - the story ends here in this chat)",
    endOfLinkedChat: (name) => `--- End of chat "${name}" ---\n`,
    missingChat: (name) => `  [!] Warning: a chat named "${name}" was supposed to open, but no such chat exists.`,
  },
}

const safeTimestamp = (timestamp: string) => {
  try {
    return format(new Date(timestamp), "yyyy-MM-dd HH:mm:ss")
  } catch {
    return timestamp
  }
}

/**
 * Renders one message's full detail (sender, timestamp, content, status,
 * delay, and every type-specific setting) as a block of lines.
 */
const renderMessageLines = (
  message: Message,
  index: number,
  participants: Participant[],
  selfId: string,
  L: Labels,
): string[] => {
  const lines: string[] = []
  const senderName = participantName(participants, message.senderId, selfId, L.you)
  const timestamp = safeTimestamp(message.timestamp)

  lines.push(`[${index + 1}] ${timestamp} - ${senderName}`)

  if (message.type === "system") {
    lines.push(`    ${L.systemLine} ${message.content}`)
  } else if (message.type === "image") {
    if (message.content) lines.push(`    ${message.content}`)
    if (message.imageUrl) lines.push(`    ${L.imageLine(message.imageUrl)}`)
  } else if (message.type === "notification") {
    lines.push(`    ${L.notificationLine}`)
    lines.push(`    محتوا/content: ${message.content}`)
    if (message.notificationOverride?.enabled) {
      if (message.notificationOverride.senderName)
        lines.push(`  ${L.notificationOverrideName(message.notificationOverride.senderName)}`)
      if (message.notificationOverride.appName)
        lines.push(`  ${L.notificationOverrideApp(message.notificationOverride.appName)}`)
      if (message.notificationOverride.avatarUrl)
        lines.push(`  ${L.notificationOverrideAvatar(message.notificationOverride.avatarUrl)}`)
    }
    if (message.notificationClickable) {
      if (message.notificationAutoOpen) {
        lines.push(`  ${L.notificationAutoOpen(message.notificationAutoOpenDelayMs ?? 1500)}`)
      } else {
        lines.push(`  ${L.notificationClickableManual}`)
      }
      lines.push(`  ${L.notificationOpenDelay(message.notificationOpenDelayMs ?? 700)}`)
    } else {
      lines.push(`  ${L.notificationNotClickable}`)
    }
  } else {
    lines.push(`    ${message.content}`)
  }

  lines.push(`    ${L.senderStatus(message.status)} | ${L.delay(message.delayMs ?? 1200)}`)
  if (message.isHidden) lines.push(`    ${L.hidden}`)

  if (message.backNavigation?.enabled) {
    lines.push(`  ${L.backNavAvailable}`)
    if (message.backNavigation.autoOpen) {
      lines.push(`  ${L.backNavAutoLeaves(message.backNavigation.autoOpenDelayMs ?? 900)}`)
    } else {
      lines.push(`  ${L.backNavManualOnly}`)
    }
  }

  return lines
}

/**
 * Recursively renders a chat's messages into `out`, following every branch
 * a real playback could take: linked clickable notifications, back-
 * navigation to the home screen and back into another chat, and
 * returnToParent jumps back to whichever chat opened this one. Mirrors the
 * branching logic in useConversationPlayback.ts so the transcript matches
 * what actually plays.
 */
const renderThread = (
  messages: Message[],
  participants: Participant[],
  selfId: string,
  chatsById: Map<string, { title: string; messages: Message[] }>,
  L: Labels,
  out: string[],
  visiting: Set<string>,
): { returnedToParent: boolean } => {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    out.push(...renderMessageLines(message, i, participants, selfId, L))

    // Clickable notification linked to a real, separate chat.
    if (message.type === "notification" && message.notificationClickable && message.linkedChatId) {
      const target = chatsById.get(message.linkedChatId)
      const name = target?.title ?? message.linkedChatId
      out.push(L.jumpToChatFromNotification(name))
      if (!target) {
        out.push(L.missingChat(name))
      } else if (!visiting.has(message.linkedChatId)) {
        visiting.add(message.linkedChatId)
        out.push(L.linkedChatHeader(name))
        const result = renderThread(target.messages, participants, selfId, chatsById, L, out, visiting)
        if (!result.returnedToParent) out.push(`  ${L.linkedChatDeadEnd}`)
        out.push(L.endOfLinkedChat(name))
        visiting.delete(message.linkedChatId)
      }
    }

    // Back navigation to the home (chat-list) screen, possibly auto-opening a chat.
    if (message.backNavigation?.enabled && message.backNavigation.autoOpen) {
      out.push(L.goesHome)
      const targetId = message.backNavigation.autoSelectChatId
      if (targetId) {
        const target = chatsById.get(targetId)
        const name = target?.title ?? targetId
        out.push(L.jumpToChatFromHomeAuto(name, message.backNavigation.autoSelectDelayMs ?? 900))
        if (!target) {
          out.push(L.missingChat(name))
        } else if (!visiting.has(targetId)) {
          visiting.add(targetId)
          out.push(L.linkedChatHeader(name))
          const result = renderThread(target.messages, participants, selfId, chatsById, L, out, visiting)
          if (!result.returnedToParent) out.push(`  ${L.linkedChatDeadEnd}`)
          out.push(L.endOfLinkedChat(name))
          visiting.delete(targetId)
        }
      } else {
        out.push(`  ${L.waitsAtHome}`)
      }
    }

    // returnToParent ends this chat and hands control back to the caller,
    // exactly at the point right after wherever this chat was opened from.
    if (message.returnToParent) {
      out.push(L.returnToParent)
      return { returnedToParent: true }
    }
  }
  return { returnedToParent: false }
}

/**
 * Builds a single, fully linearized plain-text transcript of every chat in
 * the project: each chat gets its own section (with all of its message
 * metadata, notification banners, linked-chat jumps, and returns) in the
 * order playback would actually show them.
 */
export const buildConversationTranscript = (
  conversation: Conversation,
  selfId: string,
  language: TranscriptLanguage = "fa",
): string => {
  const L = LABELS[language]
  const out: string[] = []

  const chatsById = new Map<string, { title: string; messages: Message[] }>(
    conversation.chats.map((chat) => [
      chat.id,
      { title: getChatTitle(getChatMembers(conversation, chat), chat.name), messages: chat.messages },
    ]),
  )

  out.push(L.header(conversation.chats.length === 1 ? chatsById.get(conversation.chats[0].id)!.title : "All chats"))
  out.push(`${L.generatedAt}: ${safeTimestamp(new Date().toISOString())}`)
  out.push("")

  conversation.chats.forEach((chat: Chat) => {
    const members = getChatMembers(conversation, chat)
    const title = chatsById.get(chat.id)!.title
    out.push(L.chatStart(title))
    out.push(
      `${L.participants} (${isGroupChat(members) ? L.group : L.direct}): ${members
        .map((p) => (p.id === selfId ? `${p.name} (${L.you})` : p.name))
        .join(", ")}`,
    )
    out.push("")
    renderThread(chat.messages, conversation.participants, selfId, chatsById, L, out, new Set([chat.id]))
    out.push("")
    out.push(L.chatEnd(title))
    out.push("")
  })

  return out.join("\n")
}

/** Triggers a browser download of the transcript as a .txt file. */
export const downloadConversationTranscript = (
  conversation: Conversation,
  selfId: string,
  language: TranscriptLanguage = "fa",
) => {
  const text = buildConversationTranscript(conversation, selfId, language)
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = "chat-transcript.txt"
  link.click()
  URL.revokeObjectURL(url)
}
