import { Search, SquarePen } from "lucide-react"
import type { Participant } from "@/types/conversation"
import type { LayoutTheme } from "@/types/layout"
import { AvatarImage } from "@/components/ui/avatar-image"
import { VerifiedBadge } from "@/components/ui/verified-badge"
import { formatTimestamp } from "@/utils/helpers"

/** Which chat-app "recent chats" screen to render. Only iMessage exists so far. */
export type ChatListStyle = "imessage"

export interface ChatListPreview {
  /** Shown as the row's second line - a plain snippet, not a full bubble. */
  text: string
  timestamp?: string
}

interface ChatListScreenProps {
  /** Contacts to list - normally every participant except "you". */
  participants: Participant[]
  /** Last-message preview per participant id, if that contact has any messages yet. */
  previews?: Record<string, ChatListPreview>
  theme: LayoutTheme
  style?: ChatListStyle
  onSelectParticipant: (participantId: string) => void
}

/**
 * A simulated "recent chats" home screen - the screen backNavigation sends
 * playback to when someone backs out of a chat. Built once and driven by
 * `style` so every layout can eventually reuse the same list logic; only
 * the iMessage look is implemented right now.
 */
export const ChatListScreen = ({
  participants,
  previews = {},
  theme,
  style: _style = "imessage",
  onSelectParticipant,
}: ChatListScreenProps) => {
  return (
    <div
      className="relative z-10 flex h-full w-full flex-col"
      style={{ backgroundColor: theme.colors.background, color: theme.colors.inputText }}
    >
      <div
        className="flex flex-col gap-3 border-b px-4 pb-3 pt-4"
        style={{ borderColor: theme.colors.border }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[1.7rem] font-bold">Messages</span>
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full"
            style={{ color: theme.colors.accent }}
          >
            <SquarePen className="h-[18px] w-[18px]" />
          </span>
        </div>
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm"
          style={{ backgroundColor: theme.colors.input, color: theme.colors.muted }}
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
        </div>
      </div>
      <div className="hide-scrollbar flex-1 overflow-y-auto">
        {participants.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm" style={{ color: theme.colors.muted }}>
            No conversations yet.
          </div>
        ) : (
          participants.map((participant) => {
            const preview = previews[participant.id]
            const fallbackText = participant.name.slice(0, 2).toUpperCase()
            return (
              <button
                key={participant.id}
                type="button"
                onClick={() => onSelectParticipant(participant.id)}
                className="flex w-full items-center gap-3 border-b px-4 py-2.5 text-left"
                style={{ borderColor: theme.colors.border }}
              >
                {participant.avatarUrl ? (
                  <AvatarImage src={participant.avatarUrl} alt={participant.name} className="h-12 w-12" />
                ) : (
                  <span
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    style={{ backgroundColor: theme.colors.input, color: theme.colors.muted }}
                  >
                    {fallbackText}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1 truncate font-semibold">
                      {participant.name}
                      {participant.isVerified ? <VerifiedBadge className="h-3.5 w-3.5" /> : null}
                    </span>
                    {preview?.timestamp ? (
                      <span className="shrink-0 text-xs" style={{ color: theme.colors.muted }}>
                        {formatTimestamp(preview.timestamp)}
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-sm" style={{ color: theme.colors.muted }}>
                    {preview?.text || "No messages yet"}
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
