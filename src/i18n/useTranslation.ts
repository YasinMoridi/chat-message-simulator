import { useConversationStore } from "@/store/conversationStore"
import { translations } from "./translations"

/**
 * Gives components access to the app's own UI copy in the currently
 * selected language, plus the language value/setter and text direction.
 * Only the tool's interface (labels, buttons, settings) is translated -
 * message content the user types stays exactly as written.
 */
export const useTranslation = () => {
  const language = useConversationStore((state) => state.language)
  const setLanguage = useConversationStore((state) => state.setLanguage)
  const dict = translations[language]
  const dir = language === "fa" ? "rtl" : "ltr"
  return { t: dict, language, setLanguage, dir }
}
