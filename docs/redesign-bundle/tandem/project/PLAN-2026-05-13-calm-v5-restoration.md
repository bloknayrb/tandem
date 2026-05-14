# Calm v5 — restoration plan (carry forward v3 surfaces missing from v4)

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. Execute task-by-task.

**Goal:** Restore five interface elements from `Tandem Redesign v3.html` that were dropped or compressed in `tandem-calm-v4.html`, in the calm aesthetic.

**Architecture:** Spin a new top-level entry file `Tandem - Calm Synthesis v5.html` (rather than mutating v4 in place) and a new component file `calm-v5.jsx` for the three new React components. v4 stays browsable for A/B comparison. The shared CSS/JSX stack (`calm-v1/v2/v4.jsx/css`, `design-canvas.jsx`, `tweaks-panel.jsx`) is reused as-is.

**Tech Stack:** React 18 (pinned UMD), Babel standalone, inline JSX. Inter Tight + Source Serif 4 + JetBrains Mono. OKLch tokens. Existing class system: `.c1-sheet`, `.c1-doc`, `.c1-rail`, `.c4-auth`, `.frame`.

**Open decisions to confirm with user before implementation:**
- D1. Spin v5 vs. patch v4 in place? (Plan assumes v5.)
- D2. Recreate v3's C5 (`<860px` settings) at 860×660, or scale to the calm-v4 setting/preference surface that doesn't yet exist? (Plan assumes faithful 860×660 restoration with calm palette swap.)
- D3. Should the category legend live above or below the decision-strip? (Plan: above. Reason: taxonomy belongs before highlights.)

---

## File map (what gets created or modified)

| File | Action | Responsibility |
|------|--------|----------------|
| `Tandem - Calm Synthesis v5.html` | Create (copy of v4 entry HTML) | Page shell, hero, category legend, decision strip, section list |
| `calm-v5.jsx` | Create | Three new React components: `CalmV5CatLegend`, `CalmV5AnnoSummary` (C7), `CalmV5NarrowSettings` (C5), `CalmV5HeldQueued` (B3 State 2) |
| `tandem-calm-v4.html` | No change | Preserved for A/B |
| `calm-v4.jsx`, `calm-v4b.jsx`, `calm-v1.jsx`, `calm-v2.jsx` | No change | Reused as-is |

No CSS files are touched — all new component styling is scoped inline in the JSX to stay consistent with how `calm-v4b.jsx` patterns work (each spec panel inlines its own style).

---

## Task 1: Create v5 entry HTML (clone of v4, no behavior change yet)

**Files:**
- Create: `Tandem - Calm Synthesis v5.html`

- [ ] **Step 1: Copy v4 → v5**

```bash
cp "tandem-calm-v4.html" "Tandem - Calm Synthesis v5.html"
```

- [ ] **Step 2: Update title, meta line, thumbnail tag**

In `Tandem - Calm Synthesis v5.html`:

Replace `<title>Tandem — Calm Synthesis v4</title>` with `<title>Tandem — Calm Synthesis v5</title>`.

Replace `<div class="meta">Tandem · calm synthesis v4 · 2026-05-13</div>` with `<div class="meta">Tandem · calm synthesis v5 · 2026-05-13</div>`.

Replace the SVG text tag `<text x="10" y="95" fill="oklch(0.52 0.16 275)" font-size="5" font-family="monospace">calm v4</text>` with `<text x="10" y="95" fill="oklch(0.52 0.16 275)" font-size="5" font-family="monospace">calm v5</text>`.

- [ ] **Step 3: Open in browser; confirm renders identical to v4**

Open the file in the project preview. Expected: identical render to v4, only the meta-line and tab title differ.

- [ ] **Step 4: Commit (logical checkpoint — no git here, but mark task done)**

Note: This is a non-git filesystem project. Treat each task's end as a "commit" — verify by visual inspection in the preview pane.

---

## Task 2: Rewrite hero (restore meta-narrative + audit-trail line)

**Files:**
- Modify: `Tandem - Calm Synthesis v5.html` (hero block, lines ~86–90 in v4 baseline)

- [ ] **Step 1: Replace the hero `<h1>` and `<p>`**

Replace the existing hero block:

```html
<div class="hero">
  <div class="meta">Tandem · calm synthesis v5 · 2026-05-13</div>
  <h1>The v3 surfaces,<br/><em>in the calm language.</em></h1>
  <p>v3 locked in a set of chrome revisions (A1–A3) and introduced a full new tier of surfaces (C1–C7, B3, B5, D1–D5, F). This v4 applies the calm aesthetic consistently across all of them: merged titlebar, per-run text-tint authorship, dual-tier selection, and warm canvas treatment for every spec panel.</p>
</div>
```

With:

```html
<div class="hero">
  <div class="meta">Tandem · calm synthesis v5 · 2026-05-13</div>
  <h1>v3 catalogued the surfaces.<br/><em>v5 puts them in one calm language.</em></h1>
  <p>v3 (post-v0.11.0) catalogued three chrome revisions (A1–A3), five locked decisions (B3, B5, …), seven new surfaces (C1–C7), five detail specs (D1–D5), one hazard response (E1), and five speculative directions (F1, F3–F6). v5 carries every one of those artboards into the calm aesthetic — warm canvas, per-run text-tint authorship, dual-tier selection, merged titlebar — and adds the dark-mode treatment v3 didn't have.</p>
  <p style="margin-top:8px;font-size:13px;color:oklch(0.55 0.008 280);">v3 source-of-truth in <code style="font-family:'JetBrains Mono',monospace;font-size:11.5px">Tandem Redesign v3.html</code> &middot; v5 supersedes v4 for visual treatment, does not re-litigate any v3 decision &middot; HANDOFF in <code style="font-family:'JetBrains Mono',monospace;font-size:11.5px">HANDOFF.v3.md</code></p>
</div>
```

- [ ] **Step 2: Verify in preview**

Expected: hero reads as a meta-narrative summarising what v3 settled and what v5 adds, with a clear pointer to source files. No layout shift to anything below it (hero `max-width` and margins unchanged).

---

## Task 3: Create `calm-v5.jsx` shell + first component (`CalmV5CatLegend`)

**Files:**
- Create: `calm-v5.jsx`
- Modify: `Tandem - Calm Synthesis v5.html` (script tag list + hero/decision-strip block)

- [ ] **Step 1: Create empty `calm-v5.jsx` with a smoke-test export**

```jsx
// calm-v5.jsx — new components introduced in v5 to restore v3 surfaces missing from v4.
// Components: CalmV5CatLegend, CalmV5AnnoSummary, CalmV5NarrowSettings, CalmV5HeldQueued.

function CalmV5CatLegend() {
  const cats = [
    { id: 'A', label: 'Shipped differently',   hue: 275, chroma: 0.020 },
    { id: 'B', label: 'Decisions locked',      hue:  70, chroma: 0.022 },
    { id: 'C', label: 'New surfaces',          hue: 150, chroma: 0.018 },
    { id: 'D', label: 'Detail specs',          hue: 245, chroma: 0.018 },
    { id: 'E', label: 'Hazards',               hue:  25, chroma: 0.022 },
    { id: 'F', label: 'Speculative',           hue:  55, chroma: 0.020 },
  ];
  const css = {
    legend: {
      maxWidth: 1100, margin: '0 auto 28px',
      display: 'flex', gap: 10, flexWrap: 'wrap',
      padding: '14px 18px',
      background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.90 0.008 75)',
      borderRadius: 10,
    },
    badge: (h, c) => ({
      display: 'inline-flex', alignItems: 'center', gap: 7,
      padding: '4px 11px', borderRadius: 99,
      fontSize: 11.5, fontWeight: 500,
      fontFamily: 'Inter Tight, sans-serif',
      background: `oklch(0.94 ${c} ${h})`,
      border: `1px solid oklch(0.86 ${c * 2.5} ${h})`,
      color: `oklch(0.40 ${Math.max(c * 7, 0.12)} ${h})`,
    }),
    dot: (h, c) => ({
      width: 7, height: 7, borderRadius: '50%',
      background: `oklch(0.55 ${Math.max(c * 7, 0.14)} ${h})`,
    }),
  };
  return (
    <div style={css.legend} aria-label="Category legend">
      {cats.map(c => (
        <span key={c.id} style={css.badge(c.hue, c.chroma)}>
          <span style={css.dot(c.hue, c.chroma)} />
          {c.id} &mdash; {c.label}
        </span>
      ))}
    </div>
  );
}

Object.assign(window, { CalmV5CatLegend });
```

- [ ] **Step 2: Add `<script type="text/babel" src="calm-v5.jsx"></script>` to v5 HTML**

Insert after the line `<script type="text/babel" src="calm-v4b.jsx"></script>` so v5 components are defined before the inline Page renders. Final order:

```html
<script type="text/babel" src="design-canvas.jsx"></script>
<script type="text/babel" src="calm-v1.jsx"></script>
<script type="text/babel" src="calm-v2.jsx"></script>
<script type="text/babel" src="calm-v4.jsx"></script>
<script type="text/babel" src="calm-v4b.jsx"></script>
<script type="text/babel" src="calm-v5.jsx"></script>
<script type="text/babel" src="tweaks-panel.jsx"></script>
```

- [ ] **Step 3: Mount the legend in the hero region**

In `Tandem - Calm Synthesis v5.html`, after the closing `</div>` of the `.hero` block and before `<div class="decision-strip">`, add:

```html
<div id="cat-legend-root"></div>
```

Then inside the existing inline `<script type="text/babel" data-presets="env,react">` block that renders the Page, before the `ReactDOM.createRoot(document.querySelector('design-canvas'))…` line, add:

```jsx
ReactDOM.createRoot(document.getElementById('cat-legend-root')).render(<CalmV5CatLegend />);
```

- [ ] **Step 4: Visual verification**

Open v5 in the preview. Expected: a single horizontal pill row above the decision-strip showing six pills (A through F), each with a colored dot, colors muted/warm to match the calm canvas (not the saturated v3 chips). No console errors.

---

## Task 4: Add `CalmV5HeldQueued` — B3 State 2 (Solo queued / pending review)

**Files:**
- Modify: `calm-v5.jsx` (append component)
- Modify: `Tandem - Calm Synthesis v5.html` (insert artboard in `b3-held` section)

- [ ] **Step 1: Inspect existing B3 components for visual contract**

Before writing State 2, search `calm-v4.jsx` and `calm-v4b.jsx` for `CalmV4HeldSolo` and `CalmV4HeldReview` to understand:
- frame structure (titlebar / canvas / rail)
- author tint variables in scope
- the "banner" element pattern, if any

Command (Grep tool):
- Pattern: `CalmV4HeldSolo|CalmV4HeldReview`
- Output mode: `content`, with `-C: 30`

Expected: you'll see how the active and review states are framed. Mirror that structure exactly for State 2.

- [ ] **Step 2: Append component to `calm-v5.jsx`**

State 2 sits between active (solo writing) and review (Solo→Tandem). It's the *queued* moment: the user has paused/finished solo, the merge proposal is ready but unaccepted. Visual cues:
- Banner above editor: muted amber, copy `"Solo session ready to review · 3 changes queued"`, primary CTA `"Review changes"`, secondary `"Keep writing"`
- Rail: cards rendered at 60% opacity with a `--queued` dotted left-rule instead of the active solid rule
- Status pill in titlebar: `"Solo · queued"` instead of `"Solo · active"`

```jsx
function CalmV5HeldQueued() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'var(--c1-canvas, oklch(0.945 0.012 70))',
      display: 'grid', gridTemplateRows: '44px auto 1fr',
      fontFamily: 'Inter Tight, sans-serif',
      color: 'oklch(0.22 0.012 280)',
    },
    titlebar: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 18px',
      borderBottom: '1px solid oklch(0.90 0.008 75)',
      fontSize: 13,
    },
    brand: { fontWeight: 600, letterSpacing: '-0.01em' },
    tab: {
      padding: '6px 12px', borderRadius: 6,
      background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.90 0.008 75)',
      fontSize: 12.5,
    },
    pill: {
      marginLeft: 'auto',
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 9px', borderRadius: 99,
      background: 'oklch(0.94 0.030 70)',
      color: 'oklch(0.42 0.14 65)',
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.04em',
    },
    pillDot: {
      width: 6, height: 6, borderRadius: '50%',
      background: 'oklch(0.62 0.16 65)',
      animation: 'calmv5pulse 1.6s ease-in-out infinite',
    },
    banner: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 24px',
      background: 'oklch(0.96 0.020 70)',
      borderBottom: '1px solid oklch(0.88 0.020 65)',
      fontSize: 13.5,
    },
    bannerText: { flex: 1, color: 'oklch(0.30 0.030 65)' },
    bannerCount: {
      fontFamily: 'JetBrains Mono, monospace',
      color: 'oklch(0.42 0.14 65)', fontWeight: 500,
    },
    btnPrimary: {
      padding: '7px 14px', borderRadius: 6,
      background: 'oklch(0.52 0.16 65)', color: 'white',
      border: 'none', fontSize: 13, cursor: 'pointer',
    },
    btnSecondary: {
      padding: '7px 14px', borderRadius: 6,
      background: 'transparent', color: 'oklch(0.40 0.04 65)',
      border: '1px solid oklch(0.80 0.020 65)', fontSize: 13, cursor: 'pointer',
    },
    body: { display: 'grid', gridTemplateColumns: '1fr 340px', minHeight: 0 },
    editor: { padding: '56px 80px', overflow: 'auto', opacity: 0.85 },
    para: {
      fontFamily: 'Source Serif 4, serif',
      fontSize: 17, lineHeight: 1.68,
      maxWidth: 640, color: 'oklch(0.25 0.012 280)',
      margin: '0 0 18px',
    },
    rail: {
      borderLeft: '1px solid oklch(0.90 0.008 75)',
      padding: '22px 18px',
      background: 'oklch(0.97 0.008 75)',
      overflow: 'auto',
    },
    railHead: {
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'oklch(0.55 0.008 280)', marginBottom: 12,
    },
    card: {
      padding: '12px 14px', marginBottom: 10,
      background: 'oklch(0.99 0.004 80)',
      borderRadius: 8,
      borderLeft: '2px dotted oklch(0.62 0.14 65)',
      opacity: 0.60,
      fontSize: 12.5, lineHeight: 1.5,
    },
    cardAuth: {
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10.5, letterSpacing: '0.06em',
      color: 'oklch(0.42 0.14 65)', textTransform: 'uppercase',
      marginBottom: 4,
    },
    keyframes: '@keyframes calmv5pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }',
  };
  return (
    <div style={css.root}>
      <style>{css.keyframes}</style>
      <div style={css.titlebar}>
        <span style={css.brand}>Tandem</span>
        <span style={css.tab}>brief.md</span>
        <span style={css.pill}><span style={css.pillDot} />Solo · queued</span>
      </div>
      <div style={css.banner}>
        <div style={css.bannerText}>
          Solo session ready to review · <span style={css.bannerCount}>3 changes queued</span>
        </div>
        <button style={css.btnSecondary}>Keep writing</button>
        <button style={css.btnPrimary}>Review changes</button>
      </div>
      <div style={css.body}>
        <div style={css.editor}>
          <p style={css.para}>The proposal needs a sharper opening — something that says <em>why now</em> before the team gets to the budget table. I drafted three openers in solo; they're queued for review.</p>
          <p style={css.para}>If you want to keep iterating before merging, hit <strong>Keep writing</strong>. Otherwise <strong>Review changes</strong> opens the rail in compare mode.</p>
        </div>
        <div style={css.rail}>
          <div style={css.railHead}>Queued · 3</div>
          <div style={css.card}>
            <div style={css.cardAuth}>You · solo</div>
            Added opening paragraph
          </div>
          <div style={css.card}>
            <div style={css.cardAuth}>You · solo</div>
            Re-ordered budget &amp; timeline sections
          </div>
          <div style={css.card}>
            <div style={css.cardAuth}>You · solo</div>
            Trimmed closing two sentences
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CalmV5CatLegend, CalmV5HeldQueued });
```

(Keep the existing `Object.assign(window, { CalmV5CatLegend })` line — replace it with the longer one above so all v5 components are exported.)

- [ ] **Step 3: Add the artboard to the B3 section in v5 HTML**

In `Tandem - Calm Synthesis v5.html`, locate the `DCSection id="b3-held"` block. Insert a new `DCArtboard` between `b3-active` and `b3-review`:

```jsx
<DCArtboard id="b3-queued" label="B3 State 2 · Solo queued — pending review (between active and merge)" width={1440} height={900}>
  <div className="frame"><CalmV5HeldQueued /></div>
</DCArtboard>
```

Also update the section title from `"B3 — heldInSolo: active state · Solo→Tandem review surface"` to `"B3 — heldInSolo: active · queued · Solo→Tandem review"`.

- [ ] **Step 4: Visual verification**

Open v5. Expected: B3 section shows three artboards in order (active → queued → review). The queued artboard reads as a calm intermediate state — banner offers two CTAs, rail cards are dotted and dimmed.

---

## Task 5: Add `CalmV5AnnoSummary` — C7 decision panel (Option A vs Option B)

**Files:**
- Modify: `calm-v5.jsx` (append component)
- Modify: `Tandem - Calm Synthesis v5.html` (add artboard in c-surfaces or a new specs section)

- [ ] **Step 1: Append component to `calm-v5.jsx`**

A spec-panel-style comparison: left half shows Option A (StatusBar pills — calm-v4's current chosen treatment), right half shows Option B (rail header). Below: a single recommendation strip.

```jsx
function CalmV5AnnoSummary() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'oklch(0.945 0.012 70)',
      padding: '32px 40px',
      fontFamily: 'Inter Tight, sans-serif',
      color: 'oklch(0.22 0.012 280)',
      overflow: 'auto',
    },
    head: { marginBottom: 22 },
    eyebrow: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'oklch(0.55 0.008 280)', marginBottom: 6,
    },
    h1: {
      fontFamily: 'Source Serif 4, serif',
      fontSize: 26, fontWeight: 500, margin: 0,
      letterSpacing: '-0.01em',
    },
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginBottom: 22 },
    panel: (chosen) => ({
      background: 'oklch(0.99 0.004 80)',
      border: chosen ? '1.5px solid oklch(0.62 0.14 65)' : '1px solid oklch(0.90 0.008 75)',
      borderRadius: 10,
      padding: '18px 20px',
      position: 'relative',
    }),
    chosenPill: {
      position: 'absolute', top: -10, right: 14,
      padding: '3px 9px', borderRadius: 99,
      background: 'oklch(0.62 0.14 65)', color: 'white',
      fontSize: 10.5, fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.06em', textTransform: 'uppercase',
    },
    panelLabel: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.06em', color: 'oklch(0.50 0.01 280)',
      marginBottom: 4,
    },
    panelTitle: { fontSize: 15, fontWeight: 600, marginBottom: 12 },
    mock: {
      background: 'oklch(0.97 0.008 75)',
      borderRadius: 6, padding: 12, marginBottom: 12,
      fontSize: 12, color: 'oklch(0.35 0.012 280)',
      border: '1px solid oklch(0.92 0.008 75)',
      minHeight: 100,
    },
    pillRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
    pillItem: (hue) => ({
      padding: '3px 9px', borderRadius: 99,
      background: `oklch(0.93 0.022 ${hue})`,
      color: `oklch(0.40 0.14 ${hue})`,
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
    }),
    railHeaderMock: {
      padding: '8px 12px', marginBottom: 8,
      background: 'oklch(0.94 0.018 245)',
      borderLeft: '3px solid oklch(0.55 0.14 245)',
      borderRadius: 6, fontSize: 12,
      color: 'oklch(0.38 0.10 245)',
    },
    railCardMock: {
      padding: '8px 10px', background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.92 0.008 75)', borderRadius: 6,
      fontSize: 11.5, color: 'oklch(0.40 0.012 280)',
      marginBottom: 5,
    },
    pros: { fontSize: 12.5, lineHeight: 1.55, color: 'oklch(0.30 0.012 280)' },
    rec: {
      background: 'oklch(0.96 0.020 65)',
      border: '1px solid oklch(0.86 0.020 65)',
      borderLeft: '3px solid oklch(0.62 0.14 65)',
      borderRadius: 8,
      padding: '14px 18px',
      fontSize: 13.5, lineHeight: 1.6,
      color: 'oklch(0.30 0.020 65)',
    },
    recLabel: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      color: 'oklch(0.42 0.14 65)', marginBottom: 4, display: 'block',
    },
  };
  return (
    <div style={css.root}>
      <div style={css.head}>
        <div style={css.eyebrow}>C7 · document annotation summary</div>
        <h1 style={css.h1}>Where does the document-level summary live?</h1>
      </div>
      <div style={css.grid}>
        <div style={css.panel(true)}>
          <span style={css.chosenPill}>Chosen</span>
          <div style={css.panelLabel}>Option A</div>
          <div style={css.panelTitle}>StatusBar pills (bottom of frame)</div>
          <div style={css.mock}>
            <div style={css.pillRow}>
              <span style={css.pillItem(245)}>3 comments</span>
              <span style={css.pillItem(150)}>1 suggestion</span>
              <span style={css.pillItem(25)}>1 question</span>
              <span style={css.pillItem(65)}>2 imported</span>
            </div>
          </div>
          <div style={css.pros}>
            Sits at the existing chrome edge · always visible regardless of rail state · density-friendly · matches the v4 statusbar idiom already used elsewhere.
          </div>
        </div>
        <div style={css.panel(false)}>
          <div style={css.panelLabel}>Option B</div>
          <div style={css.panelTitle}>Rail header (top of annotation rail)</div>
          <div style={css.mock}>
            <div style={css.railHeaderMock}>3 comments · 1 suggestion · 1 question · 2 imported</div>
            <div style={css.railCardMock}>Comment from Alex · 2h ago</div>
            <div style={css.railCardMock}>Suggestion from Claude · 4h ago</div>
          </div>
          <div style={css.pros}>
            Locally grouped with the rail it summarises · disappears when rail collapses · duplicates info that would otherwise sit in the status row.
          </div>
        </div>
      </div>
      <div style={css.rec}>
        <span style={css.recLabel}>Recommendation</span>
        Option A. The summary is always-on, density-friendly, and matches the StatusBar idiom v4 already uses for read-only state and connection. Option B disappears when the rail collapses — exactly when the user most wants a quick scan.
      </div>
    </div>
  );
}

Object.assign(window, { CalmV5CatLegend, CalmV5HeldQueued, CalmV5AnnoSummary });
```

- [ ] **Step 2: Add the artboard to v5 HTML**

In the `DCSection id="specs"` block (the one currently titled `"C6 / D4 — Thread collapsed · Toast system"`), insert a new artboard between `c6-thread` and `d4-toast`:

```jsx
<DCArtboard id="c7-anno-summary" label="C7 · Document annotation summary — Option A (status pills) vs Option B (rail header) · decision record" width={1100} height={500}>
  <div className="frame"><CalmV5AnnoSummary /></div>
</DCArtboard>
```

Update the section title to `"C6 / C7 / D4 — Thread · annotation summary · toast"`.

- [ ] **Step 3: Visual verification**

Open v5. Expected: a two-column comparison panel with "Chosen" badge on the left, a recommendation strip below, all in warm canvas + green/amber accents. No console errors.

---

## Task 6: Add `CalmV5NarrowSettings` — C5 settings <860px (hamburger-collapsed nav)

**Files:**
- Modify: `calm-v5.jsx` (append component)
- Modify: `Tandem - Calm Synthesis v5.html` (add artboard in a new section)

- [ ] **Step 1: Append component to `calm-v5.jsx`**

A faithful re-creation of v3's `C5NarrowSettingsFrame` in the calm aesthetic: 860×660 canvas, hamburger button at top-left, collapsed sidebar, single column of settings content.

```jsx
function CalmV5NarrowSettings() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'oklch(0.99 0.004 80)',
      display: 'grid', gridTemplateRows: '48px 1fr',
      fontFamily: 'Inter Tight, sans-serif',
      color: 'oklch(0.22 0.012 280)',
      overflow: 'hidden',
    },
    topbar: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 16px',
      borderBottom: '1px solid oklch(0.90 0.008 75)',
      background: 'oklch(0.97 0.008 75)',
    },
    hamburger: {
      display: 'inline-flex', flexDirection: 'column', gap: 4,
      padding: '8px 9px', borderRadius: 6,
      background: 'transparent',
      border: '1px solid oklch(0.88 0.008 75)',
      cursor: 'pointer',
    },
    hamLine: { width: 16, height: 1.5, background: 'oklch(0.35 0.012 280)' },
    title: { fontSize: 14, fontWeight: 600 },
    crumb: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.06em', color: 'oklch(0.55 0.008 280)',
      textTransform: 'uppercase',
    },
    body: { padding: '24px 22px', overflow: 'auto' },
    section: { marginBottom: 28 },
    sectHead: {
      fontFamily: 'Source Serif 4, serif',
      fontSize: 18, fontWeight: 500,
      margin: '0 0 14px',
      letterSpacing: '-0.01em',
    },
    row: {
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 16, padding: '12px 0',
      borderBottom: '1px solid oklch(0.93 0.008 75)',
    },
    rowLabel: { fontSize: 13.5, fontWeight: 500, marginBottom: 3 },
    rowHelp: { fontSize: 12, color: 'oklch(0.50 0.010 280)', lineHeight: 1.5 },
    toggle: (on) => ({
      flexShrink: 0,
      width: 36, height: 20, borderRadius: 99, position: 'relative',
      background: on ? 'oklch(0.52 0.16 65)' : 'oklch(0.86 0.008 75)',
      border: 'none', cursor: 'pointer',
    }),
    knob: (on) => ({
      position: 'absolute', top: 2, left: on ? 18 : 2,
      width: 16, height: 16, borderRadius: '50%',
      background: 'white',
      boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      transition: 'left 120ms ease',
    }),
    select: {
      flexShrink: 0,
      padding: '6px 28px 6px 12px', borderRadius: 6,
      background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.88 0.008 75)',
      fontSize: 12.5, fontFamily: 'Inter Tight, sans-serif',
      color: 'oklch(0.30 0.012 280)',
      appearance: 'none',
      backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M3 5l3 3 3-3' stroke='%23999' fill='none' stroke-width='1.4'/></svg>\")",
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'right 8px center',
    },
    note: {
      marginTop: 4, padding: '8px 12px',
      background: 'oklch(0.96 0.018 70)',
      borderLeft: '2px solid oklch(0.62 0.14 65)',
      borderRadius: 4,
      fontSize: 11.5, color: 'oklch(0.40 0.018 65)',
    },
  };
  return (
    <div style={css.root}>
      <div style={css.topbar}>
        <button style={css.hamburger} aria-label="Open menu">
          <span style={css.hamLine} /><span style={css.hamLine} /><span style={css.hamLine} />
        </button>
        <div>
          <div style={css.crumb}>Settings</div>
          <div style={css.title}>Editor &amp; appearance</div>
        </div>
      </div>
      <div style={css.body}>
        <div style={css.section}>
          <h2 style={css.sectHead}>Editor</h2>
          <div style={css.row}>
            <div>
              <div style={css.rowLabel}>Authorship tint</div>
              <div style={css.rowHelp}>Tint individual text runs by their author. Hover reveals author + timestamp chip.</div>
            </div>
            <button style={css.toggle(true)}><span style={css.knob(true)} /></button>
          </div>
          <div style={css.row}>
            <div>
              <div style={css.rowLabel}>Font</div>
              <div style={css.rowHelp}>Body face for the document canvas.</div>
            </div>
            <select style={css.select} defaultValue="serif">
              <option value="serif">Source Serif 4</option>
              <option value="sans">Inter Tight</option>
              <option value="mono">JetBrains Mono</option>
            </select>
          </div>
          <div style={css.row}>
            <div>
              <div style={css.rowLabel}>Density</div>
              <div style={css.rowHelp}>Tighter rhythms suit dense prose; spacious suits drafting.</div>
            </div>
            <select style={css.select} defaultValue="tight">
              <option value="tight">Tight</option>
              <option value="default">Default</option>
              <option value="spacious">Spacious</option>
            </select>
          </div>
        </div>
        <div style={css.section}>
          <h2 style={css.sectHead}>Appearance</h2>
          <div style={css.row}>
            <div>
              <div style={css.rowLabel}>Warmth</div>
              <div style={css.rowHelp}>Canvas tone. Affects all panels and rails.</div>
            </div>
            <select style={css.select} defaultValue="amber">
              <option value="amber">Amber</option>
              <option value="slate">Slate</option>
              <option value="dusk">Dusk</option>
            </select>
          </div>
          <div style={css.row}>
            <div>
              <div style={css.rowLabel}>Theme</div>
              <div style={css.rowHelp}>Match system or pin to light/dark.</div>
            </div>
            <select style={css.select} defaultValue="system">
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
          <div style={css.note}>
            At &lt;860px the sidebar collapses behind the hamburger. Tap to open it as an overlay.
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { CalmV5CatLegend, CalmV5HeldQueued, CalmV5AnnoSummary, CalmV5NarrowSettings });
```

- [ ] **Step 2: Add a new DCSection for responsive surfaces**

In `Tandem - Calm Synthesis v5.html`, insert a new section between the existing `system` section (C4/C3) and the `f5-chat` section:

```jsx
<DCSection id="responsive" title="C5 — Responsive: settings at &lt;860px">
  <DCArtboard id="c5-narrow-settings" label="C5 · Settings at &lt;860px — hamburger-collapsed nav · single-column content panel" width={860} height={660}>
    <div className="frame"><CalmV5NarrowSettings /></div>
  </DCArtboard>
</DCSection>
```

- [ ] **Step 3: Visual verification**

Open v5. Expected: an 860×660 artboard rendering a calm settings page with hamburger top-left, two sections (Editor / Appearance) with toggles + selects, a small "<860px" note callout.

---

## Task 7: Self-checklist (P0 / P1 / P2)

- [ ] **P0 — No console errors on v5**

Open `Tandem - Calm Synthesis v5.html` in the preview. Open devtools console. Expected: zero red errors. Babel warnings about source maps are acceptable.

- [ ] **P0 — All v4 artboards still render in v5**

Scroll the whole page. Every section that was in v4 should still be present in v5 with its artboards. (v5 is additive only.)

- [ ] **P0 — Three new components render**

Verify by visual scan:
- Category legend visible above the decision strip with six pills (A–F).
- B3 section has three artboards (active, queued, review) in that order.
- New C5 artboard renders at 860×660.
- New C7 artboard renders inside the specs row.

- [ ] **P0 — Hero copy is the new audit-trail version**

Hero h1 reads `"v3 catalogued the surfaces. v5 puts them in one calm language."` plus the longer paragraph and the file-pointer line.

- [ ] **P1 — Calm palette consistency**

The legend, queued banner, and decision panel all use warm-canvas-compatible OKLch values (lightness 0.93–0.97 for backgrounds, chroma ≤ 0.025). No bright saturated v3-style chips bleeding through.

- [ ] **P1 — Typography consistency**

All component titles use Source Serif 4 for display, Inter Tight for body, JetBrains Mono for eyebrows / pills / counts. No font reverting to a system fallback.

- [ ] **P1 — Accessibility light pass**

The hamburger has `aria-label="Open menu"`. The category legend has `aria-label="Category legend"`. Toggles have button roles. No critical AA contrast failures on the new components (visual eyeball, not formal audit).

- [ ] **P2 — File hygiene**

`calm-v5.jsx` ends with a single `Object.assign(window, { ... })` exporting all four components. No duplicate component definitions. No stray `console.log`.

---

## Task 8: 5-dimensional critique (silent, then fix weakest if any < 3)

Score each silently 1–5:

1. **Philosophy** — does v5 still feel like *one* calm document, not a v4 + appendix? (Risk: new panels look bolted-on.)
2. **Hierarchy** — does the eye still land first on the hero, then legend, then content? (Risk: legend competes with decision strip.)
3. **Execution** — are the new components pixel-clean — borders, alignment, type — at parity with calm-v4b's spec panels?
4. **Specificity** — is every label specific (e.g. "3 changes queued", "Claude · 4h ago") rather than generic ("Item 1 / Item 2")?
5. **Restraint** — single warm accent used at most twice per artboard? No competing flourishes?

If any dimension < 3/5: go back, fix the weakest panel, re-score. Two passes is normal.

---

## Task 9: Emit final artifact

- [ ] **Step 1: Confirm `Tandem - Calm Synthesis v5.html` is the canonical entry**

Open in preview, scroll top → bottom, confirm clean render.

- [ ] **Step 2: Emit `<artifact identifier="tandem-calm-v5" type="text/html" title="Tandem — Calm Synthesis v5">` wrapping the v5 HTML**

After `</artifact>`, stop. No trailing summary.

---

## Out of scope (explicitly NOT in this plan)

- Dark mode variants of the three new components — defer to a follow-up only if user asks.
- Reworking the existing decision-strip — the four cards stay as-is; the legend is additive.
- Re-litigating the C7 decision (Option A vs B) — we record v3's recommendation; we don't re-evaluate it.
- Building State 2 keyboard / interaction wiring — these are static artboards, not live prototypes.
- Mobile responsive behavior of the v5 entry page itself — the canvas only renders at desktop widths, same as v4.
- **Rail empty / onboarding state** (zero collaborators, first session) — surfaced as a gap by reviewers; missing from v3 AND v4. Defer to a follow-up audit; not in v5 scope.

---

## Reviewer fixes applied (2026-05-13)

Three reviewers (code, architecture, design) audited this plan before implementation. The following 8 changes are baked into v5 — the task bodies above are HISTORICAL; the implementation follows the revised order and details listed here.

### Code fixes

- **F1 (P0) — Fragment-wrap `CalmV5HeldQueued` return.** Original used `<div style={css.root}>` (a 3-row grid) with `<style>` as the first child — grid would see 4 children, only 3 tracks → body collapses. Fix: wrap return in `<>...</>` so `<style>` is a sibling of `<div style={css.root}>`, not a grid child.

- **F2 (P1) — Force `padding: 0` on the toggle pill** in `CalmV5NarrowSettings.css.toggle`. Browser-default `<button>` padding inflates the 20px pill height; explicit `padding: 0` keeps it crisp.

- **F3 (P2) — Task 4 Step 2 wording clarity.** The line "Keep the existing line — replace it." is ambiguous. Implementation replaces (does NOT duplicate) the `Object.assign(window, …)` export at the bottom of `calm-v5.jsx` each time a component is appended.

### Design fixes

- **F4 — Reorder tasks: C5 → C7 → B3 → legend → hero.** The original audit ordered restoration by importance (flow gaps first, document polish last). The plan inverted that. Reverted to original priority order: build the responsive-flow gap (C5), then the decision record gap (C7), then the state-machine gap (B3 State 2), then the taxonomy strip (legend), then the meta-narrative polish (hero).

- **F5 — Soften queued-banner CTA palette.** Replace `oklch(0.52 0.16 65)` (chroma 0.16, runs hot against calm vocabulary) with `oklch(0.58 0.10 60)`. Apply same softening to the `pillDot` (was `oklch(0.62 0.16 65)`) and the dotted left-rule on rail cards. Typography weight + 15px Inter Tight medium carries the affordance, not saturation.

- **F6 — B3 State 2 affordance gap.** Add a one-line flow annotation under the queued artboard explaining what triggers the queued state ("triggered by 30s inactivity OR manual pause via status pill"). Swap the pulsing dot for a static outline ring — pulse connotes real-time activity; queued connotes waiting. Use a 2px ring around a hollow center, not an animated fill.

- **F7 — C7 "Chosen" badge placement.** Move the badge from inside Option A's panel (looks like a live approval stamp) to ABOVE the two-panel grid as a document annotation (badge text "v3 recommendation · carried into v4"). Keep both option panels at equal visual weight (both 1px borders, both `oklch(0.90 0.008 75)`) so the recommendation strip BELOW carries the verdict, not the panel chrome.

- **F8 — C5 Save/Cancel row + scope footnote.** Without an action row the artboard silently implies auto-save. Add a sticky footer with `[Cancel]` `[Save]` buttons and a small footnote: "Destructive actions (account, logout) scoped to Account tab — not shown."

### Open decisions removed (precedent already decided)

- **D1 — v5 vs patch v4 in place** — REMOVED. v1, v2, v4 are all separate files; v5 follows the established precedent. Spinning a new file.
- **D3 — inline styles** — REMOVED. `calm-v4b.jsx` already establishes that each spec panel inlines its own style. v5 follows the same pattern.
- **D2 — C5 fidelity (860×660 vs scale)** — KEPT. Plan retains: faithful 860×660 restoration with calm palette swap.

### Scope notes

- Rail empty / onboarding state — gap noted by reviewers; deferred (see Out of scope).
- Reviewer concerns about porting v3 helper components were based on a misread of the plan (v5 authors NEW components in calm idiom; nothing is ported from v3). No action needed.
