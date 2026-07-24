export interface VideoFrame {
  /**
   * The already-rendered frame. Kept as a live <canvas> (see
   * exportNodeToCanvas) rather than a data URL - drawing a canvas onto
   * another canvas is synchronous, so the encode loop below never has to
   * wait on an <img> decode between frames.
   */
  canvas: HTMLCanvasElement
  /** How long (ms) this frame should stay on screen before the next one. */
  holdMs: number
  /** If true, the notification sound plays right as this frame starts. */
  playSound?: boolean
}

export interface VideoRecordSettings {
  width: number
  height: number
  /** Canvas capture frame rate. Higher = smoother but bigger files. */
  fps?: number
  mimeType?: string
  /** Encoding bitrate hint passed to MediaRecorder. */
  videoBitsPerSecond?: number
  /**
   * URL of a short sound (e.g. "/sounds/notification.mp3") to mix into the
   * recording's audio track whenever a frame has `playSound: true`. Safe to
   * omit - the video is still recorded fine without any audio track.
   */
  soundUrl?: string
}

/**
 * Picks the best codec this browser actually supports, preferring real MP4
 * output where the browser can produce it (currently Safari 14.1+), and
 * otherwise falling back to WebM (Chrome, Edge, Firefox).
 */
export const pickSupportedMimeType = (): string => {
  const candidates = [
    "video/mp4;codecs=avc1",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ]
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(candidate)) {
      return candidate
    }
  }
  return "video/webm"
}

export const isVideoRecordingSupported = () =>
  typeof MediaRecorder !== "undefined" &&
  typeof HTMLCanvasElement !== "undefined" &&
  "captureStream" in HTMLCanvasElement.prototype

/** true if the mime type MediaRecorder ended up using is an mp4 container. */
export const isMp4MimeType = (mimeType: string) => mimeType.startsWith("video/mp4")

/**
 * Draws each frame onto a hidden canvas, holding it for `holdMs`, while a
 * MediaRecorder captures the canvas stream (plus an optional mixed-in audio
 * track for the notification sound). Resolves with the final blob.
 */
export const recordFramesToVideo = async (
  frames: VideoFrame[],
  settings: VideoRecordSettings,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (!isVideoRecordingSupported()) {
    throw new Error("Video recording is not supported in this browser.")
  }
  if (frames.length === 0) {
    throw new Error("No frames to render.")
  }

  const canvas = document.createElement("canvas")
  canvas.width = settings.width
  canvas.height = settings.height
  // captureStream() only keeps delivering fresh frames on a fixed timer while
  // the canvas is actually part of the document. A detached canvas can get
  // "frozen" by the browser after the first paint, so every frame we capture
  // afterwards ends up being that same first frame. Keep it in the DOM (but
  // fully hidden) for the duration of the recording.
  Object.assign(canvas.style, {
    position: "fixed",
    left: "-99999px",
    top: "0",
    pointerEvents: "none",
  })
  document.body.appendChild(canvas)
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    canvas.remove()
    throw new Error("Could not create a canvas context.")
  }

  const fps = settings.fps ?? 30
  const mimeType = settings.mimeType ?? pickSupportedMimeType()
  const videoStream = canvas.captureStream(fps)

  // Try to mix in the notification sound as a real audio track. If anything
  // here fails (unsupported browser, missing file, blocked autoplay), we
  // silently fall back to a video-only recording rather than breaking export.
  let stream: MediaStream = videoStream
  let audioCtx: AudioContext | null = null
  let audioEl: HTMLAudioElement | null = null

  if (settings.soundUrl) {
    try {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
      if (audioCtx.state === "suspended") await audioCtx.resume().catch(() => {})
      const destination = audioCtx.createMediaStreamDestination()
      audioEl = new Audio(settings.soundUrl)
      audioEl.crossOrigin = "anonymous"
      const source = audioCtx.createMediaElementSource(audioEl)
      source.connect(destination)
      stream = new MediaStream([...videoStream.getVideoTracks(), ...destination.stream.getAudioTracks()])
    } catch (error) {
      console.warn("Could not attach notification sound to the recording", error)
      stream = videoStream
      audioCtx = null
      audioEl = null
    }
  }

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: settings.videoBitsPerSecond ?? 6_000_000,
  })

  const chunks: BlobPart[] = []
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }

  const recordingStopped = new Promise<void>((resolve, reject) => {
    recorder.onstop = () => resolve()
    recorder.onerror = () => reject(new Error("Recording failed."))
  })

  // Passing a timeslice makes the encoder flush a chunk (and, in every
  // browser we've checked, place a keyframe) roughly every second instead of
  // wherever it feels like. Without this, a long hold (e.g. the multi-second
  // gap between messages) can end up inside one huge keyframe-less span, so
  // scrubbing into the middle of it forces the player to decode from a
  // keyframe that's seconds away - which is exactly the "gets stuck when I
  // seek" symptom.
  const KEYFRAME_INTERVAL_MS = 1000
  recorder.start(KEYFRAME_INTERVAL_MS)

  // How often we re-draw an unchanged frame during a long hold. Some
  // encoders treat a run of visually-identical canvas output as a signal to
  // stop bothering with fresh frames/keyframes for a while - re-drawing the
  // same pixels periodically keeps the stream "alive" and keeps keyframe
  // spacing even, on top of the timeslice above.
  const REDRAW_INTERVAL_MS = 500

  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      if (frame.playSound && audioEl) {
        audioEl.currentTime = 0
        void audioEl.play().catch(() => {})
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height)
      onProgress?.(index + 1, frames.length)

      let remainingMs = Math.max(50, frame.holdMs)
      while (remainingMs > 0) {
        const chunkMs = Math.min(REDRAW_INTERVAL_MS, remainingMs)
        await new Promise((resolve) => window.setTimeout(resolve, chunkMs))
        remainingMs -= chunkMs
        if (remainingMs > 0) {
          ctx.drawImage(frame.canvas, 0, 0, canvas.width, canvas.height)
        }
      }

      // Free this frame's backing store now that it's been drawn. With
      // dozens of full-resolution canvases queued up for encoding, leaving
      // them all alive until GC gets around to them is what makes longer
      // conversations chug partway through. Setting width/height to 0
      // releases the bitmap immediately. (Never reuse a frame's canvas
      // object for a later frame after this - build a fresh copy instead.)
      frame.canvas.width = 0
      frame.canvas.height = 0
    }
  } finally {
    recorder.stop()
  }

  try {
    await recordingStopped
    if (audioCtx) {
      await audioCtx.close().catch(() => {})
    }
  } finally {
    canvas.remove()
  }
  return { blob: new Blob(chunks, { type: mimeType }), mimeType: recorder.mimeType || mimeType }
}

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
