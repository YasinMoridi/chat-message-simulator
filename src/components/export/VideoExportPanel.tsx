import { useMemo, useRef, useState } from "react"
import { Clapperboard, Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SizePresets } from "@/components/export/SizePresets"
import { sizePresets } from "@/constants/exportPresets"
import { layoutConfigs } from "@/constants/layouts"
import { useConversationStore } from "@/store/conversationStore"
import { ChatLayout } from "@/components/layout/ChatLayout"
import { exportNodeToImage } from "@/utils/export"
import { recordFramesToVideo, isVideoRecordingSupported, type VideoFrame } from "@/utils/videoExport"
import { DEFAULT_MESSAGE_DELAY_MS } from "@/types/message"

/** How long the very last, fully-revealed frame stays on screen before the video ends. */
const TRAILING_HOLD_MS = 1800

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
  const [isRendering, setIsRendering] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  const layout = layoutConfigs.find((item) => item.id === layoutId) ?? layoutConfigs[0]
  const theme = layout.themes.find((item) => item.id === themeId) ?? layout.themes[0]
  const preset = sizePresets.find((item) => item.id === exportSettings.presetId)

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

  const runExport = async () => {
    if (!stageRef.current) return
    if (visibleMessages.length === 0) {
      setErrorMessage("Add at least one visible message first.")
      return
    }

    setErrorMessage(null)
    setVideoUrl(null)
    setIsRendering(true)
    setProgress({ done: 0, total: visibleMessages.length })

    try {
      const frames: VideoFrame[] = []

      // count = 0 -> empty thread, count = N -> every visible message shown.
      for (let count = 0; count <= visibleMessages.length; count += 1) {
        setRevealCount(count)
        await waitForNextPaint()

        const scrollRoot = scrollRootRef.current
        if (scrollRoot) {
          scrollRoot.scrollTop = scrollRoot.scrollHeight
        }

        const dataUrl = await exportNodeToImage(stageRef.current, {
          presetId: exportSettings.presetId,
          width: exportSettings.width,
          height: exportSettings.height,
          scale: exportSettings.scale,
          format: "png",
          quality: 0.95,
          captureMode: "viewport",
        })

        // The delay attached to message[count] is "how long to wait after the
        // previous message before this one appears" - so it becomes the hold
        // time for the frame that comes right before it becomes visible.
        const holdMs =
          count < visibleMessages.length
            ? visibleMessages[count]?.delayMs ?? DEFAULT_MESSAGE_DELAY_MS
            : TRAILING_HOLD_MS

        frames.push({ dataUrl, holdMs })
        setProgress({ done: count, total: visibleMessages.length })
      }

      const blob = await recordFramesToVideo(
        frames,
        { width: exportSettings.width, height: exportSettings.height, fps: 30 },
        (done, total) => setProgress({ done, total }),
      )
      setVideoUrl(URL.createObjectURL(blob))
    } catch (error) {
      console.error("Video export failed", error)
      setErrorMessage(error instanceof Error ? error.message : "Video export failed.")
    } finally {
      setIsRendering(false)
      setRevealCount(visibleMessages.length)
    }
  }

  const handleDownload = () => {
    if (!videoUrl) return
    const link = document.createElement("a")
    link.href = videoUrl
    link.download = "chat-video.webm"
    link.click()
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Video export</h3>
        <p className="text-xs text-slate-500">
          Renders the conversation as a video, revealing one message at a time using each
          message&apos;s video delay from the message editor.
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
        {isRendering ? `Rendering ${progress.done}/${progress.total}...` : "Render video"}
      </Button>

      {errorMessage ? (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{errorMessage}</div>
      ) : null}

      {videoUrl ? (
        <div className="space-y-2">
          <video src={videoUrl} controls className="w-full rounded-xl border border-slate-200" />
          <Button variant="outline" onClick={handleDownload} className="w-full gap-2">
            <Download className="h-4 w-4" />
            Download video (.webm)
          </Button>
          <p className="text-[11px] text-slate-500">
            WebM plays natively in Chrome, Edge, and Firefox. Convert it to MP4 with a tool like
            ffmpeg or HandBrake if you need another format (e.g. for older iOS Safari).
          </p>
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
          />
        </div>
      </div>
    </div>
  )
}
