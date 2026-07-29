import { format } from "date-fns"
import type { Conversation, Participant } from "@/types/conversation"
import type { Message } from "@/types/message"
import {
  getConversationMembers,
  getConversationTitle,
  isGroupConversation,
} from "@/utils/helpers"

export type TranscriptLanguage = "fa" | "en"

interface Labels {
  header: (title: string) => string
  generatedAt: string
  participants: string
  you: string
  group: string
  direct: string
  mainThreadStart: string
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
  jumpToSubFromNotification: (name: string) => string
  jumpToSubFromHomeAuto: (name: string, delayMs: number) => string
  jumpToSubFromHomeManual: (name: string) => string
  backNavAvailable: string
  backNavAutoLeaves: (delayMs: number) => string
  backNavManualOnly: string
  goesHome: string
  waitsAtHome: string
  subThreadHeader: (name: string) => string
  returnToParent: string
  subThreadDeadEnd: string
  endOfSubConversation: (name: string) => string
  missingSubConversation: (name: string) => string
  endOfMain: string
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
    mainThreadStart: "=== شروع چت اصلی ===",
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
    jumpToSubFromNotification: (name) =>
      `\n>>> با زدن این نوتیف، می‌ریم توی یه چت جدا و مستقل با «${name}» >>>`,
    jumpToSubFromHomeAuto: (name, ms) =>
      `\n>>> توی صفحه‌ی لیست چت‌ها، بعد از ${ms}ms خودکار روی «${name}» زده می‌شه و چتش باز می‌شه >>>`,
    jumpToSubFromHomeManual: (name) =>
      `\n>>> از صفحه‌ی لیست چت‌ها می‌شه رفت توی چت «${name}» (نیاز به کلیک دستی داره) >>>`,
    backNavAvailable: "  - دکمه‌ی برگشت (Back) روی هدر فعاله - می‌شه از این چت زد بیرون.",
    backNavAutoLeaves: (ms) => `  - بعد از ${ms}ms خودکار می‌زنه بیرون و می‌ره صفحه‌ی لیست چت‌ها (Home).`,
    backNavManualOnly: "  - فقط با زدن دستی دکمه‌ی برگشت از این چت خارج می‌شیم.",
    goesHome: "  --- می‌ریم به صفحه‌ی لیست چت‌ها (Home) ---",
    waitsAtHome: "  (صفحه‌ی لیست چت‌ها همینجا می‌مونه تا کسی دستی یه مخاطب رو بزنه)",
    subThreadHeader: (name) => `\n--- چت جداگانه با «${name}» شروع شد ---`,
    returnToParent: "\n<<< این پیام برمی‌گردونه به چت اصلی، دقیقا از همونجایی که مونده بود <<<",
    subThreadDeadEnd: "(هیچ برگشتی به چت اصلی تعریف نشده - داستان همینجا توی این چت جانبی تموم می‌شه)",
    endOfSubConversation: (name) => `--- پایان چت جداگانه با «${name}» ---\n`,
    missingSubConversation: (name) =>
      `  [!] هشدار: قرار بود چت جداگانه‌ای با «${name}» باز بشه ولی همچین چتی تعریف نشده.`,
    endOfMain: "=== پایان چت اصلی ===",
  },
  en: {
    header: (title) => `Full conversation transcript: ${title}`,
    generatedAt: "Generated at",
    participants: "Participants",
    you: "You",
    group: "group",
    direct: "direct",
    mainThreadStart: "=== MAIN CHAT START ===",
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
    jumpToSubFromNotification: (name) =>
      `\n>>> Tapping this notification jumps into a separate, standalone chat with "${name}" >>>`,
    jumpToSubFromHomeAuto: (name, ms) =>
      `\n>>> On the chat-list screen, "${name}" is auto-tapped after ${ms}ms, opening their chat >>>`,
    jumpToSubFromHomeManual: (name) =>
      `\n>>> From the chat-list screen, "${name}"'s chat can be opened (needs a manual tap) >>>`,
    backNavAvailable: "  - Back button is enabled on the header - this chat can be exited here.",
    backNavAutoLeaves: (ms) => `  - Automatically leaves for the chat-list (Home) screen after ${ms}ms.`,
    backNavManualOnly: "  - Only leaves this chat if the back button is tapped manually.",
    goesHome: "  --- Goes to the chat-list (Home) screen ---",
    waitsAtHome: "  (The chat-list screen just sits here until a contact is tapped manually)",
    subThreadHeader: (name) => `\n--- Separate chat with "${name}" begins ---`,
    returnToParent: "\n<<< This message returns to the main chat, exactly where it left off <<<",
    subThreadDeadEnd: "(No return to the main chat is set - the story ends here in this side chat)",
    endOfSubConversation: (name) => `--- End of separate chat with "${name}" ---\n`,
    missingSubConversation: (name) =>
      `  [!] Warning: a separate chat with "${name}" was supposed to open, but no such chat exists.`,
    endOfMain: "=== MAIN CHAT END ===",
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
 * Recursively renders a thread (the main conversation, or any side-chat
 * opened from it) into `out`, following every branch a real playback could
 * take: linked clickable notifications, back-navigation to the home screen
 * and back into a contact's side-chat, and returnToParent jumps back to
 * whichever thread opened this one. Mirrors the branching logic in
 * useConversationPlayback.ts so the transcript matches what actually plays.
 */
const renderThread = (
  messages: Message[],
  participants: Participant[],
  selfId: string,
  subConversationsById: Map<string, Message[]>,
  L: Labels,
  out: string[],
  visiting: Set<string>,
): { returnedToParent: boolean } => {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]
    out.push(...renderMessageLines(message, i, participants, selfId, L))

    // Clickable notification linked to a real side-chat.
    if (message.type === "notification" && message.notificationClickable && message.linkedParticipantId) {
      const name = participantName(participants, message.linkedParticipantId, selfId, L.you)
      out.push(L.jumpToSubFromNotification(name))
      const subMessages = subConversationsById.get(message.linkedParticipantId)
      if (!subMessages) {
        out.push(L.missingSubConversation(name))
      } else if (!visiting.has(message.linkedParticipantId)) {
        visiting.add(message.linkedParticipantId)
        out.push(L.subThreadHeader(name))
        const result = renderThread(subMessages, participants, selfId, subConversationsById, L, out, visiting)
        if (!result.returnedToParent) out.push(`  ${L.subThreadDeadEnd}`)
        out.push(L.endOfSubConversation(name))
        visiting.delete(message.linkedParticipantId)
      }
    }

    // Back navigation to the home (chat-list) screen, possibly auto-opening a contact.
    if (message.backNavigation?.enabled && message.backNavigation.autoOpen) {
      out.push(L.goesHome)
      const targetId = message.backNavigation.autoSelectParticipantId
      if (targetId) {
        const name = participantName(participants, targetId, selfId, L.you)
        out.push(L.jumpToSubFromHomeAuto(name, message.backNavigation.autoSelectDelayMs ?? 900))
        const subMessages = subConversationsById.get(targetId)
        if (!subMessages) {
          out.push(L.missingSubConversation(name))
        } else if (!visiting.has(targetId)) {
          visiting.add(targetId)
          out.push(L.subThreadHeader(name))
          const result = renderThread(subMessages, participants, selfId, subConversationsById, L, out, visiting)
          if (!result.returnedToParent) out.push(`  ${L.subThreadDeadEnd}`)
          out.push(L.endOfSubConversation(name))
          visiting.delete(targetId)
        }
      } else {
        out.push(`  ${L.waitsAtHome}`)
      }
    }

    // returnToParent ends this thread and hands control back to the caller,
    // exactly at the point right after wherever this thread was opened from.
    if (message.returnToParent) {
      out.push(L.returnToParent)
      return { returnedToParent: true }
    }
  }
  return { returnedToParent: false }
}

/**
 * Builds a single, fully linearized plain-text transcript of the whole
 * conversation: every message with all of its metadata (timestamp, sender,
 * status, delay, hidden flag), every notification banner and its settings,
 * every jump into a linked side-chat (from a clickable notification or from
 * back-navigation's simulated home screen), and every return back to the
 * main thread - in the order playback would actually show them.
 */
export const buildConversationTranscript = (
  conversation: Conversation,
  selfId: string,
  language: TranscriptLanguage = "fa",
): string => {
  const L = LABELS[language]
  const members = getConversationMembers(conversation)
  const title = getConversationTitle(conversation)
  const out: string[] = []

  out.push(L.header(title))
  out.push(`${L.generatedAt}: ${safeTimestamp(new Date().toISOString())}`)
  out.push(
    `${L.participants} (${isGroupConversation(conversation) ? L.group : L.direct}): ${members
      .map((p) => (p.id === selfId ? `${p.name} (${L.you})` : p.name))
      .join(", ")}`,
  )
  out.push("")
  out.push(L.mainThreadStart)
  out.push("")

  const subConversationsById = new Map<string, Message[]>(
    (conversation.subConversations ?? []).map((sub) => [sub.participantId, sub.messages]),
  )

  renderThread(conversation.messages, conversation.participants, selfId, subConversationsById, L, out, new Set())

  out.push("")
  out.push(L.endOfMain)

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
