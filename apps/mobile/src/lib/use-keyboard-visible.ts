import { useEffect, useState } from "react"
import { Keyboard, Platform } from "react-native"

/** Whether the software keyboard is up. iOS reports it as it starts to move, so layout keeps pace. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow",
      () => setVisible(true)
    )
    const hide = Keyboard.addListener(
      Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide",
      () => setVisible(false)
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return visible
}
