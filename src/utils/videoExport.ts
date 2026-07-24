export interface VideoFrame {
  /** PNG/JPEG data URL for this frame. */
  dataUrl: string
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

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Failed to load a rendered frame."))
    image.src = src
  })

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

  recorder.start()

  try {
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]
      if (frame.playSound && audioEl) {
        audioEl.currentTime = 0
        void audioEl.play().catch(() => {})
      }
      const image = await loadImage(frame.dataUrl)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
      onProgress?.(index + 1, frames.length)
      const holdMs = Math.max(50, frame.holdMs)
      await new Promise((resolve) => window.setTimeout(resolve, holdMs))
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
