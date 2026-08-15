/**
 * Re-assert a one-way `checked=` checkbox against the model that owns it.
 *
 * **The trap.** Svelte compiles `checked={expr}` to a `set_checked` call that
 * caches the last value it wrote and returns *before touching the DOM* when the
 * new value compares equal. A user click mutates `input.checked` without
 * updating that cache. So any transition that leaves `expr` re-computing to its
 * pre-click value never writes, and the control keeps the state the click gave
 * it — over a model that never moved. Nothing re-runs to heal it, because the
 * whole condition is that the dependency did *not* change.
 *
 * It bites exactly where the click drives an **async, failable** write: the
 * failure path is the one that leaves the model untouched. Measured instance:
 * decline the UAC prompt on Cowork disable and the toggle reads off, the line
 * directly beneath it reads "Integration enabled: yes", and the next click —
 * seeing an unchecked box — opens the *Enable* confirm. The disable becomes
 * unreachable without a remount.
 *
 * **Why not `bind:checked`.** 21 of the 22 checkboxes in `src/client/` are
 * one-way; two-way binding is the outlier here, and switching a control to it
 * changes who owns the value. Re-asserting is the smaller, local fix.
 *
 * **`modelValue` MUST be the `checked=` expression itself, not the model field
 * it happens to read today.** This writes `box.checked` without updating
 * `set_checked`'s cache, so a value that disagrees with the expression does not
 * merely look wrong for a frame — it latches. The DOM holds one value, the
 * cache holds the other, and the next re-computation back to the cached value
 * is skipped, leaving a control the user cannot move. Where the expression is
 * more than a bare field, hoist it into one `$derived` and pass that (see
 * `enableBoxChecked` in `CoworkSettings.svelte`).
 *
 * Call it at the end of every async handler that can leave the model unchanged
 * — and only when the model is known to be CURRENT. Re-asserting from a value
 * whose refresh silently failed paints a stale state as though it were the
 * outcome, which is worse than not re-asserting at all.
 */
export function resyncCheckbox(box: HTMLInputElement, modelValue: boolean): void {
  box.checked = modelValue;
}
