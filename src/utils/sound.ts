/**
 * Plays the "new message" notification sound.
 *
 * Put your mp3 file at: public/sounds/notification.mp3
 * (i.e. next to index.html, in a "sounds" folder — Vite serves anything in
 * `public/` from the site root, so the file ends up reachable at
 * "/sounds/notification.mp3" regardless of which page/route is open).
 *
 * Don't have the file in place yet? This still fails silently (see catch
 * below), it just won't make any sound until the mp3 exists at that path.
 */
const NOTIFICATION_SOUND_URL = "/sounds/notification.mp3"

let cachedAudio: HTMLAudioElement | null = null

const getAudio = () => {
  if (!cachedAudio) {
    cachedAudio = new Audio(NOTIFICATION_SOUND_URL)
    cachedAudio.preload = "auto"
  }
  return cachedAudio
}

export const playMessageSound = (volume = 0.5) => {
  try {
    const audio = getAudio()
    audio.volume = volume
    // Restart from the beginning in case messages arrive faster than the clip's length.
    audio.currentTime = 0
    void audio.play().catch(() => {
      // Autoplay can be blocked until the user interacts with the page at least
      // once (e.g. clicking "Play conversation") - that's expected, not a bug.
    })
  } catch {
    // Ignore - unsupported browser or missing file.
  }
}
