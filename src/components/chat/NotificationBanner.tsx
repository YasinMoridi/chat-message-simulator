import { AvatarImage } from "@/components/ui/avatar-image"
import { cn } from "@/utils/cn"

export type NotificationPlatform = "ios" | "android"

interface NotificationBannerProps {
  platform: NotificationPlatform
  /** Name of the app shown in the banner, e.g. "WhatsApp", "Instagram". */
  appName: string
  /** Brand color for the little app icon when there's no avatar to show instead. */
  appColor: string
  senderName: string
  /** Message preview text. Long messages are clamped to a couple of lines. */
  messageText: string
  avatarUrl?: string
  /**
   * Controls the enter/exit animation. Keep the component mounted and just
   * flip this instead of conditionally rendering it, so the slide/fade
   * transition actually plays instead of popping in and out instantly.
   */
  visible: boolean
  /** Small time label on the right, e.g. "now". Defaults to "now". */
  timeLabel?: string
  /**
   * When true, the banner behaves like a real tappable OS notification -
   * shows a pointer cursor, responds to hover/press, and calls onClick.
   */
  clickable?: boolean
  /** Called when a clickable banner is tapped. */
  onClick?: () => void
  /**
   * True while waiting out the configured delay between the tap and
   * actually opening the chat - shown as a brief pressed/dimmed state so
   * the tap feels acknowledged instead of unresponsive.
   */
  isOpening?: boolean
}

const initialsOf = (name: string) =>
  name
    .trim()
    .charAt(0)
    .toUpperCase() || "?"

/**
 * Simulated OS-level notification banner (the one that slides down from the
 * top of the screen when a message arrives) - not the in-app chat header.
 * Two distinct visual styles since iOS and Android banners look quite
 * different in real life; which one renders is decided by the caller
 * (usually based on the selected chat layout).
 */
export const NotificationBanner = ({
  platform,
  appName,
  appColor,
  senderName,
  messageText,
  avatarUrl,
  visible,
  timeLabel = "now",
  clickable = false,
  onClick,
  isOpening = false,
}: NotificationBannerProps) => {
  const icon = avatarUrl ? (
    <AvatarImage
      src={avatarUrl}
      alt={senderName}
      className={platform === "ios" ? "h-8 w-8 rounded-[0.55rem]" : "h-9 w-9"}
    />
  ) : (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center font-semibold text-white",
        platform === "ios" ? "h-8 w-8 rounded-[0.55rem] text-sm" : "h-9 w-9 rounded-full text-sm",
      )}
      style={{ backgroundColor: appColor }}
    >
      {initialsOf(senderName)}
    </div>
  )

  return (
    <div
      aria-hidden={!clickable}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
      className={cn(
        "absolute left-0 right-0 top-0 z-30 flex justify-center px-2.5 pt-2.5 transition-all duration-300 ease-out",
        clickable ? "cursor-pointer" : "pointer-events-none",
        visible ? "translate-y-0 opacity-100" : "-translate-y-8 opacity-0",
        clickable && isOpening && "scale-[0.97] opacity-80",
      )}
    >
      {platform === "ios" ? (
        <div
          className={cn(
            "flex w-full max-w-[calc(100%-8px)] items-start gap-2.5 rounded-2xl bg-white/85 px-3 py-2.5 shadow-[0_4px_18px_rgba(0,0,0,0.18)] backdrop-blur-md",
            clickable && "transition-shadow hover:bg-white/95",
          )}
        >
          {icon}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-slate-500">
                {appName}
              </span>
              <span className="shrink-0 text-[0.7rem] text-slate-400">{timeLabel}</span>
            </div>
            <div className="truncate text-[0.85rem] font-semibold text-slate-900">
              {senderName}
            </div>
            <div
              dir="auto"
              className="text-[0.8rem] leading-snug text-slate-700"
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {messageText}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "flex w-full max-w-[calc(100%-8px)] items-center gap-2.5 rounded-xl bg-slate-900/90 px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.25)]",
            clickable && "transition-shadow hover:bg-slate-900/95",
          )}
        >
          {icon}
          <div className="min-w-0 flex-1">
            <div dir="auto" className="truncate text-[0.8rem] leading-snug text-white">
              <span className="font-semibold">{senderName}</span>
              <span className="text-slate-300"> - {messageText}</span>
            </div>
          </div>
          <span className="shrink-0 text-[0.7rem] text-slate-400">{timeLabel}</span>
        </div>
      )}
    </div>
  )
}

/** Which OS-style banner a given chat layout should use by default. */
export const notificationPlatformForLayout = (layoutId: string): NotificationPlatform =>
  layoutId === "imessage" ? "ios" : "android"
