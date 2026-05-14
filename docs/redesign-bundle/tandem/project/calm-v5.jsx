// calm-v5.jsx — components introduced in v5 to restore v3 surfaces missing from v4.
// Components: CalmV5NarrowSettings (C5), CalmV5AnnoSummary (C7), CalmV5HeldQueued (B3 State 2), CalmV5CatLegend.
// Build order in plan reflects priority: flow gaps first (C5, C7, B3), taxonomy + meta last.

// ─── C5: Narrow settings (<860px) — hamburger-collapsed nav ─────────────────

function CalmV5NarrowSettings() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'oklch(0.99 0.004 80)',
      display: 'grid', gridTemplateRows: '48px 1fr 56px',
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
    // F2 (P1): explicit padding:0 — prevents browser-default button padding from inflating the 20px pill.
    toggle: (on) => ({
      flexShrink: 0,
      width: 36, height: 20, borderRadius: 99, position: 'relative',
      background: on ? 'oklch(0.58 0.10 60)' : 'oklch(0.86 0.008 75)',
      border: 'none', cursor: 'pointer', padding: 0,
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
      borderLeft: '2px solid oklch(0.58 0.10 60)',
      borderRadius: 4,
      fontSize: 11.5, color: 'oklch(0.40 0.018 65)',
    },
    // F8: Save/Cancel row + scope footnote — implies explicit save, not auto-save.
    footer: {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '0 18px',
      borderTop: '1px solid oklch(0.90 0.008 75)',
      background: 'oklch(0.97 0.008 75)',
    },
    footnote: {
      flex: 1, fontSize: 10.5,
      fontFamily: 'JetBrains Mono, monospace',
      color: 'oklch(0.55 0.008 280)',
      letterSpacing: '0.02em',
    },
    btnCancel: {
      padding: '7px 14px', borderRadius: 6,
      background: 'transparent', color: 'oklch(0.40 0.012 280)',
      border: '1px solid oklch(0.85 0.008 75)',
      fontSize: 12.5, cursor: 'pointer',
      fontFamily: 'Inter Tight, sans-serif',
    },
    btnSave: {
      padding: '7px 14px', borderRadius: 6,
      background: 'oklch(0.58 0.10 60)', color: 'white',
      border: 'none', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
      fontFamily: 'Inter Tight, sans-serif',
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
            <button style={css.toggle(true)} aria-label="Toggle authorship tint" aria-pressed="true"><span style={css.knob(true)} /></button>
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
      <div style={css.footer}>
        <div style={css.footnote}>Destructive actions (account, logout) scoped to Account tab — not shown</div>
        <button style={css.btnCancel}>Cancel</button>
        <button style={css.btnSave}>Save</button>
      </div>
    </div>
  );
}

// ─── C7: Document annotation summary — Option A vs Option B decision record ─

function CalmV5AnnoSummary() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'oklch(0.945 0.012 70)',
      padding: '28px 36px 32px',
      fontFamily: 'Inter Tight, sans-serif',
      color: 'oklch(0.22 0.012 280)',
      overflow: 'auto',
    },
    head: { marginBottom: 18 },
    eyebrow: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'oklch(0.55 0.008 280)', marginBottom: 6,
    },
    h1: {
      fontFamily: 'Source Serif 4, serif',
      fontSize: 24, fontWeight: 500, margin: 0,
      letterSpacing: '-0.01em',
    },
    // F7: "Chosen" badge above the grid, framed as a doc annotation — not a live approval stamp inside Option A.
    chosenAnnotation: {
      display: 'inline-flex', alignItems: 'center', gap: 8,
      marginTop: 12, marginBottom: 4,
      padding: '5px 11px', borderRadius: 99,
      background: 'oklch(0.96 0.020 65)',
      border: '1px solid oklch(0.86 0.020 65)',
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.05em', textTransform: 'uppercase',
      color: 'oklch(0.40 0.10 60)',
    },
    chosenDot: {
      width: 6, height: 6, borderRadius: '50%',
      background: 'oklch(0.58 0.10 60)',
    },
    grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginBottom: 18 },
    // F7: Equal weight on both option panels — let the recommendation strip below carry the verdict.
    panel: {
      background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.90 0.008 75)',
      borderRadius: 10,
      padding: '16px 18px',
      position: 'relative',
    },
    panelLabel: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.06em', color: 'oklch(0.50 0.01 280)',
      marginBottom: 4,
    },
    panelTitle: { fontSize: 14.5, fontWeight: 600, marginBottom: 10 },
    mock: {
      background: 'oklch(0.97 0.008 75)',
      borderRadius: 6, padding: 11, marginBottom: 11,
      fontSize: 12, color: 'oklch(0.35 0.012 280)',
      border: '1px solid oklch(0.92 0.008 75)',
      minHeight: 86,
    },
    pillRow: { display: 'flex', gap: 7, flexWrap: 'wrap' },
    pillItem: (hue) => ({
      padding: '3px 9px', borderRadius: 99,
      background: `oklch(0.93 0.022 ${hue})`,
      color: `oklch(0.40 0.14 ${hue})`,
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
    }),
    railHeaderMock: {
      padding: '7px 11px', marginBottom: 7,
      background: 'oklch(0.94 0.018 245)',
      borderLeft: '3px solid oklch(0.55 0.14 245)',
      borderRadius: 6, fontSize: 11.5,
      color: 'oklch(0.38 0.10 245)',
    },
    railCardMock: {
      padding: '7px 10px', background: 'oklch(0.99 0.004 80)',
      border: '1px solid oklch(0.92 0.008 75)', borderRadius: 6,
      fontSize: 11, color: 'oklch(0.40 0.012 280)',
      marginBottom: 5,
    },
    pros: { fontSize: 12.5, lineHeight: 1.55, color: 'oklch(0.30 0.012 280)' },
    rec: {
      background: 'oklch(0.96 0.020 65)',
      border: '1px solid oklch(0.86 0.020 65)',
      borderLeft: '3px solid oklch(0.58 0.10 60)',
      borderRadius: 8,
      padding: '13px 18px',
      fontSize: 13, lineHeight: 1.6,
      color: 'oklch(0.30 0.020 65)',
    },
    recLabel: {
      fontFamily: 'JetBrains Mono, monospace', fontSize: 11,
      letterSpacing: '0.06em', textTransform: 'uppercase',
      color: 'oklch(0.40 0.10 60)', marginBottom: 4, display: 'block',
    },
  };
  return (
    <div style={css.root}>
      <div style={css.head}>
        <div style={css.eyebrow}>C7 · document annotation summary</div>
        <h1 style={css.h1}>Where does the document-level summary live?</h1>
        <span style={css.chosenAnnotation}>
          <span style={css.chosenDot} />
          v3 recommendation · carried into v4
        </span>
      </div>
      <div style={css.grid}>
        <div style={css.panel}>
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
            Sits at the existing chrome edge · always visible regardless of rail state · density-friendly · matches the v4 statusbar idiom already used for read-only state and connection.
          </div>
        </div>
        <div style={css.panel}>
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
        <span style={css.recLabel}>Recommendation — Option A</span>
        Always-on, density-friendly, and matches the StatusBar idiom v4 already uses for read-only and connection state. Option B disappears when the rail collapses — exactly when the user most wants a quick scan.
      </div>
    </div>
  );
}

// ─── B3 State 2: Solo queued — pending review ───────────────────────────────

function CalmV5HeldQueued() {
  const css = {
    root: {
      position: 'absolute', inset: 0,
      background: 'var(--c1-canvas, oklch(0.945 0.012 70))',
      display: 'grid', gridTemplateRows: '44px auto 1fr auto',
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
      background: 'oklch(0.96 0.018 70)',
      color: 'oklch(0.42 0.10 60)',
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      letterSpacing: '0.04em',
    },
    // F6: static outline ring (queued = waiting), not pulsing fill (active).
    pillRing: {
      width: 7, height: 7, borderRadius: '50%',
      background: 'transparent',
      border: '1.5px solid oklch(0.58 0.10 60)',
    },
    // F5: softened amber palette (chroma 0.10, not 0.16). Type weight + 15px medium carry the affordance.
    banner: {
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 24px',
      background: 'oklch(0.96 0.018 70)',
      borderBottom: '1px solid oklch(0.88 0.018 65)',
      fontSize: 13.5,
    },
    bannerText: { flex: 1, color: 'oklch(0.30 0.020 65)' },
    bannerCount: {
      fontFamily: 'JetBrains Mono, monospace',
      color: 'oklch(0.42 0.10 60)', fontWeight: 500,
    },
    btnPrimary: {
      padding: '8px 14px', borderRadius: 6,
      background: 'oklch(0.58 0.10 60)', color: 'white',
      border: 'none',
      fontSize: 13, fontWeight: 500, cursor: 'pointer',
      fontFamily: 'Inter Tight, sans-serif',
    },
    btnSecondary: {
      padding: '8px 14px', borderRadius: 6,
      background: 'transparent', color: 'oklch(0.38 0.020 60)',
      border: '1px solid oklch(0.80 0.018 65)',
      fontSize: 13, cursor: 'pointer',
      fontFamily: 'Inter Tight, sans-serif',
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
      borderLeft: '2px dotted oklch(0.58 0.10 60)',
      opacity: 0.60,
      fontSize: 12.5, lineHeight: 1.5,
    },
    cardAuth: {
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 10.5, letterSpacing: '0.06em',
      color: 'oklch(0.42 0.10 60)', textTransform: 'uppercase',
      marginBottom: 4,
    },
    // F6: flow annotation under the artboard — explains how user reaches queued state.
    flowNote: {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 18px',
      borderTop: '1px solid oklch(0.90 0.008 75)',
      background: 'oklch(0.97 0.008 75)',
      fontSize: 11, fontFamily: 'JetBrains Mono, monospace',
      color: 'oklch(0.50 0.010 280)',
      letterSpacing: '0.03em',
    },
    flowDot: {
      width: 5, height: 5, borderRadius: '50%',
      background: 'oklch(0.58 0.10 60)',
    },
  };
  // F1 (P0): fragment-wrap so <div style={css.root}> remains a 3-row grid with exactly its grid children. <style> is a sibling, not a grid child.
  return (
    <React.Fragment>
      <div style={css.root}>
        <div style={css.titlebar}>
          <span style={css.brand}>Tandem</span>
          <span style={css.tab}>brief.md</span>
          <span style={css.pill}><span style={css.pillRing} />Solo · queued</span>
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
        <div style={css.flowNote}>
          <span style={css.flowDot} />
          <span>Trigger: 30s inactivity in solo · OR · manual pause via status pill</span>
        </div>
      </div>
    </React.Fragment>
  );
}

// ─── Category legend — six A–F pills above the decision strip ───────────────

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

Object.assign(window, { CalmV5NarrowSettings, CalmV5AnnoSummary, CalmV5HeldQueued, CalmV5CatLegend });
