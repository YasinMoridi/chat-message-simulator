import { Muxer, ArrayBufferTarget } from "mp4-muxer"
import type { VideoFrame as CapturedFrame } from "./videoExport"

/**
 * Needs `mp4-muxer` installed:
 *   npm install mp4-muxer
 *
 * Why this exists: the MediaRecorder + canvas.captureStream() path in
 * videoExport.ts records in real time and leaves keyframe placement up to
 * whatever the browser's encoder feels like doing - which is why seeking
 * around in the exported file can still stutter even after the frame-drawing
 * fixes. WebCodecs lets us encode frame-by-frame ourselves, not in real
 * time, and explicitly mark a keyframe on a fixed schedule - so scrubbing is
 * smooth by construction, not by luck.
 *
 * Browser support: Chrome/Edge and recent Safari expose VideoEncoder +
 * AudioEncoder; Firefox currently doesn't. Always feature-detect with
 * isWebCodecsExportSupported() and fall back to recordFramesToVideo() in
 * videoExport.ts when it's false.
 */

export interface WebCodecsExportSettings {
  width: number
  height: number
  /** Output frame rate. Also controls how many encoded frames a long hold turns into. */
  fps?: number
  /** Encoding bitrate hint for the video track. */
  videoBitrate?: number
  /** URL of the short notification sound to mix in wherever a frame has playSound. */
  soundUrl?: string
}

export const isWebCodecsExportSupported = () =>
  typeof VideoEncoder !== "undefined" &&
  typeof AudioEncoder !== "undefined" &&
  typeof (globalThis as any).VideoFrame !== "undefined"

/** Level/profile candidates to try, from best quality/size down to the safest, most broadly-supported baseline. */
const VIDEO_CODEC_CANDIDATES = [
  "avc1.640034", // High @ L5.2
  "avc1.640028", // High @ L4.0
  "avc1.4d0028", // Main @ L4.0
  "avc1.42001f", // Baseline @ L3.1
  "avc1.42e01e", // Baseline @ L3.0
]
/** A keyframe every 2 seconds of output, no matter how long any single hold is. This is the actual fix for choppy seeking. */
const KEYFRAME_INTERVAL_SEC = 2
const AUDIO_SAMPLE_RATE = 44100
const AUDIO_CHANNELS = 2
const AUDIO_CHUNK_FRAMES = 1024

/**
 * Never hand VideoEncoder.configure() a guessed codec string and hope for
 * the best - a rejected config (or one the browser silently can't honor at
 * this resolution/bitrate) surfaces asynchronously via the encoder's error
 * callback, which closes the codec, and every encode() call after that
 * fails with "Cannot call 'encode' on a closed codec." Checking
 * isConfigSupported() up front and using the config it hands back avoids
 * that entirely.
 */
const pickVideoEncoderConfig = async (
  width: number,
  height: number,
  bitrate: number,
  framerate: number,
): Promise<VideoEncoderConfig> => {
  for (const codec of VIDEO_CODEC_CANDIDATES) {
    const candidate: VideoEncoderConfig = { codec, width, height, bitrate, framerate }
    try {
      const support = await VideoEncoder.isConfigSupported(candidate)
      if (support.supported) return support.config ?? candidate
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    `This browser can't encode H.264 video at ${width}x${height}. Try a smaller export size.`,
  )
}

/** Decodes and resamples the notification sound to a fixed rate/channel count so mixing later is just integer sample math, no resampling math to get wrong per-cue. */
const loadNotificationSound = async (soundUrl: string): Promise<Float32Array[] | null> => {
  try {
    const response = await fetch(soundUrl)
    const arrayBuffer = await response.arrayBuffer()
    const decodeCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer)
    await decodeCtx.close().catch(() => {})

    const offlineCtx = new OfflineAudioContext(
      AUDIO_CHANNELS,
      Math.ceil(decoded.duration * AUDIO_SAMPLE_RATE),
      AUDIO_SAMPLE_RATE,
    )
    const source = offlineCtx.createBufferSource()
    source.buffer = decoded
    source.connect(offlineCtx.destination)
    source.start()
    const rendered = await offlineCtx.startRendering()

    return Array.from({ length: AUDIO_CHANNELS }, (_, channel) => rendered.getChannelData(channel))
  } catch (error) {
    console.warn("Could not decode the notification sound - exporting without audio.", error)
    return null
  }
}

export const recordFramesToMp4 = async (
  frames: CapturedFrame[],
  settings: WebCodecsExportSettings,
  onProgress?: (completed: number, total: number) => void,
): Promise<{ blob: Blob; mimeType: string }> => {
  if (!isWebCodecsExportSupported()) {
    throw new Error("WebCodecs is not supported in this browser.")
  }
  if (frames.length === 0) {
    throw new Error("No frames to render.")
  }

  const fps = settings.fps ?? 30
  const frameDurationUs = Math.round(1_000_000 / fps)

  // IMPORTANT: encode at the captured canvas's actual pixel size, not
  // settings.width/height. Those are the CSS export size; the canvas the
  // capture step produced is settings.width * settings.scale pixels wide
  // (pixelRatio), and a VideoFrame built from a canvas takes on the
  // canvas's real pixel dimensions. Configuring the encoder for the wrong
  // (smaller, CSS) size is exactly what was closing the codec on the very
  // first frame. H.264 also needs even width/height, hence the trim.
  const sourceWidth = frames[0].canvas.width
  const sourceHeight = frames[0].canvas.height
  const width = sourceWidth - (sourceWidth % 2)
  const height = sourceHeight - (sourceHeight % 2)
  const needsCrop = width !== sourceWidth || height !== sourceHeight

  // How many fps-ticks each captured (held) frame expands into, computed up
  // front so we know the exact total duration before encoding a single
  // frame - needed to size the audio track.
  const ticksPerFrame = frames.map((frame) => Math.max(1, Math.round((frame.holdMs / 1000) * fps)))
  const totalFrameTicks = ticksPerFrame.reduce((sum, ticks) => sum + ticks, 0)

  const soundSamples = settings.soundUrl ? await loadNotificationSound(settings.soundUrl) : null
  const videoConfig = await pickVideoEncoderConfig(width, height, settings.videoBitrate ?? 6_000_000, fps)

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height },
    audio: soundSamples ? { codec: "aac", numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE } : undefined,
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  })

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => console.error("Video encode error", error),
  })
  videoEncoder.configure(videoConfig)

  // --- Audio: mix the notification sound into one flat PCM track spanning
  // the whole video, then feed it to AudioEncoder in fixed-size chunks.
  if (soundSamples) {
    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (error) => console.error("Audio encode error", error),
    })
    audioEncoder.configure({
      codec: "mp4a.40.2",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: 128_000,
    })

    const totalSamples = Math.ceil((totalFrameTicks / fps) * AUDIO_SAMPLE_RATE)
    const mixed = Array.from({ length: AUDIO_CHANNELS }, () => new Float32Array(totalSamples))

    let tickCursor = 0
    frames.forEach((frame, index) => {
      if (frame.playSound) {
        const startSample = Math.round((tickCursor / fps) * AUDIO_SAMPLE_RATE)
        for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
          const source = soundSamples[channel]
          for (let i = 0; i < source.length && startSample + i < totalSamples; i += 1) {
            mixed[channel][startSample + i] += source[i]
          }
        }
      }
      tickCursor += ticksPerFrame[index]
    })

    for (let offset = 0; offset < totalSamples; offset += AUDIO_CHUNK_FRAMES) {
      const frameCount = Math.min(AUDIO_CHUNK_FRAMES, totalSamples - offset)
      const interleaved = new Float32Array(frameCount * AUDIO_CHANNELS)
      for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
        for (let i = 0; i < frameCount; i += 1) {
          interleaved[i * AUDIO_CHANNELS + channel] = mixed[channel][offset + i]
        }
      }
      const audioData = new (globalThis as any).AudioData({
        format: "f32",
        sampleRate: AUDIO_SAMPLE_RATE,
        numberOfFrames: frameCount,
        numberOfChannels: AUDIO_CHANNELS,
        timestamp: Math.round((offset / AUDIO_SAMPLE_RATE) * 1_000_000),
        data: interleaved,
      })
      audioEncoder.encode(audioData)
      audioData.close()
    }

    await audioEncoder.flush()
    audioEncoder.close()
  }

  // --- Video: expand every held frame into `ticks` identical encoded
  // frames at the target fps, marking a keyframe on a fixed schedule.
  let tick = 0
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]
    const ticks = ticksPerFrame[index]

    for (let step = 0; step < ticks; step += 1) {
      const timestampUs = tick * frameDurationUs
      const isKeyFrame = tick % (fps * KEYFRAME_INTERVAL_SEC) === 0
      const videoFrame = new (globalThis as any).VideoFrame(frame.canvas, {
        timestamp: timestampUs,
        duration: frameDurationUs,
        ...(needsCrop ? { visibleRect: { x: 0, y: 0, width, height } } : {}),
      })
      videoEncoder.encode(videoFrame, { keyFrame: isKeyFrame })
      videoFrame.close()
      tick += 1

      // Simple backpressure: don't let the encode queue balloon if the
      // encoder can't keep up with how fast we can hand it frames.
      if (videoEncoder.encodeQueueSize > 30) {
        await new Promise((resolve) => window.setTimeout(resolve, 10))
      }
    }

    onProgress?.(index + 1, frames.length)
    // Free this frame's canvas now that every tick of it has been encoded.
    frame.canvas.width = 0
    frame.canvas.height = 0
  }

  await videoEncoder.flush()
  videoEncoder.close()
  muxer.finalize()

  const { buffer } = target
  return { blob: new Blob([buffer], { type: "video/mp4" }), mimeType: "video/mp4" }
}
