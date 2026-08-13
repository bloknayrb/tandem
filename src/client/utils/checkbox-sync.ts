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
 * **Why this is a function and not an action.** The correct moment to re-assert
 * is "after the async write and its refetch have resolved", which only the
 * caller knows. A `use:` action driven by `$effect` re-runs on dependency
 * change, and the defect is precisely that no dependency changed.
 *
 * **Why not `bind:checked`.** 21 of the 22 checkboxes in `src/client/` are
 * one-way; two-way binding is the outlier here, and switching a control to it
 * changes who owns the value. Re-asserting is the smaller, local fix.
 *
 * Call it at the end of every async handler that can leave the model unchanged.
 */
export function resyncCheckbox(box: HTMLInputElement, modelValue: boolean): void {
  box.checked = modelValue;
}
