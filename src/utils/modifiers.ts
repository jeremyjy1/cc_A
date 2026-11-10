export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

type NativeModifiers = {
  prewarm(): void
  isModifierPressed(modifier: ModifierKey): boolean
}

let native: NativeModifiers | null | undefined

export function prewarmModifiers(): void {
  if (native !== undefined || process.platform !== 'darwin') return
  try {
    native = require('modifiers-napi') as NativeModifiers
    native.prewarm()
  } catch {
    // Source installations can run without the optional macOS keyboard helper.
    native = null
  }
}

export function isModifierPressed(modifier: ModifierKey): boolean {
  prewarmModifiers()
  return native?.isModifierPressed(modifier) ?? false
}
