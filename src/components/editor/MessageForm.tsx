import { useEffect, useRef, useState } from "react"
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
import { Clipboard, ImagePlus, X } from "lucide-react"

interface MessageFormProps {
  participants: Participant[]
  initial?: Message | null
  defaultSenderId?: string
  compact?: boolean
  resetOnSubmit?: boolean
  submitLabel?: string
  advancedOpen?: boolean
  onToggleAdvanced?: () => void
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
  initial,
  defaultSenderId,
  compact,
  resetOnSubmit,
  submitLabel,
  advancedOpen,
  onToggleAdvanced,
  onSubmit,
  onCancel,
}: MessageFormProps) => {
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
  const showAdvanced = advancedOpen ?? true
  const showAdvancedToggle = typeof advancedOpen === "boolean" && typeof onToggleAdvanced === "function"
  const previousDefaultRef = useRef(defaultSenderId)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const setDraftMessage = useConversationStore((state) => state.setDraftMessage)
  const addParticipant = useConversationStore((state) => state.addParticipant)
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
      setImageError("Only image files are allowed.")
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setImageError("Image must be smaller than 5MB.")
      return
    }
    try {
      const dataUrl = await readFileAsDataUrl(file)
      setImageUrl(dataUrl)
      setImageError(null)
    } catch (error) {
      console.error("Failed to read image file", error)
      setImageError("Could not read the selected image.")
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (type === "image" && !imageUrl) {
          setImageError("Please upload an image for this message.")
          return
        }
        if (type === "notification" && notificationOverrideEnabled && notificationSenderName.trim()) {
          addNotificationSenderName(notificationSenderName)
        }
        const trimmedSenderName = senderNameInput.trim()
        const matchedParticipant = participants.find(
          (participant) => participant.name.trim().toLowerCase() === trimmedSenderName.toLowerCase(),
        )
        let finalSenderId = matchedParticipant?.id ?? senderId
        if (!matchedParticipant && trimmedSenderName) {
          addParticipant({
            name: trimmedSenderName,
            status: "online",
            color: pickNewParticipantColor(participants.length),
          })
          const created = useConversationStore.getState().conversation.participants.at(-1)
          if (created) finalSenderId = created.id
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
        }
      }}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{type === "image" ? "Caption" : "Message"}</Label>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={handlePaste}>
              <Clipboard className="h-3.5 w-3.5" />
              Paste
            </Button>
            {content ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => setContent("")}>
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            ) : null}
          </div>
        </div>
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={type === "image" ? "Add a caption (optional)..." : "Write the message..."}
          className={cn(compact && "min-h-[72px]")}
        />
      </div>

      {type === "image" ? (
        <div className="space-y-2">
          <Label>Image upload</Label>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="h-20 w-28 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              {imageUrl ? (
                <img src={imageUrl} alt="Uploaded preview" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-slate-400">
                  No image
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
                Upload image
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
              <Label>Sender</Label>
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
                placeholder="Pick or type a name"
              />
              <datalist id="message-sender-name-options">
                {participants.map((participant) => (
                  <option key={participant.id} value={participant.name} />
                ))}
              </datalist>
              <p className="text-[11px] text-slate-500">
                Pick an existing participant, or type a new name - it's added as a participant
                when you submit.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Timestamp</Label>
              <Input
                type="datetime-local"
                value={timestamp}
                onChange={(event) => setTimestamp(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Type</Label>
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
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Text</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="image">Image</SelectItem>
                  <SelectItem value="notification">Notification</SelectItem>
                </SelectContent>
              </Select>
              {type === "notification" ? (
                <p className="text-[11px] text-slate-500">
                  Pops in as an OS notification banner at this point in playback - it never
                  appears as a bubble in the chat itself.
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as Message["status"])}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="delivered">Delivered</SelectItem>
                  <SelectItem value="read">Read</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Reveal delay (seconds)</Label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={delaySeconds}
                onChange={(event) => setDelaySeconds(Number(event.target.value))}
              />
              <p className="text-[11px] text-slate-500">
                Time this waits after the previous entry before it appears during playback.
              </p>
            </div>
          </div>

          {type === "notification" ? (
            <div className="space-y-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="space-y-0.5">
                  <Label>Show as a different name/app</Label>
                  <p className="text-[11px] text-slate-500">
                    By default the notification uses the Sender above. Turn this on to display a
                    different name, app, or avatar instead.
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
                    <Label>Notification sender name</Label>
                    <Input
                      list="notification-sender-name-options"
                      value={notificationSenderName}
                      onChange={(event) => setNotificationSenderName(event.target.value)}
                      placeholder="e.g. Sarah"
                    />
                    <datalist id="notification-sender-name-options">
                      {notificationSenderNames.map((name) => (
                        <option key={name} value={name} />
                      ))}
                    </datalist>
                    <p className="text-[11px] text-slate-500">
                      Pick a name you've used before, or just type a new one - it's added to the
                      list.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Notification app name</Label>
                    <Input
                      value={notificationAppName}
                      onChange={(event) => setNotificationAppName(event.target.value)}
                      placeholder="e.g. Instagram"
                    />
                  </div>
                  <div className="space-y-2 sm:col-span-2">
                    <Label>Notification avatar URL (optional)</Label>
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
                  <Label>Clickable (opens the chat)</Label>
                  <p className="text-[11px] text-slate-500">
                    Let this banner be tapped during live playback, like a real notification that
                    opens the app when you tap it.
                  </p>
                </div>
                <Switch checked={notificationClickable} onCheckedChange={setNotificationClickable} />
              </div>
              {notificationClickable ? (
                <div className="space-y-2">
                  <Label>Opens after (seconds)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={notificationOpenDelaySeconds}
                    onChange={(event) => setNotificationOpenDelaySeconds(Number(event.target.value))}
                  />
                  <p className="text-[11px] text-slate-500">
                    How long it waits after being tapped before it opens into the full chat.
                  </p>
                </div>
              ) : null}
              {notificationClickable ? (
                <div className="space-y-3 border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <Label>Auto-open (no tap needed)</Label>
                      <p className="text-[11px] text-slate-500">
                        Instead of waiting for someone to actually click the banner, it taps
                        itself during playback - useful when you're directing the timing rather
                        than clicking live.
                      </p>
                    </div>
                    <Switch checked={notificationAutoOpen} onCheckedChange={setNotificationAutoOpen} />
                  </div>
                  {notificationAutoOpen ? (
                    <div className="space-y-2">
                      <Label>Auto-taps after (seconds)</Label>
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
                        How long the banner sits there after appearing before it taps itself.
                      </p>
                    </div>
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
              setImageError("Please upload an image for this message.")
            }
          }}
        >
          {submitLabel ?? (initial ? "Save changes" : "Add message")}
        </Button>
        {initial ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
        {showAdvancedToggle ? (
          <Button type="button" variant="ghost" onClick={onToggleAdvanced}>
            {advancedOpen ? "Hide advanced" : "Advanced"}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
