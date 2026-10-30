import type { Page } from "@playwright/test";
import type { IncompleteNodeSample, Rgba } from "./axe-incomplete.js";

/**
 * The page-side half of #1721's per-node gate: for each color-contrast node axe
 * left `incomplete`, read what `assessIncompleteNode` (axe-incomplete.ts) needs
 * to measure it without axe. Not a `.spec.ts`, so Playwright does not collect
 * it; it is typechecked with the rest of `tests/e2e`.
 */

/** One axe node as the sampler receives it: axe's own target path and markup. */
export type AxeIncompleteNode = { target: unknown[]; html: string; messageKey: string | null };

/**
 * Gather, for each node axe left `incomplete`, what `assessIncompleteNode`
 * needs to measure it without axe — and every reason that measurement would
 * describe something other than the screen. Anything this cannot vouch for is
 * reported as `unresolvable`, which fails unless a keyed waiver names it.
 */
export async function sampleIncompleteNodes(
  page: Page,
  nodes: AxeIncompleteNode[],
): Promise<IncompleteNodeSample[]> {
  if (nodes.length === 0) return [];
  type Box = { x: number; y: number; width: number; height: number };
  const sampled = await page.evaluate((nodes) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const paint = (css: string): Rgba => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "rgba(0,0,0,0)";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    /** Tag, id and classes minus Svelte's hashed scope class (it moves on any style edit). */
    const tagOf = (n: Element) =>
      `<${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}${Array.from(n.classList)
        .filter((c) => !c.startsWith("svelte-"))
        .map((c) => `.${c}`)
        .join("")}>`;
    /** `tagOf` plus its own `data-testid` — what the reasons name elements by. */
    const describe = (n: Element) => {
      const id = n.getAttribute("data-testid");
      return id ? tagOf(n).replace(/>$/, `[data-testid="${id}"]>`) : tagOf(n);
    };
    /** The properties that make a box paint something other than its flat fill. */
    const alters = (cs: CSSStyleDeclaration) =>
      [
        cs.backgroundImage !== "none" && "background-image",
        cs.filter !== "none" && "filter",
        (cs.backdropFilter ?? "none") !== "none" && "backdrop-filter",
        cs.mixBlendMode !== "normal" && "mix-blend-mode",
      ].filter((p): p is string => !!p);
    /** A fill, or anything that alters what is beneath it. */
    const paints = (cs: CSSStyleDeclaration) =>
      paint(cs.backgroundColor)[3] > 0 || alters(cs).length > 0;
    /** A `::before`/`::after` that paints a fill. `elementsFromPoint` never returns pseudos. */
    const pseudoFill = (n: Element) =>
      (["::before", "::after"] as const).find((p) => {
        const cs = getComputedStyle(n, p);
        return cs.content !== "none" && cs.content !== "normal" && paints(cs);
      });
    // `opaque(o, other)`: `o` paints an opaque, unfiltered fill that no
    // opacity between it and its nearest common ancestor with `other` fades
    // (a shared ancestor's opacity fades both together).
    const opaque = (o: Element, other: Element) => {
      const cs = getComputedStyle(o);
      if (
        paint(cs.backgroundColor)[3] < 1 ||
        cs.filter !== "none" ||
        cs.mixBlendMode !== "normal"
      ) {
        return false;
      }
      for (let n: Element | null = o; n && !n.contains(other); n = n.parentElement) {
        if (Number(getComputedStyle(n).opacity) < 1) return false;
      }
      return true;
    };

    // `elementsFromPoint` skips `pointer-events: none`, which is exactly what
    // toasts, scrims and decorative overlays tend to carry — so for the
    // duration of this synchronous probe EVERYTHING is hit-testable. Removed
    // before returning; nothing yields in between, so no hover recomputation
    // can land inside the probe.
    const darkScheme = /dark/.test(getComputedStyle(document.documentElement).colorScheme);
    const lift = document.createElement("style");
    lift.textContent = "* { pointer-events: auto !important; }";
    document.head.appendChild(lift);
    try {
      return nodes.map(({ target, html, messageKey }) => {
        const unresolvable: string[] = [];
        const result = {
          target: String(target.at(-1) ?? ""),
          messageKey,
          text: "",
          fg: [0, 0, 0, 1] as Rgba,
          layers: [] as Array<{ bg: Rgba; opacity: number }>,
          fontSizePx: 0,
          fontWeight: 400,
          unresolvable,
          coveredBy: null as string | null,
          descriptor: String(target.at(-1) ?? ""),
          rects: [] as Box[],
          /** Ancestor-or-self hops (0 = the node) that carry a mask image. */
          maskHops: [] as number[],
        };
        // axe's target is a PATH: more than one entry means an iframe or
        // shadow root, and `querySelector` on the last hop would find
        // something else.
        if (target.length !== 1 || typeof target[0] !== "string") {
          unresolvable.push(
            `axe target ${JSON.stringify(target)} is not a single document selector`,
          );
          return result;
        }
        const el = document.querySelector(target[0]);
        if (!(el instanceof HTMLElement)) {
          unresolvable.push("axe's target no longer resolves to an element");
          return result;
        }
        // The sample runs after the scan, so check it found the node axe meant.
        if (!html.toLowerCase().startsWith(`<${el.tagName.toLowerCase()}`)) {
          unresolvable.push(
            `axe's target now resolves to ${describe(el)}, not ${html.slice(0, 40)}`,
          );
          return result;
        }
        const cs = getComputedStyle(el);
        result.text = Array.from(el.childNodes)
          .filter((c) => c.nodeType === Node.TEXT_NODE)
          .map((c) => c.textContent ?? "")
          .join("")
          .trim();
        const owner = el.closest("[data-testid]")?.getAttribute("data-testid");
        result.descriptor = `${owner ? `[data-testid="${owner}"] ` : ""}${tagOf(el)} ${JSON.stringify(result.text)}`;
        if (!result.text) {
          // The colour and size read below are this element's, not the
          // descendant's that actually paints the glyphs.
          unresolvable.push("no text of its own (its text is in a descendant)");
          return result;
        }
        // Inherited, so the node's own computed value already carries any
        // ancestor's: a shadow or stroke repaints the glyph edge in another colour.
        if (cs.textShadow !== "none") unresolvable.push("text-shadow on the node");
        if (Number.parseFloat(cs.getPropertyValue("-webkit-text-stroke-width")) > 0) {
          unresolvable.push("-webkit-text-stroke on the node");
        }
        const fill = paint(cs.getPropertyValue("-webkit-text-fill-color") || "transparent");
        result.fg = fill[3] > 0 ? fill : paint(cs.color);
        result.fontSizePx = Number.parseFloat(cs.fontSize);
        result.fontWeight = Number(cs.fontWeight);

        const chain: HTMLElement[] = [];
        for (let n: HTMLElement | null = el; n; n = n.parentElement) chain.unshift(n);
        result.layers = chain.map((n) => {
          const ncs = getComputedStyle(n);
          const label = n === el ? "the node" : describe(n);
          for (const p of alters(ncs)) unresolvable.push(`${p} on ${label}`);
          // A mask fades the whole subtree toward transparent wherever its
          // image does (scroll-fade edges), which no flat ratio describes.
          const mask = ncs.maskImage || ncs.getPropertyValue("-webkit-mask-image");
          if (mask && mask !== "none") {
            unresolvable.push(`mask-image on ${label}`);
            result.maskHops.push(chain.length - 1 - chain.indexOf(n));
          }
          const pseudo = pseudoFill(n);
          if (pseudo) unresolvable.push(`${pseudo} fill on ${label}`);
          return { bg: paint(ncs.backgroundColor), opacity: Number(ncs.opacity) };
        });
        // The arithmetic puts white under the root. Under a dark colour-scheme
        // with no opaque layer anywhere, the real canvas is not white.
        if (darkScheme && !result.layers.some((l) => l.bg[3] === 1)) {
          unresolvable.push(
            "no opaque layer, and the canvas is not white under a dark color-scheme",
          );
        }

        // The node's OWN text boxes — the same text `result.text`, `fg` and the
        // font size describe. `selectNodeContents(el)` would also return every
        // descendant element's border box, hit-testing ground no glyph sits on.
        const range = document.createRange();
        result.rects = Array.from(el.childNodes)
          .filter((c) => c.nodeType === Node.TEXT_NODE)
          .flatMap((c) => {
            range.selectNodeContents(c);
            return Array.from(range.getClientRects());
          })
          .filter((r) => r.width > 0 && r.height > 0)
          .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
        if (result.rects.length === 0) {
          unresolvable.push("the text has no box on screen");
          return result;
        }

        // Every line box, at its centre and just inside its corners.
        const notes = new Set<string>();
        let hits = 0;
        let covered = 0;
        for (const r of result.rects) {
          const inset = Math.min(1, r.width / 4, r.height / 4);
          for (const [x, y] of [
            [r.x + r.width / 2, r.y + r.height / 2],
            [r.x + inset, r.y + inset],
            [r.x + r.width - inset, r.y + inset],
            [r.x + inset, r.y + r.height - inset],
            [r.x + r.width - inset, r.y + r.height - inset],
          ] as Array<[number, number]>) {
            const stack = document.elementsFromPoint(x, y);
            const at = stack.findIndex((s) => s === el || el.contains(s));
            // Absent here means clipped here (an ancestor's overflow), which
            // hides that part of the glyphs without recolouring the rest, so the
            // point carries no evidence either way.
            if (at === -1) continue;
            hits++;
            const above = stack
              .slice(0, at)
              .filter((s) => paints(getComputedStyle(s)) || pseudoFill(s));
            const cover = above.find((s) => opaque(s, el));
            if (cover) {
              covered++;
              result.coveredBy ??= describe(cover);
              continue;
            }
            for (const s of above) notes.add(`painted over by ${describe(s)}`);
            // Each ancestor fill the arithmetic counts must really be under
            // the glyphs HERE. A child positioned outside its dark parent, or a
            // rounded corner, leaves the parent's fill out of the stack.
            chain.forEach((n, i) => {
              if (result.layers[i].bg[3] > 0 && !stack.includes(n)) {
                notes.add(`${describe(n)}'s fill is not under the text`);
              }
            });
            stack.slice(at + 1).forEach((s, i) => {
              if (s.contains(el)) return;
              if (!paints(getComputedStyle(s)) && !pseudoFill(s)) return;
              const between = stack.slice(at, at + 1 + i);
              if (between.some((o) => (o === el || o.contains(el)) && opaque(o, s))) return;
              notes.add(`${describe(s)} paints beneath it and shows through`);
            });
          }
        }
        if (hits === 0) notes.add("the text is not hit-testable at any sampled point");
        // Covered must hold at every point that hit; anything less is a partial
        // cover the arithmetic cannot describe.
        if (result.coveredBy && covered !== hits) {
          notes.add(`partly covered by ${result.coveredBy}`);
          result.coveredBy = null;
        }
        if (!result.coveredBy) unresolvable.push(...notes);
        return result;
      });
    } finally {
      lift.remove();
    }
  }, nodes);

  // Two questions the hit test cannot answer are answered by the pixels
  // instead: does the node paint anything at all (an opaque element above it at
  // every sampled point is only a candidate for "covered"), and does a mask on
  // an ancestor change anything over the node's own boxes (a scroll-fade only
  // bites near its edges). Each is a screenshot of every line box before and
  // after one change, with transitions and animations off; identical bytes
  // answer yes, anything else leaves the node unresolvable.
  const out: IncompleteNodeSample[] = [];
  for (const { rects, maskHops, ...sample } of sampled) {
    if (sample.coveredBy) {
      const result = await pixelsUnchanged(page, rects, sample.target, "hide", []);
      if (result === "unchanged") {
        out.push(sample);
        continue;
      }
      sample.unresolvable.push(
        result === "changed"
          ? `partly visible under ${sample.coveredBy}`
          : "could not hide it to prove it covered (it holds focus, or did not hide)",
      );
      sample.coveredBy = null;
    } else if (maskHops.length > 0) {
      const result = await pixelsUnchanged(page, rects, sample.target, "unmask", maskHops);
      if (result === "unchanged") {
        sample.unresolvable = sample.unresolvable.filter((r) => !r.startsWith("mask-image on "));
      }
    }
    out.push(sample);
  }
  return out;
}

/**
 * Screenshot the union of `rects`, apply one change, screenshot again, revert.
 * `hide` hides the node and its subtree; `unmask` removes the mask images on
 * the ancestors `hops` above the node. `refused` when the change could not be
 * applied (the node holds focus, or the style did not take).
 */
async function pixelsUnchanged(
  page: Page,
  rects: Array<{ x: number; y: number; width: number; height: number }>,
  target: string,
  change: "hide" | "unmask",
  hops: number[],
): Promise<"unchanged" | "changed" | "refused"> {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  const clip = {
    x: Math.max(0, Math.floor(x0) - 1),
    y: Math.max(0, Math.floor(y0) - 1),
    width: Math.ceil(x1 - x0) + 2,
    height: Math.ceil(y1 - y0) + 2,
  };
  const shot = () => page.screenshot({ clip, animations: "disabled" });
  const before = await shot();
  try {
    const applied = await page.evaluate(
      ({ target, change, hops }) => {
        const el = document.querySelector(target);
        if (!el) return false;
        const style = document.createElement("style");
        style.id = "axe-probe";
        if (change === "hide") {
          // Chromium blurs a focused element that turns `visibility: hidden`
          // in a task AFTER this returns, so comparing `activeElement` here
          // would always pass. Refuse up front instead: hiding a node that
          // holds focus would move focus, and nothing restores it.
          if (el.contains(document.activeElement)) return false;
          el.setAttribute("data-axe-probe", "");
          style.textContent =
            "[data-axe-probe], [data-axe-probe] * { visibility: hidden !important; transition: none !important; }";
          document.head.appendChild(style);
          return getComputedStyle(el).visibility === "hidden";
        }
        const holders = hops.map((h) => {
          let n: Element | null = el;
          for (let i = 0; i < h && n; i++) n = n.parentElement;
          return n;
        });
        for (const n of holders) n?.setAttribute("data-axe-probe", "");
        style.textContent =
          "[data-axe-probe] { mask-image: none !important; -webkit-mask-image: none !important; transition: none !important; }";
        document.head.appendChild(style);
        return holders.every((n) => n && getComputedStyle(n).maskImage === "none");
      },
      { target, change, hops },
    );
    if (!applied) return "refused";
    return before.equals(await shot()) ? "unchanged" : "changed";
  } finally {
    await page.evaluate(() => {
      for (const n of document.querySelectorAll("[data-axe-probe]")) {
        n.removeAttribute("data-axe-probe");
      }
      document.getElementById("axe-probe")?.remove();
    });
  }
}
