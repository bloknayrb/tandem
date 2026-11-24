import type { Toast } from "../hooks/useNotifications.svelte";
import { formatActivityMessage } from "./activityCenter.js";

/**
 * Toast-stack accessibility helpers (#2489). Pure apart from reading the DOM
 * they are handed, so `ToastContainer` stays markup and the rules are tested
 * here directly.
 */

/**
 * The `{#each}` key of a toast card. A coalescing re-push replaces the toast
 * with the new push's id (`pushTransient`), so keying on the id re-created the
 * card on every bump and dropped any focus inside it. The `dedupKey` survives a
 * bump, and `pushTransient` keeps at most one toast per `dedupKey`; the two
 * prefixes keep a dedupKey from ever colliding with another toast's id.
 */
export function toastKey(toast: Pick<Toast, "id" | "dedupKey">): string {
  return toast.dedupKey ? `k:${toast.dedupKey}` : `i:${toast.id}`;
}

/**
 * The sentence an announcer speaks for the toast `id` names: empty when there
 * is none or it is gone. A repeat (`count > 1`) says how many times, so the
 * sentence changes on each bump and is spoken again — the same news a sighted
 * user gets from the ×N badge and the restarted timer.
 */
export function toastAnnouncementText(toasts: readonly Toast[], id: string | null): string {
  if (id === null) return "";
  const toast = toasts.find((t) => t.id === id);
  if (!toast) return "";
  const text = formatActivityMessage(toast);
  return toast.count > 1 ? `${text} (${toast.count} times)` : text;
}

/**
 * A card's Dismiss button, never its action: a keyboard user clearing the
 * stack presses Enter again where focus lands, and an action does real work
 * (starts Claude, sets who answers chat) that a repeated or held Enter must
 * not trigger.
 */
function dismissButton(card: Element): HTMLElement | null {
  return card.querySelector<HTMLElement>("[data-testid^='toast-dismiss-']");
}

/**
 * Where focus should go when the card holding it is about to be removed, or
 * null to leave focus alone. Called before the DOM update, so `active` and the
 * cards are still the outgoing ones.
 *
 * Null unless `active` is inside a card whose key is not in `nextKeys`: a
 * removal that does not take focus with it moves nothing, and focus already
 * somewhere else (a dialog the press opened, the editor) is never pulled out.
 *
 * Otherwise, first match: the Dismiss button of the nearest surviving card
 * after it, then before it (so a keyboard user can work down the stack); the
 * element focus came from before it entered the stack, while that is still in
 * the document and outside the stack; else null, leaving the browser's
 * default (the body).
 */
export function toastFocusTarget(
  active: Element | null,
  nextKeys: ReadonlySet<string>,
  returnTarget: Element | null,
): HTMLElement | null {
  const card = active?.closest<HTMLElement>("[data-toast-key]");
  if (!card) return null;
  const key = card.dataset.toastKey;
  if (key === undefined || nextKeys.has(key)) return null;

  const stack = card.parentElement;
  const cards = stack
    ? Array.from(stack.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.dataset.toastKey !== undefined,
      )
    : [];
  const at = cards.indexOf(card);
  const survives = (el: HTMLElement) => nextKeys.has(el.dataset.toastKey ?? "");
  const after = cards.slice(at + 1).find(survives);
  const before = cards.slice(0, Math.max(at, 0)).reverse().find(survives);
  const neighbour = after ?? before;
  const neighbourButton = neighbour ? dismissButton(neighbour) : null;
  if (neighbourButton) return neighbourButton;

  if (
    returnTarget instanceof HTMLElement &&
    returnTarget.isConnected &&
    returnTarget !== returnTarget.ownerDocument.body &&
    !stack?.contains(returnTarget)
  ) {
    return returnTarget;
  }
  return null;
}
