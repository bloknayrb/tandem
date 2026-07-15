/**
 * Shared Enter/Space keyboard-activation handler factory for non-native
 * interactive elements (divs with role="button", composite card roots).
 *
 * Deliberately a plain handler factory, NOT a `use:` action: an action hides
 * the keydown from svelte-check's static a11y analysis, which would force
 * re-adding `a11y_click_events_have_key_events` suppressions that PR #1184
 * removed. Keeping `onkeydown={activationKeydown(...)}` in the markup leaves
 * the handler visible to the analyzer.
 *
 * Native `<button>` elements never need this — the platform synthesizes a
 * click from Enter/Space; just use `onclick`.
 */
export interface ActivationOptions {
  /** Ignore events bubbled from descendants (composite widgets / backdrops
      with nested dialogs). Without this, a backdrop's `preventDefault()`
      swallows Enter/Space activation of every control inside the dialog. */
  selfOnly?: boolean;
}

export function activationKeydown(
  handler: () => void,
  opts: ActivationOptions = {},
): (e: KeyboardEvent) => void {
  return (e) => {
    if (opts.selfOnly && e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handler();
  };
}
