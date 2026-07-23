export interface VideoFrame {
  /** PNG/JPEG data URL for this frame. */
  dataUrl: string
  /** How long (ms) this frame should stay on screen before the next one. */
  holdMs: number
}

export interface VideoRecordSettings {
  width: number
  height: number
  /** Canvas capture frame rate. Higher = smoother but bigger files. */
  fps?: number
  mimeType?: string
  /** Encoding bitrate hint passed to MediaRecorder. */
  videoBitsPerSecond?: number
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Failed to load a rendered frame."))
    image.src = src
  })

/** Picks the best webm codec this browser actually supports. */
export const pickSupportedMimeType = (): string => {
  const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
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

/**
 * Draws each frame onto a hidden canvas, holding it for `holdMs`, while a
 * MediaRecorder captures the canvas stream. Resolves with the final webm blob.
 */
export const recordFramesToVideo = async (
  frames: VideoFrame[],
  settings: VideoRecordSettings,
  onProgress?: (completed: number, total: number) => void,
): Promise<Blob> => {
  if (!isVideoRecordingSupported()) {
    throw new Error("Video recording is not supported in this browser.")
  }
  if (frames.length === 0) {
    throw new Error("No frames to render.")
  }

  const canvas = document.createElement("canvas")
  canvas.width = settings.width
  canvas.height = settings.height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error("Could not create a canvas context.")
  }

  const fps = settings.fps ?? 30
  const mimeType = settings.mimeType ?? pickSupportedMimeType()
  const stream = canvas.captureStream(fps)
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

  await recordingStopped
  return new Blob(chunks, { type: mimeType })
}

export const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
