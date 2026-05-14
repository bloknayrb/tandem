/* v3-speculative.jsx — F: forward-looking artboards, clearly marked speculative */

// ── F1 + F2: Document Groups ─────────────────────────────────────────────────
function F1DocGroupsFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const faint = 'oklch(0.68 0.006 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const accent = 'oklch(0.52 0.16 275)';
  const accentSoft = 'oklch(0.95 0.03 275)';

  const groups = [
    {
      id: 'g1', name: 'Q2 Board Packet', count: 4, modified: '2m ago',
      docs: [
        { name: 'q2-progress-review.md', ext: 'M', dirty: true },
        { name: 'q2-board-memo.docx',    ext: 'W' },
        { name: 'q2-okrs.md',            ext: 'M' },
        { name: 'q2-appendix.docx',      ext: 'W' },
      ],
    },
    {
      id: 'g2', name: 'RFC-007 Read Layer', count: 3, modified: '1h ago',
      docs: [
        { name: 'rfc-007-readlayer.md',  ext: 'M', dirty: true },
        { name: 'adr-029.md',            ext: 'M' },
        { name: 'read-layer-spike.md',   ext: 'M' },
      ],
    },
  ];

  function DocRow({ name, ext, dirty }) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 6px 28px', cursor: 'pointer', borderRadius: 4, transition: 'background 100ms' }}
        onMouseEnter={e => e.currentTarget.style.background = 'oklch(0.975 0.005 80)'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, padding: '1px 4px', background: ext === 'W' ? 'oklch(0.94 0.04 245)' : 'oklch(0.96 0.005 80)', color: ext === 'W' ? 'oklch(0.42 0.16 245)' : muted, border: `1px solid ${hair}`, borderRadius: 3 }}>{ext}</span>
        <span style={{ flex: 1, fontSize: 12.5, color: ink }}>{name}</span>
        {dirty && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'oklch(0.62 0.16 65)', flexShrink: 0 }} />}
        <button style={{ opacity: 0, width: 16, height: 16, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: muted, padding: 0, fontSize: 13 }}>×</button>
      </div>
    );
  }

  function GroupRow({ group, expanded = false }) {
    const [open, setOpen] = React.useState(expanded);
    return (
      <div style={{ borderBottom: `1px solid ${hair}` }}>
        <div
          onClick={() => setOpen(!open)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: open ? accentSoft : 'transparent', transition: 'background 120ms' }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke={open ? accent : muted} strokeWidth="1.6" strokeLinecap="round" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }}>
            <path d="M4 2l4 4-4 4"/>
          </svg>
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke={open ? accent : muted} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 3h5l1.5 2H13v7H1z"/>
          </svg>
          <span style={{ flex: 1, fontWeight: 600, fontSize: 13, color: open ? accent : ink }}>{group.name}</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: faint }}>{group.count} docs · {group.modified}</span>
          <button style={{ width: 20, height: 20, border: 'none', background: 'transparent', cursor: 'pointer', color: faint, fontSize: 14, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Group options">···</button>
        </div>
        {open && (
          <div style={{ paddingBottom: 4 }}>
            {group.docs.map(d => <DocRow key={d.name} {...d} />)}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px 5px 28px', color: faint, fontSize: 12, cursor: 'pointer' }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
              Add document to group
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
      '--rail-w': '280px',
    }}>
      <TopToolbar docName="rfc-007-readlayer.md" dirty={true} panelLayout="left" theme={theme} mode="tandem" claudeState="reading" />
      <DocTabs docs={[
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },
        { id: 'd2', name: 'q2-board-memo.docx', ext: 'W' },
      ]} active="d1" />
      <FormattingBar leftVisible={true} rightVisible={false} />

      <div className="main" data-rail="left">
        {/* Left rail — Document Groups mode */}
        <div className="rail" style={{ order: -1, borderLeft: 'none', borderRight: '1px solid var(--hair)' }}>
          <div className="rail-tabs">
            <div className="rail-tab active" style={{ gap: 5 }}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h5l1.5 2H13v7H1z"/></svg>
              Groups
            </div>
            <div className="rail-tab" style={{ gap: 5 }}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="5" r="2"/><path d="M1 12a6 6 0 0 1 12 0"/></svg>
              Annotations
            </div>
            <div className="rail-spacer" />
            <button className="rail-flip-btn" title="New group">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
            </button>
          </div>

          {/* Group list */}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {/* All files section */}
            <div style={{ padding: '8px 12px 4px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: faint }}>Groups</div>
            {groups.map((g, i) => <GroupRow key={g.id} group={g} expanded={i === 0} />)}
            <div style={{ borderBottom: `1px solid ${hair}`, padding: '8px 12px 4px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: faint, marginTop: 8 }}>Ungrouped (3)</div>
            {['partner-update.docx', 'scratch-notes.md', 'meeting-may12.md'].map(name => (
              <DocRow key={name} name={name} ext={name.endsWith('.docx') ? 'W' : 'M'} />
            ))}
          </div>
        </div>

        <EditorBody showMini={false} showCursor={true} />
      </div>
      <StatusBar claudeState="reading" docName="rfc-007-readlayer.md" dirty={true} />

      {/* Speculative badge */}
      <div style={{ position: 'fixed', top: 8, right: 8, background: 'oklch(0.62 0.16 65)', color: 'white', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', padding: '3px 9px', borderRadius: 4, zIndex: 999, pointerEvents: 'none' }}>
        F1 · SPECULATIVE · confidence: medium
      </div>
    </div>
  );
}

// ── F3: Drag-to-add to group ──────────────────────────────────────────────────
function F3DocGroupsDragSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const accent = 'oklch(0.52 0.16 275)';
  const accentSoft = 'oklch(0.95 0.03 275)';

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.62 0.16 65)', marginBottom: 4 }}>F3 · speculative · confidence: medium — drag-to-add</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Adding a document to a group by drag</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {[
          { label: '① Drag starts', desc: 'User begins dragging "scratch-notes.md" tab or file row. A ghost/clone follows the cursor.', dropTarget: false, dragging: true, over: false },
          { label: '② Over group target', desc: 'Dragged file hovers over "RFC-007 Read Layer" group row. Group highlights with accent border + drop shadow.', dropTarget: true, dragging: true, over: true },
          { label: '③ Dropped', desc: 'File added to group. Group row briefly pulses (scale 1 → 1.01 → 1). File appears as last item in expanded group.', dropTarget: false, dragging: false, over: false, dropped: true },
        ].map(s => (
          <div key={s.label} style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', borderBottom: `1px solid ${hair}`, fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: muted }}>{s.label}</div>
            <div style={{ padding: '12px' }}>
              {/* Simulated group panel */}
              <div style={{ border: `1.5px solid ${s.over ? accent : hair}`, borderRadius: 6, overflow: 'hidden', transition: 'border-color 120ms', boxShadow: s.over ? `0 0 0 3px ${accentSoft}` : 'none' }}>
                <div style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 7, background: s.over ? accentSoft : 'oklch(0.975 0.005 80)' }}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={s.over ? accent : muted} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h5l1.5 2H13v7H1z"/></svg>
                  <span style={{ fontSize: 12, fontWeight: 600, color: s.over ? accent : ink }}>RFC-007 Read Layer</span>
                  <span style={{ flex: 1 }} />
                  {s.over && <span style={{ fontSize: 10, color: accent, fontFamily: 'JetBrains Mono, monospace' }}>drop to add</span>}
                </div>
                <div style={{ padding: '4px 0' }}>
                  {['rfc-007-readlayer.md', 'adr-029.md', 'read-layer-spike.md'].map(n => (
                    <div key={n} style={{ padding: '4px 10px 4px 24px', fontSize: 11.5, color: muted }}>{n}</div>
                  ))}
                  {s.dropped && <div style={{ padding: '4px 10px 4px 24px', fontSize: 11.5, color: accent, fontWeight: 500, background: accentSoft }}>scratch-notes.md ✓ added</div>}
                </div>
              </div>

              {/* Dragging ghost */}
              {s.dragging && (
                <div style={{ marginTop: 12, padding: '6px 10px', background: 'white', border: `1px solid ${hair}`, borderRadius: 5, display: 'flex', alignItems: 'center', gap: 7, opacity: 0.85, boxShadow: '0 4px 16px rgba(20,20,30,0.15)', transform: 'rotate(-1.5deg)' }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, padding: '1px 4px', background: 'oklch(0.96 0.005 80)', border: `1px solid ${hair}`, borderRadius: 3, color: muted }}>MD</span>
                  <span style={{ fontSize: 12, color: ink }}>scratch-notes.md</span>
                </div>
              )}
            </div>
            <div style={{ padding: '8px 12px', borderTop: `1px solid ${hair}`, fontSize: 11, color: muted, lineHeight: 1.4 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── F4: Diff hunk staging interaction ────────────────────────────────────────
function F4DiffHunkFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  const [hunks, setHunks] = React.useState([
    { id: 'h1', accepted: true,  label: 'Hunk 1 · simplify onboarding → streamline first-run setup' },
    { id: 'h2', accepted: null,  label: 'Hunk 2 · slipped due to → extended in scope when' },
    { id: 'h3', accepted: false, label: 'Hunk 3 · insert RFC-007 reference link' },
  ]);
  const accepted = hunks.filter(h => h.accepted === true).length;
  const total = hunks.length;

  return (
    <div data-theme={theme} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--ink)', fontFamily: 'Inter Tight, sans-serif', '--accent': tw.accent }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--hair)', background: 'var(--surface-muted)', flexShrink: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Apply Claude's edit</div>
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--ink-muted)', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', padding: '1px 6px', borderRadius: 3 }}>{accepted}/{total} accepted</span>
        {/* Focus-trap indicator — keyboard is captured by the diff surface, not the editor */}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 10,
          padding: '2px 7px', borderRadius: 99,
          background: 'color-mix(in oklch, var(--accent, oklch(0.52 0.16 275)) 12%, transparent)',
          color: 'var(--accent, oklch(0.52 0.16 275))',
          border: '1px solid color-mix(in oklch, var(--accent, oklch(0.52 0.16 275)) 30%, transparent)',
        }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
          Keyboard captured · Esc to release
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--ink-muted)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span><kbd style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, padding: '1px 5px', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', borderRadius: 3 }}>↑↓</kbd> / <kbd style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, padding: '1px 5px', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', borderRadius: 3 }}>J K</kbd> navigate</span>
          <span><kbd style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, padding: '1px 5px', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', borderRadius: 3 }}>↵</kbd> accept</span>
          <span><kbd style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, padding: '1px 5px', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', borderRadius: 3 }}>⌫</kbd> reject</span>
          <span><kbd style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, padding: '1px 5px', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', borderRadius: 3 }}>⌘↵</kbd> apply</span>
        </span>
      </div>

      {/* Speculative badge — with mapping rationale */}
      <div style={{ background: 'oklch(0.96 0.04 75)', borderBottom: '1px solid oklch(0.84 0.08 65)', padding: '6px 16px', fontSize: 11.5, color: 'oklch(0.40 0.14 65)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M7 2L1.5 12h11L7 2z"/><path d="M7 6v3"/><circle cx="7" cy="11" r="0.4" fill="currentColor"/></svg>
        <strong>F4 — Speculative (confidence: medium)</strong>
        <span style={{ color: 'oklch(0.45 0.12 65)' }}>
          · No letter-key bindings (Y / N / A / R) — the diff surface lives right next to the editor and reflexive typing could mutate the staged set. <strong>Enter</strong> / <strong>⌫</strong> are non-destination keys; the focus-trap pill makes the capture state visible.
        </span>
      </div>

      {/* Hunk list */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {hunks.map((h, i) => (
          <div key={h.id} style={{
            background: 'var(--surface)',
            border: `1px solid ${h.accepted === true ? 'oklch(0.78 0.10 150)' : h.accepted === false ? 'oklch(0.80 0.08 25)' : 'var(--hair)'}`,
            borderLeft: `4px solid ${h.accepted === true ? 'oklch(0.55 0.14 150)' : h.accepted === false ? 'oklch(0.55 0.18 25)' : 'var(--hair-strong)'}`,
            borderRadius: 6, overflow: 'hidden',
          }}>
            {/* Hunk header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: h.accepted === null ? 'var(--surface-muted)' : 'transparent', borderBottom: '1px solid var(--hair)' }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: 'var(--ink-muted)', background: 'var(--surface-sunk)', border: '1px solid var(--hair)', padding: '1px 5px', borderRadius: 3 }}>Hunk {i+1}</span>
              <span style={{ fontSize: 12.5, color: 'var(--ink-muted)', flex: 1 }}>{h.label}</span>
              {/* Keyboard shortcut hints (focus-trapped) */}
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: 'var(--ink-faint)' }}>
                {h.accepted === null ? '[↵] accept  [⌫] reject' : h.accepted ? '✓ accepted  [⌫] change' : '✗ rejected  [↵] change'}
              </span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button
                  onClick={() => setHunks(prev => prev.map(hk => hk.id === h.id ? { ...hk, accepted: true } : hk))}
                  style={{ height: 24, padding: '0 10px', border: '1px solid oklch(0.82 0.08 150)', background: h.accepted === true ? 'oklch(0.55 0.14 150)' : 'transparent', color: h.accepted === true ? 'white' : 'oklch(0.48 0.14 150)', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', fontWeight: h.accepted === true ? 600 : 400 }}>Accept</button>
                <button
                  onClick={() => setHunks(prev => prev.map(hk => hk.id === h.id ? { ...hk, accepted: false } : hk))}
                  style={{ height: 24, padding: '0 10px', border: '1px solid oklch(0.82 0.08 25)', background: h.accepted === false ? 'oklch(0.55 0.18 25)' : 'transparent', color: h.accepted === false ? 'white' : 'oklch(0.48 0.16 25)', borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', fontWeight: h.accepted === false ? 600 : 400 }}>Reject</button>
              </div>
            </div>
            {/* Diff lines */}
            <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ background: 'var(--error-soft)', color: 'var(--error)', padding: '3px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13, textDecoration: 'line-through', opacity: h.accepted === false ? 0.4 : 1 }}>− {h.label.split('→')[0].replace('Hunk 1 · ','').replace('Hunk 2 · ','').replace('Hunk 3 · ','')}</div>
              <div style={{ background: 'var(--success-soft)', color: 'var(--success)', padding: '3px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13, opacity: h.accepted === false ? 0.4 : 1 }}>+ {(h.label.split('→')[1] || 'insert RFC-007 reference link').trim()}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--hair)', background: 'var(--surface-muted)', flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="oklch(0.62 0.16 65)" strokeWidth="1.5" strokeLinecap="round"><path d="M7 2L1.5 12h11L7 2z"/><path d="M7 6v3"/><circle cx="7" cy="11.5" r="0.4" fill="oklch(0.62 0.16 65)"/></svg>
        <span style={{ fontSize: 11.5, color: 'var(--ink-muted)', flex: 1 }}>
          Apply creates a <strong style={{ color: 'var(--ink)' }}>single undo step</strong> — individual hunks cannot be un-applied separately.
        </span>
        <button className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
        <button className="btn-ghost" style={{ fontSize: 12 }}>Apply accepted ({accepted})</button>
        <button style={{ height: 28, padding: '0 16px', background: 'var(--ink)', color: 'var(--bg)', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Apply all ({total})</button>
      </div>
    </div>
  );
}

// ── F5: Chat empty state ──────────────────────────────────────────────────────
function F5ChatEmptyFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  const suggestions = [
    "Summarize what we\u2019ve written so far",
    "What\u2019s the strongest argument in this draft?",
    "Suggest a better opening paragraph",
    "Flag any claims that need a citation",
  ];
  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
      '--rail-w': '380px',
    }}>
      <TopToolbar docName="rfc-007-readlayer.md" dirty={true} panelLayout="right" theme={theme} mode="tandem" claudeState="idle" />
      <DocTabs docs={[{ id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true }]} active="d1" />
      <FormattingBar leftVisible={false} rightVisible={true} />
      <div className="main" data-rail="right">
        <EditorBody showMini={false} showCursor={false} />

        {/* Chat rail — empty state */}
        <div className="rail">
          <div className="rail-tabs">
            <div className="rail-tab">Annotations <span className="count">4</span></div>
            <div className="rail-tab active">Chat</div>
            <div className="rail-tab">Outline</div>
            <div className="rail-spacer" />
          </div>

          {/* Empty state body */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px 20px', gap: 20 }}>
            {/* Claude avatar */}
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--author-claude-soft)', border: '1.5px solid var(--author-claude)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97757" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a10 10 0 1 0 10 10"/><path d="M16 8l-4 4-2-2"/>
              </svg>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--ink)', marginBottom: 6 }}>Claude is ready</div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-muted)', lineHeight: 1.5, maxWidth: 280 }}>
                Ask a question, request a revision, or select text in the editor to anchor a comment.
              </div>
            </div>

            {/* Suggestion chips */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
              <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginBottom: 2, textAlign: 'center' }}>Try asking</div>
              {suggestions.map(s => (
                <button key={s} style={{
                  padding: '8px 12px', border: '1px solid var(--hair)',
                  background: 'var(--surface)', borderRadius: 6,
                  fontFamily: 'inherit', fontSize: 12.5,
                  color: 'var(--ink-muted)', textAlign: 'left', cursor: 'pointer',
                  transition: 'background 100ms, border-color 100ms',
                }}
                  onMouseEnter={e => { e.currentTarget.style.background='var(--surface-sunk)'; e.currentTarget.style.borderColor='var(--hair-strong)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background='var(--surface)'; e.currentTarget.style.borderColor='var(--hair)'; }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Input */}
          <div className="chat-input">
            <textarea className="chat-input" style={{ flex: 1, border: '1px solid var(--hair)', background: 'var(--surface)', borderRadius: 6, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--ink)', resize: 'none', minHeight: 36, maxHeight: 120, outline: 'none' }} placeholder="Ask Claude about this document…" rows={1} />
            <button style={{ height: 32, width: 32, border: 'none', background: 'var(--accent)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 1L1 7l6 1 1 6z"/></svg>
            </button>
          </div>
        </div>
      </div>
      <StatusBar claudeState="idle" docName="rfc-007-readlayer.md" dirty={true} />

      <div style={{ position: 'fixed', top: 8, right: 8, background: 'oklch(0.62 0.16 65)', color: 'white', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', padding: '3px 9px', borderRadius: 4, zIndex: 999, pointerEvents: 'none' }}>
        F5 · SPECULATIVE · confidence: high
      </div>
    </div>
  );
}

// ── F6: Outline panel — heading-level annotation creation ────────────────────
function F6OutlineHeadingAnnoSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const accent = 'oklch(0.52 0.16 275)';
  const accentSoft = 'oklch(0.95 0.03 275)';

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.62 0.16 65)', marginBottom: 4 }}>F6 · speculative · confidence: low — outline section annotation</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Section-level annotation from outline panel</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>When filtering to a heading in the outline, a "Note on this section" affordance could create a heading-anchored annotation. This is speculative and should only be designed if demand is confirmed.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
        {/* Mock outline panel */}
        <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${hair}`, fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>Outline panel</div>
          {[
            { lvl: 1, text: 'RFC-007 — Read Layer Design', count: 0 },
            { lvl: 2, text: 'Proposed architecture', count: 2, active: true },
            { lvl: 3, text: 'Write path', count: 0 },
            { lvl: 3, text: 'Read path', count: 1 },
            { lvl: 2, text: 'Trade-offs', count: 1 },
            { lvl: 2, text: 'Timeline', count: 0 },
          ].map(item => (
            <div key={item.text} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: `6px 12px 6px ${item.lvl === 1 ? 12 : item.lvl === 2 ? 24 : 40}px`,
              background: item.active ? accentSoft : 'transparent',
              borderBottom: `1px solid ${hair}`,
              position: 'relative',
            }}>
              <span style={{ flex: 1, fontSize: item.lvl === 1 ? 13 : 12, fontWeight: item.lvl <= 2 ? 500 : 400, color: item.active ? accent : item.lvl === 1 ? ink : muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text}</span>
              {item.count > 0 && <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, background: item.active ? accent : 'var(--surface-sunk)', color: item.active ? 'white' : muted, border: `1px solid ${item.active ? accent : hair}`, padding: '0 5px', borderRadius: 99, minWidth: 18, textAlign: 'center' }}>{item.count}</span>}
              {/* "Add note" affordance — only visible on active/hovered item */}
              {item.active && (
                <button style={{ height: 20, padding: '0 7px', border: `1px solid ${accent}`, background: 'transparent', borderRadius: 3, fontSize: 10, color: accent, cursor: 'pointer', fontFamily: 'Inter Tight, sans-serif', whiteSpace: 'nowrap', flexShrink: 0 }}>
                  + Note
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Spec notes */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {[
            ['Anchor type', 'Section-level annotation anchors to the heading node, not a text range. Range: from heading start to next heading of same/higher level.'],
            ['Coordinate system', 'Must use flat-offset coordinates (extractText() positions), not ProseMirror heading positions. Heading node offset is computable from document structure.'],
            ['UI trigger', '"+ Note" button appears on hover or active (selected) outline item. Creates a note (private) only — not a comment. Comment requires text selection.'],
            ['Confidence: low', 'Section-level anchors require new coordinate logic server-side. No user demand confirmed yet. Tag with "speculative" in handoff. Do not block v0.12.0 on this.'],
          ].map(([title, body]) => (
            <div key={title} style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, color: ink, marginBottom: 5 }}>{title}</div>
              <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>{body}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  F1DocGroupsFrame,
  F3DocGroupsDragSpec,
  F4DiffHunkFrame,
  F5ChatEmptyFrame,
  F6OutlineHeadingAnnoSpec,
});
