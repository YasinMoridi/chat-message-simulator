import { useEffect, useRef, useState } from "react"
import { LinkedConversationEditor } from "@/components/editor/LinkedConversationEditor"
import type { Message } from "@/types/message"
import {
  DEFAULT_MESSAGE_DELAY_MS,
  DEFAULT_NOTIFICATION_OPEN_DELAY_MS,
  DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS,
} from "@/types/message"
import type { Participant } from "@/types/conversation"
import { useConversationStore } from "@/store/conversationStore"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/utils/cn"
import { readFileAsDataUrl } from "@/utils/helpers"
import { useTranslation } from "@/i18n/useTranslation"
import { Clipboard, ImagePlus, X } from "lucide-react"

interface MessageFormProps {
  participants: Participant[]
  /**
   * Full character roster to offer as a notification's linked-chat target -
   * falls back to `participants` when omitted. Kept separate from
   * `participants` because the sender list for THIS conversation may be
   * narrower (only its actual members) than the whole roster you can still
   * link a notification to.
   */
  rosterParticipants?: Participant[]
  initial?: Message | null
  defaultSenderId?: string
  compact?: boolean
  resetOnSubmit?: boolean
  submitLabel?: string
  advancedOpen?: boolean
  onToggleAdvanced?: () => void
  /**
   * True when this form is editing a message that lives inside a
   * notification's linked side-chat (not the main conversation). Swaps the
   * notification-authoring block for a single "return to main chat" toggle.
   */
  isSubMessage?: boolean
  onSubmit: (payload: {
    senderId: string
    content: string
    imageUrl?: string
    timestamp: string
    type: Message["type"]
    status: Message["status"]
    delayMs: number
    notificationOverride?: Message["notificationOverride"]
    notificationClickable?: boolean
    notificationOpenDelayMs?: number
    notificationAutoOpen?: boolean
    notificationAutoOpenDelayMs?: number
    linkedParticipantId?: string
    returnToParent?: boolean
  }) => void
  onCancel?: () => void
}

const resolveSenderId = (preferredId: string | undefined, participants: Participant[]) => {
  if (preferredId && participants.some((participant) => participant.id === preferredId)) {
    return preferredId
  }
  return participants[0]?.id ?? ""
}

/** Colors cycled through when a brand-new sender is created by typing a name that doesn't match anyone yet. */
const NEW_PARTICIPANT_COLORS = ["#22c55e", "#0b84ff", "#f97316", "#a855f7", "#ef4444", "#14b8a6"]
const pickNewParticipantColor = (participantCount: number) =>
  NEW_PARTICIPANT_COLORS[participantCount % NEW_PARTICIPANT_COLORS.length]

const toInputValue = (iso: string) => {
  const date = new Date(iso)
  const offset = date.getTimezoneOffset() * 60000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

const fromInputValue = (value: string) => new Date(value).toISOString()

export const MessageForm = ({
  participants,
  rosterParticipants,
  initial,
  defaultSenderId,
  compact,
  resetOnSubmit,
  submitLabel,
  advancedOpen,
  onToggleAdvanced,
  isSubMessage = false,
  onSubmit,
  onCancel,
}: MessageFormProps) => {
  const { t } = useTranslation()
  const [content, setContent] = useState(initial?.content ?? "")
  const [senderId, setSenderId] = useState(
    initial?.senderId ?? resolveSenderId(defaultSenderId, participants),
  )
  const [senderNameInput, setSenderNameInput] = useState(
    () =>
      participants.find(
        (participant) =>
          participant.id === (initial?.senderId ?? resolveSenderId(defaultSenderId, participants)),
      )?.name ?? "",
  )
  const [timestamp, setTimestamp] = useState(
    initial?.timestamp ? toInputValue(initial.timestamp) : toInputValue(new Date().toISOString()),
  )
  const [type, setType] = useState<Message["type"]>(initial?.type ?? "text")
  const [status, setStatus] = useState<Message["status"]>(initial?.status ?? "sent")
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? "")
  const [imageError, setImageError] = useState<string | null>(null)
  const [delaySeconds, setDelaySeconds] = useState(
    (initial?.delayMs ?? DEFAULT_MESSAGE_DELAY_MS) / 1000,
  )
  const [notificationOverrideEnabled, setNotificationOverrideEnabled] = useState(
    initial?.notificationOverride?.enabled ?? false,
  )
  const [notificationSenderName, setNotificationSenderName] = useState(
    initial?.notificationOverride?.senderName ?? "",
  )
  const [notificationAppName, setNotificationAppName] = useState(
    initial?.notificationOverride?.appName ?? "",
  )
  const [notificationAvatarUrl, setNotificationAvatarUrl] = useState(
    initial?.notificationOverride?.avatarUrl ?? "",
  )
  const [notificationClickable, setNotificationClickable] = useState(
    initial?.notificationClickable ?? false,
  )
  const [notificationOpenDelaySeconds, setNotificationOpenDelaySeconds] = useState(
    (initial?.notificationOpenDelayMs ?? DEFAULT_NOTIFICATION_OPEN_DELAY_MS) / 1000,
  )
  const [notificationAutoOpen, setNotificationAutoOpen] = useState(
    initial?.notificationAutoOpen ?? false,
  )
  const [notificationAutoOpenDelaySeconds, setNotificationAutoOpenDelaySeconds] = useState(
    (initial?.notificationAutoOpenDelayMs ?? DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS) / 1000,
  )
  const [linkedParticipantId, setLinkedParticipantId] = useState(initial?.linkedParticipantId ?? "")
  const [returnToParent, setReturnToParent] = useState(initial?.returnToParent ?? false)
  const showAdvanced = advancedOpen ?? true
  const showAdvancedToggle = typeof advancedOpen === "boolean" && typeof onToggleAdvanced === "function"
  const previousDefaultRef = useRef(defaultSenderId)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const setDraftMessage = useConversationStore((state) => state.setDraftMessage)
  const addParticipant = useConversationStore((state) => state.addParticipant)
  const ensureConversationMember = useConversationStore((state) => state.ensureConversationMember)
  const notificationSenderNames = useConversationStore((state) => state.notificationSenderNames)
  const addNotificationSenderName = useConversationStore((state) => state.addNotificationSenderName)

  // Mirror what's being typed into the preview as a live bubble, only for
  // the "new message" form - editing an existing message already shows its
  // (real) bubble in the chat.
  useEffect(() => {
    if (initial) return
    const hasContent = type === "image" ? Boolean(imageUrl) : Boolean(content.trim())
    if (!hasContent) {
      setDraftMessage(null)
      return
    }
    setDraftMessage({
      senderId,
      content,
      imageUrl: type === "image" ? imageUrl : undefined,
      type,
    })
  }, [initial, content, senderId, type, imageUrl, setDraftMessage])

  // Clear the draft once this form goes away (submitted, cancelled, or closed).
  useEffect(() => {
    return () => {
      setDraftMessage(null)
    }
  }, [setDraftMessage])

  useEffect(() => {
    if (initial) return
    const previousDefault = previousDefaultRef.current
    previousDefaultRef.current = defaultSenderId
    const nextDefault = resolveSenderId(defaultSenderId, participants)
    setSenderId((current) => {
      const isValid = participants.some((participant) => participant.id === current)
      if (!current || !isValid || current === previousDefault) {
        return nextDefault
      }
      return current
    })
  }, [defaultSenderId, initial, participants])

  // Whenever senderId changes for reasons other than free typing (initial
  // load, the default-sync above, picking an existing participant), mirror
  // its name into the text field. This intentionally does NOT run while the
  // user is typing a name that doesn't match anyone yet, since senderId
  // won't have changed in that case - so an in-progress new name is never
  // clobbered.
  useEffect(() => {
    const match = participants.find((participant) => participant.id === senderId)
    if (match) setSenderNameInput(match.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderId])

  const insertAtCursor = (text: string) => {
    const element = textareaRef.current
    if (!element) {
      setContent((current) => (current ? `${current}\n${text}` : text))
      return
    }
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? element.value.length
    setContent((current) => current.slice(0, start) + text + current.slice(end))
    requestAnimationFrame(() => {
      element.focus()
      const nextPos = start + text.length
      element.setSelectionRange(nextPos, nextPos)
    })
  }

  const handlePaste = async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText()
        if (text) {
          insertAtCursor(text)
          return
        }
      }
    } catch (error) {
      console.error("Paste failed", error)
    }
    const fallback = window.prompt("Paste message")
    if (fallback) insertAtCursor(fallback)
  }

  const handleImageUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setImageError(t.messageForm.onlyImageFiles)
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setImageError(t.messageForm.imageTooLarge5mb)
      return
    }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      setImageUrl(dataUrl)
      setImageError(null)
    } catch (error) {
      console.error("Failed to read image file", error)
      setImageError(t.messageForm.couldNotReadImage)
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (type === "image" && !imageUrl) {
          setImageError(t.messageForm.pleaseUploadImage)
          return
        }
        if (type === "notification" && notificationOverrideEnabled && notificationSenderName.trim()) {
          addNotificationSenderName(notificationSenderName)
        }
        const trimmedSenderName = senderNameInput.trim()
        // Match against the full roster (when known), not just the
        // narrower list this form offers as senders - otherwise typing an
        // existing-but-benched character's name would create a duplicate.
        const roster = rosterParticipants ?? participants
        const matchedParticipant = roster.find(
          (participant) => participant.name.trim().toLowerCase() === trimmedSenderName.toLowerCase(),
        )
        let finalSenderId = matchedParticipant?.id ?? senderId
        if (!matchedParticipant && trimmedSenderName) {
          addParticipant({
            name: trimmedSenderName,
            status: "online",
            color: pickNewParticipantColor(roster.length),
          })
          const created = useConversationStore.getState().conversation.participants.at(-1)
          if (created) finalSenderId = created.id
        }
        // rosterParticipants is only passed for the main conversation's
        // forms - a character who's about to speak here should count as a
        // member, whether they were just created or already existed but
        // were benched.
        if (rosterParticipants && finalSenderId) {
          ensureConversationMember(finalSenderId)
        }
        onSubmit({
          senderId: finalSenderId,
          content,
          imageUrl: type === "image" ? imageUrl : undefined,
          timestamp: fromInputValue(timestamp),
          type,
          status,
          delayMs: Math.round(Math.max(0, delaySeconds) * 1000),
          notificationOverride:
            type === "notification" && notificationOverrideEnabled
              ? {
                  enabled: true,
                  senderName: notificationSenderName.trim() || undefined,
                  appName: notificationAppName.trim() || undefined,
                  avatarUrl: notificationAvatarUrl.trim() || undefined,
                }
              : { enabled: false },
          notificationClickable: type === "notification" ? notificationClickable : undefined,
          notificationOpenDelayMs:
            type === "notification" && notificationClickable
              ? Math.round(Math.max(0, notificationOpenDelaySeconds) * 1000)
              : undefined,
          notificationAutoOpen:
            type === "notification" && notificationClickable ? notificationAutoOpen : undefined,
          notificationAutoOpenDelayMs:
            type === "notification" && notificationClickable && notificationAutoOpen
              ? Math.round(Math.max(0, notificationAutoOpenDelaySeconds) * 1000)
              : undefined,
          linkedParticipantId:
            type === "notification" && notificationClickable
              ? linkedParticipantId || undefined
              : undefined,
          returnToParent: isSubMessage ? returnToParent : undefined,
        })
        if (resetOnSubmit && !initial) {
          setContent("")
          setTimestamp(toInputValue(new Date().toISOString()))
          setType("text")
          setStatus("sent")
          setSenderId(resolveSenderId(defaultSenderId, participants))
          setImageUrl("")
          setImageError(null)
          setDelaySeconds(DEFAULT_MESSAGE_DELAY_MS / 1000)
          setNotificationOverrideEnabled(false)
          setNotificationSenderName("")
          setNotificationAppName("")
          setNotificationAvatarUrl("")
          setNotificationClickable(false)
          setNotificationOpenDelaySeconds(DEFAULT_NOTIFICATION_OPEN_DELAY_MS / 1000)
          setNotificationAutoOpen(false)
          setNotificationAutoOpenDelaySeconds(DEFAULT_NOTIFICATION_AUTO_OPEN_DELAY_MS / 1000)
          setLinkedParticipantId("")
          setReturnToParent(false)
        }
      }}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{type === "image" ? t.messageForm.caption : t.messageForm.message}</Label>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={handlePaste}>
              <Clipboard className="h-3.5 w-3.5" />
              {t.messageForm.paste}
            </Button>
            {content ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setContent("")}>
                <X className="h-3.5 w-3.5" />
                {t.messageForm.clear}
              </Button>
            ) : null}
          </div>
        </div>
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={type === "image" ? t.messageForm.captionPlaceholder : t.messageForm.messagePlaceholder}
          className={cn(compact && "min-h-[72px]")}
        />
      </div>

      {type === "image" ? (
        <div className="space-y-2">
          <Label>{t.messageForm.imageUpload}</Label>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="h-20 w-28 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              {imageUrl ? (
                <img src={imageUrl} alt="Uploaded preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-400">
                  {t.messageForm.noImage}
                </div>
              )}
            </div>
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="gap-2"
              >
                <ImagePlus className="h-4 w-4" />
                {t.messageForm.uploadImage}
              </Button>
              {imageUrl ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setImageUrl("")}>
                  Remove
                </Button>
              ) : null}
              <span className="text-xs text-slate-500">JPG, PNG, or WEBP up to 5MB.</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                await handleImageUpload(file)
                event.target.value = ""
              }}
            />
          </div>
          {imageError ? (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">
              {imageError}
            </div>
          ) : null}
        </div>
      ) : null}

      {showAdvanced ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t.messageForm.sender}</Label>
              <Input
                list="message-sender-name-options"
                value={senderNameInput}
                onChange={(event) => {
                  const value = event.target.value
                  setSenderNameInput(value)
                  const match = participants.find(
                    (participant) => participant.name.trim().toLowerCase() === value.trim().toLowerCase(),
                  )
                  if (match) setSenderId(match.id)
                }}
                placeholder={t.messageForm.senderPlaceholder}
              />
              <datalist id="message-sender-name-options">
                {participants.map((participant) => (
                  <option key={participant.id} value={participant.name} />
                ))}
              </datalist>
              <p className="text-[11px] text-slate-500">
                {t.messageForm.senderHint}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t.messageForm.timestamp}</Label>
              <Input
                type="datetime-local"
                value={timestamp}
                onChange={(event) => setTimestamp(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t.messageForm.type}</Label>
              <Select
                value={type}
                onValueChange={(value) => {
                  const nextType = value as Message["type"]
                  setType(nextType)
                  if (nextType !== "image") {
                    setImageError(null)
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t.messageForm.selectType} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">{t.messageForm.typeText}</SelectItem>
                  <SelectItem value="system">{t.messageForm.typeSystem}</SelectItem>
                  <SelectItem value="image">{t.messageForm.typeImage}</SelectItem>
                  <SelectItem value="notification">{t.messageForm.typeNotification}</SelectItem>
                </SelectContent>
              </Select>
              {type === "notification" ? (
                <p className="text-[11px] text-slate-500">
                  {t.messageForm.notificationTypeHint}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>{t.messageForm.status}</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as Message["status"])}>
                <SelectTrigger>
                  <SelectValue placeholder={t.messageForm.selectStatus} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sent">{t.messageForm.statusSent}</SelectItem>
                  <SelectItem value="delivered">{t.messageForm.statusDelivered}</SelectItem>
                  <SelectItem value="read">{t.messageForm.statusRead}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>{t.messageForm.revealDelay}</Label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={delaySeconds}
                onChange={(event) => setDelaySeconds(Number(event.target.value))}
              />
              <p className="text-[11px] text-slate-500">
                {t.messageForm.revealDelayHint}
              </p>
            </div>
          </div>

          {isSubMessage ? (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3">
              <div className="space-y-0.5">
                <Label>{t.messageForm.returnToParent}</Label>
                <p className="text-[11px] text-slate-500">{t.messageForm.returnToParentHint}</p>
              </div>
              <Switch checked={returnToParent} onCheckedChange={setReturnToParent} />
            </div>
          ) : null}

          {type === "notification" ? (
            <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <Label>{t.messageForm.showDifferentNameApp}</Label>
                  <p className="text-[11px] text-slate-500">
                    {t.messageForm.showDifferentNameAppHint}
                  </p>
                </div>
                <Switch
                  checked={notificationOverrideEnabled}
                  onCheckedChange={setNotificationOverrideEnabled}
                />
              </div>
              {notificationOverrideEnabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>{t.messageForm.notificationSenderName}</Label>
                    <Input
                      list="notification-sender-name-options"
                      value={notificationSenderName}
                      onChange={(event) => setNotificationSenderName(event.target.value)}
                      placeholder={t.messageForm.notificationSenderNamePlaceholder}
                    />
                    <datalist id="notification-sender-name-options">
                      {notificationSenderNames.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    <p className="text-[11px] text-slate-500">
                      {t.messageForm.notificationSenderNameHint}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t.messageForm.notificationAppName}</Label>
                    <Input
                      value={notificationAppName}
                      onChange={(event) => setNotificationAppName(event.target.value)}
                      placeholder={t.messageForm.notificationAppNamePlaceholder}
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>{t.messageForm.notificationAvatarUrl}</Label>
                    <Input
                      value={notificationAvatarUrl}
                      onChange={(event) => setNotificationAvatarUrl(event.target.value)}
                      placeholder="https://..."
                    />
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <div className="space-y-0.5">
                  <Label>{t.messageForm.clickable}</Label>
                  <p className="text-[11px] text-slate-500">
                    {t.messageForm.clickableHint}
                  </p>
                </div>
                <Switch checked={notificationClickable} onCheckedChange={setNotificationClickable} />
              </div>
              {notificationClickable ? (
                <div className="space-y-2">
                  <Label>{t.messageForm.opensAfter}</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={notificationOpenDelaySeconds}
                    onChange={(event) => setNotificationOpenDelaySeconds(Number(event.target.value))}
                  />
                  <p className="text-[11px] text-slate-500">
                    {t.messageForm.opensAfterHint}
                  </p>
                </div>
              ) : null}
              {notificationClickable ? (
                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <Label>{t.messageForm.autoOpen}</Label>
                      <p className="text-[11px] text-slate-500">
                        {t.messageForm.autoOpenHint}
                      </p>
                    </div>
                    <Switch checked={notificationAutoOpen} onCheckedChange={setNotificationAutoOpen} />
                  </div>
                  {notificationAutoOpen ? (
                    <div className="space-y-2">
                      <Label>{t.messageForm.autoTapsAfter}</Label>
                      <Input
                        type="number"
                        min={0}
                        step={0.1}
                        value={notificationAutoOpenDelaySeconds}
                        onChange={(event) =>
                          setNotificationAutoOpenDelaySeconds(Number(event.target.value))
                        }
                      />
                      <p className="text-[11px] text-slate-500">
                        {t.messageForm.autoTapsAfterHint}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {notificationClickable && !isSubMessage ? (
                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div className="space-y-2">
                    <Label>{t.messageForm.linkedConversation}</Label>
                    <Select
                      value={linkedParticipantId || "__none__"}
                      onValueChange={(value) => setLinkedParticipantId(value === "__none__" ? "" : value)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={t.messageForm.linkedConversationNone} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">{t.messageForm.linkedConversationNone}</SelectItem>
                        {(rosterParticipants ?? participants).map((participant) => (
                          <SelectItem key={participant.id} value={participant.id}>
                            {participant.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-slate-500">
                      {t.messageForm.linkedConversationHint}
                    </p>
                  </div>
                  {linkedParticipantId ? (
                    <LinkedConversationEditor participantId={linkedParticipantId} />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={type === "image" && !imageUrl}
          onClick={() => {
            if (type === "image" && !imageUrl) {
              setImageError(t.messageForm.pleaseUploadImage)
            }
          }}
        >
          {submitLabel ?? (initial ? t.messageForm.saveChanges : t.messageForm.addMessage)}
        </Button>
        {initial ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t.messageForm.cancel}
          </Button>
        ) : null}
        {showAdvancedToggle ? (
          <Button type="button" variant="ghost" onClick={onToggleAdvanced}>
            {advancedOpen ? t.messageForm.hideAdvanced : t.messageForm.advanced}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
