import { useMemo, useRef, useState } from "react"
import { Clapperboard, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SizePresets } from "@/components/export/SizePresets"
import { sizePresets } from "@/constants/exportPresets"
import { layoutConfigs } from "@/constants/layouts"
import { useConversationStore } from "@/store/conversationStore"
import { ChatLayout, getSelfParticipantId } from "@/components/layout/ChatLayout"
import { exportNodeToImage } from "@/utils/export"
import {
  recordFramesToVideo,
  isVideoRecordingSupported,
  isMp4MimeType,
  downloadBlob,
  type VideoFrame,
} from "@/utils/videoExport"
import { computeRevealTiming } from "@/utils/messageTiming"
import { TYPING_ANIMATION_CYCLE_MS } from "@/components/chat/TypingIndicator"
import { DEFAULT_MESSAGE_DELAY_MS } from "@/types/message"

/** How long the very last, fully-revealed frame stays on screen before the video ends. */
const TRAILING_HOLD_MS = 1800
/** Where your notification sound lives - see public/sounds/README.txt. */
const NOTIFICATION_SOUND_URL = "/sounds/notification.mp3"
/**
 * The typing indicator is just a snapshot of the DOM, so a single capture
 * held on screen for the whole typing duration would render as one frozen
 * image - the "..." dots would never actually appear to bounce. Instead we
 * take several snapshots spread across the typing window so the recorded
 * video shows the dots animating like they do in the live preview.
 */
const TYPING_FRAME_STEP_MS = 90

/** Splits a typing duration into a list of hold-times for successive snapshots. */
const buildTypingHolds = (typingMs: number): number[] => {
  const steps = Math.max(1, Math.round(typingMs / TYPING_FRAME_STEP_MS))
  const holds = Array.from({ length: steps }, () => Math.floor(typingMs / steps))
  const remainder = typingMs - holds.reduce((sum, value) => sum + value, 0)
  holds[holds.length - 1] += remainder
  return holds
}

const waitForNextPaint = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

export const VideoExportPanel = () => {
  const conversation = useConversationStore((state) => state.conversation)
  const layoutId = useConversationStore((state) => state.layoutId)
  const themeId = useConversationStore((state) => state.themeId)
  const activeParticipantId = useConversationStore((state) => state.activeParticipantId)
  const backgroundImageUrl = useConversationStore((state) => state.backgroundImageUrl)
  const backgroundImageOpacity = useConversationStore((state) => state.backgroundImageOpacity)
  const backgroundColor = useConversationStore((state) => state.backgroundColor)
  const ui = useConversationStore((state) => state.ui)
  const exportSettings = useConversationStore((state) => state.exportSettings)
  const setExportSettings = useConversationStore((state) => state.setExportSettings)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const scrollRootRef = useRef<HTMLDivElement | null>(null)

  const [revealCount, setRevealCount] = useState(0)
  const [typingSenderId, setTypingSenderId] = useState<string | null>(null)
  const [typingPhaseMs, setTypingPhaseMs] = useState(0)
  const [isRendering, setIsRendering] = useState(false)
  const [phase, setPhase] = useState<"capturing" | "encoding" | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoMimeType, setVideoMimeType] = useState<string>("video/webm")

  const layout = layoutConfigs.find((item) => item.id === layoutId) ?? layoutConfigs[0]
  const theme = layout.themes.find((item) => item.id === themeId) ?? layout.themes[0]
  const preset = sizePresets.find((item) => item.id === exportSettings.presetId)
  const selfId = getSelfParticipantId(conversation.participants, activeParticipantId)

  const visibleMessages = useMemo(
    () => conversation.messages.filter((message) => !message.isHidden),
    [conversation.messages],
  )

  const stageConversation = useMemo(
    () => ({
      ...conversation,
      messages: visibleMessages.slice(0, revealCount),
    }),
    [conversation, visibleMessages, revealCount],
  )

  const supported = isVideoRecordingSupported()
  const fileExtension = isMp4MimeType(videoMimeType) ? "mp4" : "webm"

  const captureCurrentFrame = async () => {
    await waitForNextPaint()
    const scrollRoot = scrollRootRef.current
    if (scrollRoot) {
      scrollRoot.scrollTop = scrollRoot.scrollHeight
    }
    if (!stageRef.current) throw new Error("Preview stage is not ready.")
    return exportNodeToImage(stageRef.current, {
      presetId: exportSettings.presetId,
      width: exportSettings.width,
      height: exportSettings.height,
      scale: exportSettings.scale,
      format: "png",
      quality: 0.95,
      captureMode: "viewport",
    })
  }

  const runExport = async () => {
    if (!stageRef.current) return
    if (visibleMessages.length === 0) {
      setErrorMessage("Add at least one visible message first.")
      return
    }

    setErrorMessage(null)
    setVideoUrl(null)
    setIsRendering(true)
    setPhase("capturing")

    // Each incoming (non-self, non-system) message contributes several
    // "typing" snapshots (so the dots visibly animate) plus one "reveal"
    // frame; your own outgoing messages and system messages only get a
    // reveal frame - you never see a typing bubble for yourself.
    const captureTotal = visibleMessages.reduce((total, message) => {
      if (message.type === "system" || message.senderId === selfId) return total + 1
      const { typingMs } = computeRevealTiming(message.delayMs)
      return total + buildTypingHolds(typingMs).length + 1
    }, 0)
    setProgress({ done: 0, total: captureTotal })

    try {
      const frames: VideoFrame[] = []
      let captured = 0

      setRevealCount(0)
      setTypingSenderId(null)

      for (let index = 0; index < visibleMessages.length; index += 1) {
        const message = visibleMessages[index]
        const { typingMs, restMs } = computeRevealTiming(message.delayMs)

        if (message.type !== "system" && message.senderId !== selfId) {
          setTypingSenderId(message.senderId)
          // Capture several snapshots across the typing window instead of one
          // long-held frame, so the bouncing dots actually animate on export.
          // Each snapshot pins the dots to a different, deterministic point
          // in their bounce cycle (see TypingIndicator's frozenPhaseMs) -
          // relying on "real time passing" between snapshots doesn't work
          // here because every capture is a fresh DOM clone whose animation
          // clock restarts at zero the instant it's attached.
          const typingHolds = buildTypingHolds(typingMs)
          for (let step = 0; step < typingHolds.length; step += 1) {
            setTypingPhaseMs((step * TYPING_FRAME_STEP_MS) % TYPING_ANIMATION_CYCLE_MS)
            const dataUrl = await captureCurrentFrame()
            frames.push({ dataUrl, holdMs: typingHolds[step] })
            captured += 1
            setProgress({ done: captured, total: captureTotal })
          }
        }

        setTypingSenderId(null)
        setRevealCount(index + 1)
        const dataUrl = await captureCurrentFrame()
        const holdMs =
          message.type === "system" ? message.delayMs ?? DEFAULT_MESSAGE_DELAY_MS : restMs
        frames.push({ dataUrl, holdMs, playSound: message.type !== "system" })
        captured += 1
        setProgress({ done: captured, total: captureTotal })
      }

      // Hold on the final, fully-revealed frame a bit before the video ends.
      if (frames.length > 0) {
        frames.push({ dataUrl: frames[frames.length - 1].dataUrl, holdMs: TRAILING_HOLD_MS })
      }

      setPhase("encoding")
      setProgress({ done: 0, total: frames.length })
      const { blob, mimeType } = await recordFramesToVideo(
        frames,
        {
          width: exportSettings.width,
          height: exportSettings.height,
          fps: 30,
          soundUrl: NOTIFICATION_SOUND_URL,
        },
        (done, total) => setProgress({ done, total }),
      )
      setVideoMimeType(mimeType)
      setVideoUrl(URL.createObjectURL(blob))
      // Download automatically as soon as the video is ready - no extra click needed.
      downloadBlob(blob, `chat-video.${isMp4MimeType(mimeType) ? "mp4" : "webm"}`)
    } catch (error) {
      console.error("Video export failed", error)
      setErrorMessage(error instanceof Error ? error.message : "Video export failed.")
    } finally {
      setIsRendering(false)
      setPhase(null)
      setTypingSenderId(null)
      setRevealCount(visibleMessages.length)
    }
  }

  const handleDownload = () => {
    if (!videoUrl) return
    const link = document.createElement("a")
    link.href = videoUrl
    link.download = `chat-video.${fileExtension}`
    link.click()
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Video export</h3>
        <p className="text-xs text-slate-500">
          Renders the conversation as a video: typing dots, then each message, using every
          message&apos;s delay from the message editor.
        </p>
      </div>

      {!supported ? (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          This browser does not support in-browser video recording. Try the latest Chrome, Edge,
          or Firefox.
        </div>
      ) : null}

      <div className="space-y-3">
        <Label>Device presets</Label>
        <SizePresets
          selectedId={exportSettings.presetId}
          onSelect={(presetItem) =>
            setExportSettings({
              presetId: presetItem.id,
              width: presetItem.width,
              height: presetItem.height,
            })
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Width</Label>
          <Input
            type="number"
            min={240}
            value={exportSettings.width}
            onChange={(event) =>
              setExportSettings({ presetId: "custom", width: Number(event.target.value) })
            }
          />
        </div>
        <div className="space-y-2">
          <Label>Height</Label>
          <Input
            type="number"
            min={240}
            value={exportSettings.height}
            onChange={(event) =>
              setExportSettings({ presetId: "custom", height: Number(event.target.value) })
            }
          />
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
        {visibleMessages.length} visible messages - {exportSettings.width} x {exportSettings.height}
        {preset ? ` - ${preset.label}` : ""}
      </div>

      <Button onClick={runExport} disabled={isRendering || !supported} className="w-full gap-2">
        {isRendering ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Clapperboard className="h-4 w-4" />
        )}
        {isRendering
          ? phase === "encoding"
            ? `Encoding video ${progress.done}/${progress.total}...`
            : `Capturing frames ${progress.done}/${progress.total}...`
          : "Render video"}
      </Button>

      {errorMessage ? (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{errorMessage}</div>
      ) : null}

      {videoUrl ? (
        <div className="space-y-2">
          <video src={videoUrl} controls className="w-full rounded-xl border border-slate-200" />
          <p className="text-[11px] text-emerald-700">
            Downloaded automatically as chat-video.{fileExtension}. Use the button below if you
            need it again.
          </p>
          <Button variant="outline" onClick={handleDownload} className="w-full gap-2">
            <Download className="h-4 w-4" />
            Download video (.{fileExtension}) again
          </Button>
          {fileExtension === "webm" ? (
            <p className="text-[11px] text-slate-500">
              This browser can only record WebM. It plays natively in Chrome, Edge, and Firefox.
              Convert it to MP4 with a tool like ffmpeg (<code>ffmpeg -i chat-video.webm
              chat-video.mp4</code>) or HandBrake if you need a real .mp4 file (e.g. for older iOS
              Safari or apps that reject WebM).
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Offscreen stage: rendered off-canvas, only used to capture frames. */}
      <div aria-hidden="true" className="pointer-events-none fixed left-[-10000px] top-0">
        <div ref={stageRef} style={{ width: exportSettings.width, height: exportSettings.height }}>
          <ChatLayout
            conversation={stageConversation}
            layout={layout}
            theme={theme}
            showChrome={ui.showChrome}
            activeParticipantId={activeParticipantId}
            backgroundImageUrl={backgroundImageUrl}
            backgroundImageOpacity={backgroundImageOpacity}
            backgroundColor={backgroundColor}
            conversationMode="scroll"
            conversationContainerRef={scrollRootRef}
            typingSenderId={typingSenderId}
            typingPhaseMs={typingPhaseMs}
          />
        </div>
      </div>
    </div>
  )
}
