import { useState } from "react"
import { Pencil, Trash2 } from "lucide-react"
import type { Message } from "@/types/message"
import { useConversationStore } from "@/store/conversationStore"
import { getSelfParticipantId } from "@/components/layout/ChatLayout"
import { MessageForm } from "@/components/editor/MessageForm"
import { Button } from "@/components/ui/button"
import { formatTimestamp } from "@/utils/helpers"
import { useTranslation } from "@/i18n/useTranslation"

interface LinkedConversationEditorProps {
  /** The participant this side-chat is with (e.g. Sara). */
  participantId: string
}

/**
 * Inline editor for a notification's linked side-chat: the real, separate
 * conversation that opens when that notification is tapped. Lets you write
 * "your" and their messages back and forth, and mark any message as the
 * point where playback should return to the main conversation.
 */
export const LinkedConversationEditor = ({ participantId }: LinkedConversationEditorProps) => {
  const { t } = useTranslation()
  const participants = useConversationStore((state) => state.conversation.participants)
  const activeParticipantId = useConversationStore((state) => state.activeParticipantId)
  const subConversations = useConversationStore((state) => state.conversation.subConversations)
  const addSubConversationMessage = useConversationStore((state) => state.addSubConversationMessage)
  const updateSubConversationMessage = useConversationStore((state) => state.updateSubConversationMessage)
  const deleteSubConversationMessage = useConversationStore((state) => state.deleteSubConversationMessage)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [isAddOpen, setIsAddOpen] = useState(false)

  const otherParticipant = participants.find((participant) => participant.id === participantId)
  const selfId = getSelfParticipantId(participants, activeParticipantId)
  const selfParticipant = participants.find((participant) => participant.id === selfId)
  const threadMessages = subConversations?.find((entry) => entry.participantId === participantId)?.messages ?? []

  if (!otherParticipant || !selfParticipant) return null

  const threadParticipants = [selfParticipant, otherParticipant]
  const editingMessage = threadMessages.find((message) => message.id === editingId) ?? null

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3">
      <div className="space-y-0.5">
        <div className="text-xs font-semibold text-slate-700">
          {t.messageForm.linkedThreadEditorTitle.replace("{name}", otherParticipant.name)}
        </div>
        <p className="text-[11px] text-slate-500">{t.messageForm.linkedThreadEditorHint}</p>
      </div>

      {threadMessages.length ? (
        <div className="space-y-1.5">
          {threadMessages.map((message) => {
            const sender = threadParticipants.find((participant) => participant.id === message.senderId)
            return (
              <div
                key={message.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-slate-800">
                    <span className="text-slate-500">{sender?.name ?? "?"}: </span>
                    {message.type === "image" ? t.messageForm.typeImage : message.content}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
                    <span>{formatTimestamp(message.timestamp)}</span>
                    {message.returnToParent ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700">
                        {t.messageForm.returnsToMainBadge}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => {
                    setEditingId(message.id)
                    setIsAddOpen(false)
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0"
                  onClick={() => deleteSubConversationMessage(participantId, message.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-[11px] text-slate-400">{t.messageForm.linkedThreadEmpty}</p>
      )}

      {editingMessage ? (
        <div className="rounded-lg border border-slate-200 bg-white p-2.5">
          <MessageForm
            key={editingMessage.id}
            participants={threadParticipants}
            initial={editingMessage}
            compact
            isSubMessage
            submitLabel={t.messageForm.saveChanges}
            onSubmit={(payload) => {
              updateSubConversationMessage(participantId, editingMessage.id, payload)
              setEditingId(null)
            }}
            onCancel={() => setEditingId(null)}
          />
        </div>
      ) : isAddOpen ? (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-2.5">
          <MessageForm
            key="new-linked-message"
            participants={threadParticipants}
            initial={null}
            defaultSenderId={otherParticipant.id}
            compact
            resetOnSubmit
            isSubMessage
            submitLabel={t.messageForm.addMessage}
            onSubmit={(payload) => addSubConversationMessage(participantId, payload)}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => setIsAddOpen(false)}>
            {t.messageForm.cancel}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setIsAddOpen(true)}>
          {t.messageForm.linkedThreadAddMessage}
        </Button>
      )}
    </div>
  )
}
