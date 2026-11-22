export interface ImeKeyboardEvent {
  readonly nativeEvent: {
    readonly isComposing?: boolean;
    readonly keyCode?: number;
  };
}

/** Returns true while a keydown belongs to an active IME composition. */
export function isImeComposing(event: ImeKeyboardEvent): boolean {
  return event.nativeEvent.isComposing === true || event.nativeEvent.keyCode === 229;
}
