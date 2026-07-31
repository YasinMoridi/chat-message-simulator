import type { Participant } from "@/types/conversation"
import type { Message } from "@/types/message"
import type { LayoutConfig, LayoutId, LayoutTheme } from "@/types/layout"
import { ChatHeader } from "@/components/chat/ChatHeader"
import { ConversationView } from "@/components/chat/ConversationView"
import { MessageInput } from "@/components/chat/MessageInput"
import { ChatListScreen, type ChatListPreview, type ChatListEntry } from "@/components/chat/ChatListScreen"
import { getChatTitle } from "@/utils/helpers"

/**
 * Everything ChatLayout needs to render one chat - already resolved to just
 * that chat's own members and messages by the caller (MainLayout), since a
 * "conversation" in this app can now hold many independent chats at once.
 */
export interface ChatLayoutConversation {
  participants: Participant[]
  messages: Message[]
  /** This specific chat's own custom name, if it has one. */
  chatName?: string
}

interface ChatLayoutProps {
  conversation: ChatLayoutConversation
  layout: LayoutConfig
  theme: LayoutTheme
  showChrome: boolean
  activeParticipantId: string
  backgroundImageUrl: string
  backgroundImageOpacity: number
  backgroundColor: string
  conversationMode?: "scroll" | "expanded"
  conversationContainerRef?: React.Ref<HTMLDivElement>
  conversationContentRef?: React.Ref<HTMLDivElement>
  /** senderId of whoever should show the animated "..." bubble right now, if any. */
  typingSenderId?: string | null
  /** See TypingIndicator's frozenPhaseMs - only used during video export. */
  typingPhaseMs?: number
  /**
   * Progressively revealed text for the "self" participant's own message
   * currently being simulated as real keystrokes - shown live in the
   * MessageInput instead of the dots bubble. Null/undefined when that's not
   * happening right now.
   */
  typingDraftText?: string | null
  /**
   * "chat" (default) renders the normal chat screen. "home" renders the
   * simulated recent-chats list a message's backNavigation sends playback
   * to instead - every other prop below this one is only used in that mode.
   */
  screen?: "chat" | "home"
  /** Every other chat to list on the home screen. */
  homeChats?: ChatListEntry[]
  /** Last-message preview per chat id, for the home screen's rows. */
  homePreviews?: Record<string, ChatListPreview>
  /** Called with a chat id when its row is tapped on the home screen. */
  onSelectHomeChat?: (chatId: string) => void
  /**
   * Called when the chat screen's back arrow is tapped. Only wired up when
   * the currently-shown message has backNavigation.enabled.
   */
  onBack?: () => void
}

const groupStatusLabel = (participants: Participant[]) => {
  const typing = participants.find((participant) => participant.status === "typing")
  if (typing) return `${typing.name} is typing...`
  const online = participants.filter((participant) => participant.status === "online")
  if (online.length) return `${online.length} online`
  const hasStatus = participants.some((participant) => participant.status !== "empty")
  if (!hasStatus) return ""
  return "Offline"
}

const directStatusLabel = (status?: string, layoutId?: LayoutId) => {
  if (layoutId === "instagram") {
    if (status === "typing") return "Typing..."
    if (status === "online") return "Active now"
    if (status === "empty") return ""
    return "Active yesterday"
  }
  if (status === "typing") return "typing..."
  if (status === "online") return "online"
  if (status === "empty") return ""
  return "offline"
}

export const getSelfParticipantId = (participants: Participant[], activeParticipantId: string) => {
  if (participants.length === 2) {
    // In direct chats, treat the active participant as "you".
    const active = participants.find((participant) => participant.id === activeParticipantId)
    return active?.id ?? participants[0]?.id ?? ""
  }
  return participants[0]?.id ?? ""
}

export const ChatLayout = ({
  conversation,
  layout,
  theme,
  showChrome,
  activeParticipantId,
  backgroundImageUrl,
  backgroundImageOpacity,
  backgroundColor,
  conversationMode = "scroll",
  conversationContainerRef,
  conversationContentRef,
  typingSenderId,
  typingPhaseMs,
  typingDraftText,
  screen = "chat",
  homeChats = [],
  homePreviews,
  onSelectHomeChat,
  onBack,
}: ChatLayoutProps) => {
  const bodyFont = `Roboto, ${layout.fonts.body}`
  const headerFont = `Roboto, ${layout.fonts.header}`
  // The caller already resolved this down to just this chat's own members.
  const members = conversation.participants
  const selfId = getSelfParticipantId(members, activeParticipantId)
  // When "you" are the one being simulated as typing, show it as real
  // keystrokes in the input instead of the dots bubble in the chat log.
  const isSelfTypingLive =
    typingSenderId === selfId && typingDraftText !== null && typingDraftText !== undefined
  const isGroup = members.length > 2
  const headerParticipant = !isGroup
    ? members.find((participant) => participant.id !== selfId) ?? members[0]
    : undefined
  const title = isGroup ? getChatTitle(members, conversation.chatName) : headerParticipant?.name ?? "New Chat"
  const subtitle = isGroup
    ? groupStatusLabel(members)
    : directStatusLabel(headerParticipant?.status, layout.id)

  return (
    <div
      className={`chat-surface relative flex h-full w-full flex-col overflow-hidden layout-${layout.id}`}
      data-layout={layout.id}
      style={
        {
          "--chat-bg": backgroundColor || theme.colors.background,
          "--chat-surface": theme.colors.surface,
          "--chat-header": theme.colors.header,
          "--chat-header-text": theme.colors.headerText,
          "--bubble-sent": theme.colors.bubbleSent,
          "--bubble-sent-text": theme.colors.bubbleSentText,
          "--bubble-received": theme.colors.bubbleReceived,
          "--bubble-received-text": theme.colors.bubbleReceivedText,
          "--chat-input": theme.colors.surface,
          "--chat-input-inner": theme.colors.input,
          "--chat-text": theme.colors.inputText,
          "--chat-accent": theme.colors.accent,
          "--chat-muted": theme.colors.muted,
          "--chat-border": theme.colors.border,
          "--chat-pattern": theme.pattern ?? "none",
          "--chat-radius": layout.radius,
          "--layout-font-header": headerFont,
          "--layout-font-body": bodyFont,
          fontFamily: bodyFont,
        } as React.CSSProperties
      }
    >
      {backgroundImageUrl ? (
        <img
          src={backgroundImageUrl}
          alt=""
          className="chat-layer h-full w-full object-cover"
          style={{ opacity: backgroundImageOpacity }}
          aria-hidden="true"
        />
      ) : null}
      {theme.pattern ? <div className="chat-layer chat-bg-pattern" aria-hidden="true" /> : null}
      {screen === "home" ? (
        <ChatListScreen
          chats={homeChats}
          previews={homePreviews}
          theme={theme}
          onSelectChat={onSelectHomeChat ?? (() => {})}
        />
      ) : (
        <>
          {showChrome ? (
            <ChatHeader
              title={title}
              subtitle={subtitle}
              avatarUrl={!isGroup ? headerParticipant?.avatarUrl : undefined}
              avatarFallback={!isGroup ? headerParticipant?.name : title}
              isVerified={!isGroup ? headerParticipant?.isVerified : undefined}
              layout={layout}
              theme={theme}
              onBack={onBack}
            />
          ) : null}
          <div className="relative flex-1 min-h-0">
            <ConversationView
              messages={conversation.messages}
              participants={members}
              layout={layout}
              selfId={selfId}
              mode={conversationMode}
              containerRef={conversationContainerRef}
              contentRef={conversationContentRef}
              typingSenderId={isSelfTypingLive ? null : typingSenderId}
              typingPhaseMs={typingPhaseMs}
            />
          </div>
          {showChrome ? (
            <MessageInput layout={layout} typingText={isSelfTypingLive ? typingDraftText : null} />
          ) : null}
        </>
      )}
    </div>
  )
}
