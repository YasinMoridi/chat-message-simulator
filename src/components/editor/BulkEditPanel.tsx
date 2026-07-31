import { useMemo, useState } from "react"
import { CalendarClock } from "lucide-react"
import { useConversationStore } from "@/store/conversationStore"
import type { MessageStatus } from "@/types/message"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useTranslation } from "@/i18n/useTranslation"

const todayInputValue = () => new Date().toISOString().slice(0, 10)

export const BulkEditPanel = () => {
  const { t, dir } = useTranslation()
  const [open, setOpen] = useState(false)

  const conversation = useConversationStore((state) => state.conversation)
  const activeChatId = useConversationStore((state) => state.activeChatId)
  const bulkUpdateMessages = useConversationStore((state) => state.bulkUpdateMessages)
  // Sender re-assignment offers the whole roster - a bulk pass can span
  // every chat at once, each with its own members.
  const members = conversation.participants

  const [dateEnabled, setDateEnabled] = useState(false)
  const [date, setDate] = useState(todayInputValue())
  const [keepTimeOfDay, setKeepTimeOfDay] = useState(true)

  const [senderEnabled, setSenderEnabled] = useState(false)
  const [senderId, setSenderId] = useState(members[0]?.id ?? "")

  const [statusEnabled, setStatusEnabled] = useState(false)
  const [status, setStatus] = useState<MessageStatus>("read")

  const [delayEnabled, setDelayEnabled] = useState(false)
  const [delaySeconds, setDelaySeconds] = useState(1.2)

  const [applyToAllChats, setApplyToAllChats] = useState(false)

  const activeChat = conversation.chats.find((chat) => chat.id === activeChatId) ?? conversation.chats[0]
  const totalMessageCount = useMemo(
    () => conversation.chats.reduce((sum, chat) => sum + chat.messages.length, 0),
    [conversation.chats],
  )
  const affectedCount = applyToAllChats ? totalMessageCount : activeChat?.messages.length ?? 0
  const nothingSelected = !dateEnabled && !senderEnabled && !statusEnabled && !delayEnabled

  const handleApply = () => {
    if (!activeChat) return
    bulkUpdateMessages(applyToAllChats ? "all" : activeChat.id, {
      date: dateEnabled ? date : undefined,
      keepTimeOfDay: dateEnabled ? keepTimeOfDay : undefined,
      senderId: senderEnabled ? senderId : undefined,
      status: statusEnabled ? status : undefined,
      delayMs: delayEnabled ? Math.round(delaySeconds * 1000) : undefined,
    })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <CalendarClock className="h-4 w-4" />
          {t.bulkEdit.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent dir={dir} className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.bulkEdit.title}</DialogTitle>
          <DialogDescription>{t.bulkEdit.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Date */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <Label>{t.bulkEdit.dateLabel}</Label>
                <p className="text-[11px] text-slate-500">{t.bulkEdit.dateHint}</p>
              </div>
              <Switch checked={dateEnabled} onCheckedChange={setDateEnabled} />
            </div>
            {dateEnabled ? (
              <div className="space-y-2">
                <Input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-slate-500">{t.bulkEdit.keepTimeOfDay}</p>
                  <Switch checked={keepTimeOfDay} onCheckedChange={setKeepTimeOfDay} />
                </div>
              </div>
            ) : null}
          </div>

          {/* Sender */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <Label>{t.bulkEdit.senderLabel}</Label>
                <p className="text-[11px] text-slate-500">{t.bulkEdit.senderHint}</p>
              </div>
              <Switch checked={senderEnabled} onCheckedChange={setSenderEnabled} />
            </div>
            {senderEnabled ? (
              <Select value={senderId} onValueChange={setSenderId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((participant) => (
                    <SelectItem key={participant.id} value={participant.id}>
                      {participant.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {/* Status */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <Label>{t.bulkEdit.statusLabel}</Label>
                <p className="text-[11px] text-slate-500">{t.bulkEdit.statusHint}</p>
              </div>
              <Switch checked={statusEnabled} onCheckedChange={setStatusEnabled} />
            </div>
            {statusEnabled ? (
              <Select value={status} onValueChange={(value) => setStatus(value as MessageStatus)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sent">{t.bulkEdit.statusSent}</SelectItem>
                  <SelectItem value="delivered">{t.bulkEdit.statusDelivered}</SelectItem>
                  <SelectItem value="read">{t.bulkEdit.statusRead}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {/* Delay */}
          <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <Label>{t.bulkEdit.delayLabel}</Label>
                <p className="text-[11px] text-slate-500">{t.bulkEdit.delayHint}</p>
              </div>
              <Switch checked={delayEnabled} onCheckedChange={setDelayEnabled} />
            </div>
            {delayEnabled ? (
              <Input
                type="number"
                min={0}
                step={0.1}
                value={delaySeconds}
                onChange={(event) => setDelaySeconds(Number(event.target.value))}
              />
            ) : null}
          </div>

          {/* Scope */}
          {conversation.chats.length > 1 ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 py-3">
              <div className="space-y-0.5">
                <Label>{t.bulkEdit.includeSubConversations}</Label>
                <p className="text-[11px] text-slate-500">{t.bulkEdit.includeSubConversationsHint}</p>
              </div>
              <Switch checked={applyToAllChats} onCheckedChange={setApplyToAllChats} />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <p className="text-xs text-slate-500">
              {t.bulkEdit.affectedCount.replace("{count}", String(affectedCount))}
            </p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t.bulkEdit.cancel}
              </Button>
              <Button onClick={handleApply} disabled={nothingSelected}>
                {t.bulkEdit.apply}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
