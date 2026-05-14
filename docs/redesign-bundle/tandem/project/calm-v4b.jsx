/* calm-v4b.jsx — remaining v3 surfaces with calm treatment
   B5 · D1 · D2 · D3 · D5 · E1 · F1 · F3 · F4 · F6
   Depends on: calm-v1.jsx + calm-v2.jsx + calm-v4.jsx (loaded first)
*/

// ─── B5: Diff view irreversibility ──────────────────────────────────────────

function CalmV4DiffIrrev() {
  const diffBlock = () => (
    <div style={{ padding: '10px 12px', borderBottom: '1px solid oklch(0 0 0 / 0.07)' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--c1-ink-faint)', marginBottom: 6 }}>Hunk 2 of 3 · Suggestion · Claude · 4m</div>
      <div style={{ background: 'oklch(0.97 0.020 25)', color: 'oklch(0.48 0.16 25)', padding: '4px 8px', borderRadius: 3, fontFamily: 'var(--font-serif)', fontSize: 13, textDecoration: 'line-through', marginBottom: 4 }}>slipped due to an unexpected API redesign</div>
      <div style={{ background: 'oklch(0.97 0.020 150)', color: 'oklch(0.45 0.14 150)', padding: '4px 8px', borderRadius: 3, fontFamily: 'var(--font-serif)', fontSize: 13 }}>extended in scope when an unplanned API redesign landed</div>
    </div>
  );
  const applyBtn = () => (
    <button style={{ height: 26, padding: '0 14px', background: 'var(--c1-ink)', color: 'oklch(0.98 0.003 80)', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Apply 2 of 3</button>
  );
  const cancelBtn = () => (
    <button style={{ height: 26, padding: '0 10px', border: '1px solid oklch(0 0 0 / 0.10)', background: 'transparent', borderRadius: 5, fontSize: 12, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
  );
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--warning)' }}>B5 — diff view irreversibility</div>
        <h2>Communicating the undo boundary</h2>
        <p className="lead">Apply is the undo boundary — hunks land as one editor op. Two options for surfacing this before the user confirms.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div className="c4-sc-lbl">Option A — warning in bottom bar (recommended)</div>
          <div className="c4-sc">
            {diffBlock()}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--c1-canvas-soft)' }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--warning)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2L1.5 14h13L8 2z" /><path d="M8 7v3" /><circle cx="8" cy="12.5" r=".5" fill="var(--warning)" /></svg>
              <span style={{ fontSize: 11.5, color: 'var(--c1-ink-muted)', flex: 1 }}>Apply creates a <strong style={{ color: 'var(--c1-ink)' }}>single undo step</strong> — hunks cannot be un-applied separately.</span>
              {cancelBtn()}{applyBtn()}
            </div>
            <div className="c4-sc-foot">Inline, no modal friction. User sees the boundary before clicking. Recommended.</div>
          </div>
        </div>
        <div>
          <div className="c4-sc-lbl">Option B — dashed staging border (secondary)</div>
          <div className="c4-sc" style={{ outline: '2px dashed oklch(0.80 0.10 65)', outlineOffset: -2 }}>
            <div style={{ padding: '6px 10px', background: 'oklch(0.96 0.04 75)', borderBottom: '1px solid oklch(0.88 0.08 65)', fontSize: 11.5, color: 'oklch(0.40 0.14 65)' }}>Staging area · changes are not applied</div>
            {diffBlock()}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 12px', background: 'var(--c1-canvas-soft)' }}>
              {cancelBtn()}{applyBtn()}
            </div>
            <div className="c4-sc-foot">Dashed border frames the whole surface. More visual noise for a constraint only relevant at confirmation. Secondary.</div>
          </div>
        </div>
      </div>
      <div className="c4-sc"><div className="c4-sc-body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}><strong style={{ color: 'var(--c1-ink)' }}>Decision: Option A.</strong> The inline warning text is unambiguous without blocking flow.</div></div>
    </div>
  );
}

// ─── D1: Imported annotation chip ───────────────────────────────────────────

function CalmV4ImportChip() {
  const wordBlue = 'oklch(0.42 0.14 240)';
  const wordSoft = 'oklch(0.94 0.04 245)';
  const wordBorder = 'oklch(0.84 0.06 245)';

  function ImportCard({ showAuthor = true, showFile = true }) {
    return (
      <div className="c1-card note" style={{ position: 'relative', left: 0, right: 0 }}>
        <div className="head">
          <span className="dot u" /><span className="who u">You</span>
          <span className="kind">note</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, fontFamily: 'var(--font-mono)', padding: '1px 5px', borderRadius: 3, background: wordSoft, color: wordBlue, border: `1px solid ${wordBorder}` }}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="1" y="1" width="10" height="8" rx="1"/><path d="M3.5 1v2h5V1"/></svg>
            Imported
          </span>
          <span className="t">May 8</span>
        </div>
        {showAuthor && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 0', fontSize: 11 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-faint)' }}>From</span>
            <strong style={{ color: 'var(--c1-ink)', fontSize: 11.5 }}>Sarah Chen</strong>
            {showFile && <><span style={{ color: 'var(--c1-ink-faint)' }}>·</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: wordBlue, background: wordSoft, border: `1px solid ${wordBorder}`, padding: '1px 5px', borderRadius: 3 }}>PRD-v2.docx</span></>}
          </div>
        )}
        <div className="snip">"the dashboard timeline slipped due to an unexpected API redesign"</div>
        <div className="body">Timeline in section 3 doesn't match the Q1 kickoff agreement.</div>
        <div className="actions"><span>Edit</span><span>Remove</span><span style={{ flex: 1 }} /><span className="primary">Send to Claude</span></div>
      </div>
    );
  }

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: wordBlue }}>D1 — imported annotation attribution</div>
        <h2>author: "import" — showing provenance</h2>
        <p className="lead">When an annotation is imported from an external source (e.g. Word comments), the card shows where it came from. Three fallback tiers based on available metadata.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div>
          <div className="c4-sc-lbl">Full attribution (recommended)</div>
          <ImportCard showAuthor={true} showFile={true} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--c1-ink-muted)', lineHeight: 1.45 }}>Author name + file provenance. Use when <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>importSource.author</code> exists.</p>
        </div>
        <div>
          <div className="c4-sc-lbl">Author only (no file)</div>
          <ImportCard showAuthor={true} showFile={false} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--c1-ink-muted)', lineHeight: 1.45 }}>When <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>importSource.file</code> is absent.</p>
        </div>
        <div>
          <div className="c4-sc-lbl">No attribution (legacy)</div>
          <ImportCard showAuthor={false} showFile={false} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--c1-ink-muted)', lineHeight: 1.45 }}>When <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>importSource</code> is absent entirely. Chip is sufficient fallback.</p>
        </div>
      </div>
      <div className="c4-sc"><div className="c4-sc-body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}><strong style={{ color: 'var(--c1-ink)' }}>Chip is not interactive</strong> — no filter-by-source-author. The batch-promote flow in ar-import is the discovery surface for imported annotations.</div></div>
    </div>
  );
}

// ─── D2: Legacy highlight key fallback ──────────────────────────────────────

function CalmV4LegacyHl() {
  const colors = [
    { key: 'yellow', bg: 'rgba(234,179,8,0.22)',   label: 'Yellow', current: true },
    { key: 'green',  bg: 'rgba(34,197,94,0.22)',    label: 'Green',  current: true },
    { key: 'blue',   bg: 'rgba(59,130,246,0.22)',   label: 'Blue',   current: true },
    { key: 'pink',   bg: 'rgba(236,72,153,0.22)',   label: 'Pink',   current: true },
    { key: 'red',    bg: 'rgba(220,38,38,0.22)',    label: 'Red',    current: false, mapsTo: 'pink', mapBg: 'rgba(236,72,153,0.22)' },
    { key: 'purple', bg: 'rgba(147,51,234,0.22)',   label: 'Purple', current: false, mapsTo: 'blue', mapBg: 'rgba(59,130,246,0.22)' },
  ];
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--accent)' }}>D2 — legacy highlight palette fallback</div>
        <h2>red → pink · purple → blue (shipped v0.11.0)</h2>
        <p className="lead">Legacy keys are normalized on read by <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>sanitize.ts</code>. Unknown keys fall back to yellow. The picker hard-cuts to 4 colors.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 12 }}>
        {colors.map(c => (
          <div key={c.key} className="c4-sc">
            <div className="c4-sc-body" style={{ textAlign: 'center' }}>
              <div style={{ width: '100%', height: 28, borderRadius: 4, background: c.bg, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {!c.current && <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--c1-ink-faint)" strokeWidth="1.5"><path d="M1 1l10 10M11 1L1 11"/></svg>}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink)', fontWeight: 600, marginBottom: 2 }}>{c.key}</div>
              <div style={{ fontSize: 11, color: c.current ? 'oklch(0.52 0.14 150)' : 'var(--c1-ink-muted)' }}>{c.current ? '✓ in picker' : 'removed'}</div>
              {c.mapsTo && (
                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--c1-ink-muted)' }}>→</span>
                  <div style={{ width: 14, height: 14, borderRadius: 3, background: c.mapBg, border: '1px solid oklch(0 0 0 / 0.09)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-muted)' }}>{c.mapsTo}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="c4-sc"><div className="c4-sc-body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}><strong style={{ color: 'var(--c1-ink)', display: 'block', marginBottom: 3 }}>Inbound legacy keys</strong>Annotations with <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>color: "red"</code> or <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>"purple"</code> are normalized on read. They render as pink/blue immediately — no migration script needed.</div></div>
        <div className="c4-sc"><div className="c4-sc-body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}><strong style={{ color: 'var(--c1-ink)', display: 'block', marginBottom: 3 }}>Unknown keys (future-proofing)</strong>Any key not in {'{yellow, green, blue, pink}'} falls back to <strong style={{ color: 'var(--c1-ink)' }}>yellow</strong> at render time. No error thrown.</div></div>
      </div>
    </div>
  );
}

// ─── D3: Mini-toolbar collision transitions ──────────────────────────────────

function CalmV4Collision() {
  const selectedText = (
    <p style={{ fontFamily: 'var(--font-serif)', fontSize: 14, color: 'var(--c1-ink)', margin: 0, lineHeight: 1.6 }}>
      The dashboard timeline{' '}
      <span style={{ background: 'oklch(0.85 0.10 245 / 0.35)', borderRadius: 2, padding: '1px 0' }}>slipped due to an unexpected</span>
      {' '}API redesign.
    </p>
  );
  const miniTb = (opacity) => (
    <div style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', display: 'inline-flex', alignItems: 'center', gap: 1, background: 'var(--c1-sheet)', border: '1px solid oklch(0 0 0 / 0.09)', borderRadius: 6, padding: 3, boxShadow: 'var(--c1-shadow-float)', opacity, transition: 'opacity 140ms ease', pointerEvents: opacity === 0 ? 'none' : 'auto' }}>
      {['B','I'].map(l => <button key={l} style={{ width: 26, height: 26, border: 'none', background: 'transparent', borderRadius: 3, fontWeight: l==='B'?700:400, fontStyle: l==='I'?'italic':'normal', fontSize: 13, color: 'var(--c1-ink)', cursor: 'pointer' }}>{l}</button>)}
      <div style={{ width: 1, height: 14, background: 'oklch(0 0 0 / 0.09)', margin: '0 2px' }} />
      {['rgba(234,179,8,.5)','rgba(34,197,94,.5)','rgba(96,165,250,.5)'].map((c,i) => <span key={i} style={{ width: 13, height: 13, borderRadius: 3, background: c, margin: '0 1px' }} />)}
    </div>
  );
  const palette = () => (
    <div style={{ position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)', width: 220, background: 'var(--c1-sheet)', border: '1px solid oklch(0 0 0 / 0.09)', borderRadius: 8, boxShadow: '0 8px 24px oklch(0 0 0 / 0.12)', padding: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'var(--c1-canvas-soft)', borderRadius: 5, marginBottom: 4 }}>
        <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="var(--c1-ink-faint)" strokeWidth="1.5" strokeLinecap="round"><circle cx="6" cy="6" r="4"/><path d="M10 10l3 3"/></svg>
        <span style={{ fontSize: 11.5, color: 'var(--c1-ink-faint)' }}>Search commands…</span>
      </div>
      {['Apply suggestion','Toggle authorship','Open outline'].map(item => (
        <div key={item} style={{ padding: '5px 8px', borderRadius: 4, fontSize: 12, color: 'var(--c1-ink)' }}>{item}</div>
      ))}
    </div>
  );

  const frames = [
    { label: '① Selection active — toolbar visible', tb: 1, pal: false, note: 'Text selected. Mini-toolbar appears above at opacity 1.' },
    { label: '② Palette opens (⌘K) — toolbar fades out', tb: 0, pal: true, note: '⌘K fires. Toolbar fades to opacity 0 in 140ms. Palette slides in simultaneously.' },
    { label: '③ Palette active — toolbar fully hidden', tb: -1, pal: true, note: 'Toolbar display:none after transition. Esc restores it if selection is still active.' },
  ];

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--accent)' }}>D3 — mini-toolbar collision transitions</div>
        <h2>Opening palette over an active selection</h2>
        <p className="lead">140ms opacity fade when palette or Find bar opens. Never snap-replace — always crossfade or sequential. Re-appears on palette/find close if selection still active.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {frames.map(f => (
          <div key={f.label} className="c4-sc">
            <div className="c4-sc-body">
              <div className="c4-sc-lbl">{f.label}</div>
              <div style={{ position: 'relative', minHeight: 100, background: 'var(--c1-canvas)', borderRadius: 6, padding: '14px 16px' }}>
                {selectedText}
                {f.tb >= 0 && miniTb(f.tb)}
                {f.pal && palette()}
              </div>
            </div>
            <div className="c4-sc-foot">{f.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── D5: Read-only info bar ──────────────────────────────────────────────────

function CalmV4ROInfoBar() {
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--accent)' }}>D5 — read-only info bar</div>
        <h2>Decision: keep both tab badge + rail info bar</h2>
        <p className="lead">They serve different needs: badge = glanceable (is this editable?); info bar = actionable (what does read-only mean for this file type?).</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div className="c4-sc-lbl">Tab badge — always visible, glanceable</div>
          <div className="c4-sc">
            <div className="c4-sc-body">
              <div style={{ display: 'flex', alignItems: 'stretch', height: 30, padding: '0 10px', gap: 2, background: 'var(--c1-canvas)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: '2px solid var(--accent)', marginBottom: -1 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px', background: 'oklch(0.94 0.04 245)', color: 'oklch(0.42 0.16 245)', borderRadius: 3 }}>W</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--c1-ink)' }}>board-update-may.docx</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, padding: '1px 5px', background: 'oklch(from var(--warning) l c h / 0.15)', color: 'oklch(from var(--warning) calc(l - 0.10) c h)', border: '1px solid oklch(from var(--warning) l c h / 0.25)', borderRadius: 3 }}>RO</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px', color: 'var(--c1-ink-faint)', fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 3px', background: 'oklch(0 0 0 / 0.04)', border: '1px solid oklch(0 0 0 / 0.07)', borderRadius: 3 }}>M</span> rfc-007.md
                </div>
              </div>
              <div style={{ padding: '10px 12px', fontFamily: 'var(--font-serif)', fontSize: 14, color: 'var(--c1-ink)', lineHeight: 1.5 }}>Q2 Progress Review — Self-Service Dashboard…</div>
            </div>
            <div className="c4-sc-foot">Amber RO badge on tab. Always visible regardless of rail state. No text — badge color + letter convey meaning at glance.</div>
          </div>
        </div>
        <div>
          <div className="c4-sc-lbl">Rail info bar — actionable, context-rich</div>
          <div className="c4-sc">
            <div className="c4-sc-body">
              <div className="c2-ro-info">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><rect x="4" y="8" width="8" height="6" rx="1" /><path d="M6 8V6a2 2 0 0 1 4 0v2" /></svg>
                <div>
                  <strong>Read-only · .docx</strong>
                  Original file is never overwritten. Annotations tracked separately. When review is complete, <a href="#" onClick={e => e.preventDefault()}>Apply changes → Export copy…</a>
                </div>
              </div>
            </div>
            <div className="c4-sc-foot">Lives at top of rail body. Carries format-specific context and the "Apply Changes" affordance. Dismissible per-session.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── E1: WCAG AA token audit ─────────────────────────────────────────────────

function CalmV4WCAGAudit() {
  const tokens = [
    { name: '--tandem-suggestion',    sample: 'oklch(0.52 0.18 305)', label: 'Suggestion fill',     bg: 'white',                    ratio: '3.1:1', pass: false, fix: 'Use for fill/border only; not for text.' },
    { name: '--tandem-suggestion-fg', sample: 'oklch(0.35 0.22 305)', label: 'Suggestion fg-strong', bg: 'oklch(0.96 0.03 305)',     ratio: '4.8:1', pass: true,  fix: 'Pass — use for text on suggestion-soft bg.' },
    { name: '--tandem-warning',       sample: 'oklch(0.62 0.16 65)',  label: 'Warning fill',         bg: 'white',                    ratio: '3.8:1', pass: false, fix: 'Use for fill/border only; not for text.' },
    { name: '--tandem-warning-fg',    sample: 'oklch(0.42 0.18 65)',  label: 'Warning fg-strong',    bg: 'oklch(0.97 0.04 75)',      ratio: '5.2:1', pass: true,  fix: 'Pass — use for text on warning-soft bg.' },
    { name: '--tandem-error',         sample: 'oklch(0.55 0.18 25)',  label: 'Error fill',           bg: 'white',                    ratio: '4.6:1', pass: true,  fix: 'Borderline pass. Prefer -fg-strong for body text.' },
    { name: '--author-claude',        sample: '#D97757',              label: 'Claude author',         bg: 'white',                    ratio: '3.3:1', pass: false, fix: 'Use for gutters/dots/borders only. Never as text color on white.' },
  ];

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'oklch(0.52 0.18 25)' }}>E1 — WCAG AA token audit</div>
        <h2>Semantic color token contrast audit</h2>
        <p className="lead">Tokens that fail WCAG AA (4.5:1) for normal text use must be split into fill + fg-strong variants. Fills are safe for backgrounds, borders, and decorative dots only.</p>
      </div>
      <div className="c4-sc" style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--font-sans)' }}>
          <thead>
            <tr style={{ background: 'var(--c1-canvas-soft)' }}>
              {['Token', 'Sample', 'Label', 'On bg', 'Ratio', 'Status', 'Rule'].map(h => (
                <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)', fontWeight: 500, borderBottom: '1px solid oklch(0 0 0 / 0.07)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tokens.map((t, i) => (
              <tr key={t.name} style={{ borderBottom: '1px solid oklch(0 0 0 / 0.06)', background: i % 2 === 0 ? 'transparent' : 'var(--c1-canvas-soft)' }}>
                <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--c1-ink-muted)' }}>{t.name}</td>
                <td style={{ padding: '8px 12px' }}><span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: t.sample, border: '1px solid oklch(0 0 0 / 0.09)', verticalAlign: 'middle' }} /></td>
                <td style={{ padding: '8px 12px', color: 'var(--c1-ink)' }}>{t.label}</td>
                <td style={{ padding: '8px 12px' }}><span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: t.bg, border: '1px solid oklch(0 0 0 / 0.09)', verticalAlign: 'middle' }} /></td>
                <td style={{ padding: '8px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: t.pass ? 'oklch(0.45 0.14 150)' : 'oklch(0.48 0.16 25)' }}>{t.ratio}</td>
                <td style={{ padding: '8px 12px' }}>
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '1px 6px', borderRadius: 3, background: t.pass ? 'oklch(0.97 0.020 150)' : 'oklch(0.97 0.020 25)', color: t.pass ? 'oklch(0.45 0.14 150)' : 'oklch(0.48 0.16 25)', border: t.pass ? '1px solid oklch(0.85 0.07 150)' : '1px solid oklch(0.86 0.07 25)' }}>
                    {t.pass ? 'PASS' : 'FAIL'}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--c1-ink-muted)' }}>{t.fix}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="c4-sc"><div className="c4-sc-body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}><strong style={{ color: 'var(--c1-ink)' }}>Action: split failing tokens.</strong> Add <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>-fg-strong</code> variants at lower lightness for each failing token. Fill tokens remain for use as backgrounds, borders, and decorative marks. Never use fill tokens as text color on white.</div></div>
    </div>
  );
}

// ─── F1: Document Groups ─────────────────────────────────────────────────────

function C4GroupsRail() {
  const [expanded, setExpanded] = React.useState({ g1: true, g2: false });
  const groups = [
    { id: 'g1', name: 'Q2 Board Packet', count: 4, mod: '2m ago',
      docs: [{ name: 'q2-progress-review.md', ext: 'M', dirty: true },{ name: 'q2-board-memo.docx', ext: 'W' },{ name: 'q2-okrs.md', ext: 'M' },{ name: 'q2-appendix.docx', ext: 'W' }] },
    { id: 'g2', name: 'RFC-007 Read Layer', count: 3, mod: '1h ago',
      docs: [{ name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },{ name: 'adr-029.md', ext: 'M' },{ name: 'read-layer-spike.md', ext: 'M' }] },
  ];
  const extBadge = (ext) => (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px', background: ext === 'W' ? 'oklch(0.94 0.04 245)' : 'oklch(0 0 0 / 0.04)', color: ext === 'W' ? 'oklch(0.42 0.16 245)' : 'var(--c1-ink-faint)', border: '1px solid oklch(0 0 0 / 0.07)', borderRadius: 3, flexShrink: 0 }}>{ext}</span>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid oklch(0 0 0 / 0.07)', background: 'var(--c1-canvas)' }}>
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '0 10px', height: 36, gap: 2, borderBottom: '1px solid oklch(0 0 0 / 0.07)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '0 6px', fontSize: 12, fontWeight: 500, color: 'var(--c1-ink)', borderBottom: '2px solid var(--accent)', marginBottom: -1, cursor: 'pointer' }}>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h5l1.5 2H13v7H1z"/></svg>Groups
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 6px', fontSize: 12, color: 'var(--c1-ink-faint)', cursor: 'pointer' }}>Annotations</div>
        <div style={{ flex: 1 }} />
        <button style={{ border: 'none', background: 'transparent', color: 'var(--c1-ink-faint)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: '0 4px' }}>
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)', padding: '8px 12px 4px' }}>Groups</div>
        {groups.map(g => (
          <div key={g.id} style={{ borderBottom: '1px solid oklch(0 0 0 / 0.06)' }}>
            <div onClick={() => setExpanded(p => ({ ...p, [g.id]: !p[g.id] }))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', background: expanded[g.id] ? 'oklch(from var(--accent) l c h / 0.08)' : 'transparent', transition: 'background 120ms' }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke={expanded[g.id] ? 'var(--accent)' : 'var(--c1-ink-faint)'} strokeWidth="1.6" strokeLinecap="round"
                style={{ transform: expanded[g.id] ? 'rotate(90deg)' : 'none', transition: 'transform 150ms', flexShrink: 0 }}><path d="M4 2l4 4-4 4"/></svg>
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={expanded[g.id] ? 'var(--accent)' : 'var(--c1-ink-muted)'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h5l1.5 2H13v7H1z"/></svg>
              <span style={{ flex: 1, fontWeight: 600, fontSize: 12.5, color: expanded[g.id] ? 'var(--accent)' : 'var(--c1-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-faint)', flexShrink: 0 }}>{g.count} · {g.mod}</span>
            </div>
            {expanded[g.id] && (
              <div style={{ paddingBottom: 4 }}>
                {g.docs.map(d => (
                  <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 12px 5px 32px', cursor: 'pointer' }}>
                    {extBadge(d.ext)}
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--c1-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                    {d.dirty && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--warning)', flexShrink: 0 }} />}
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px 4px 32px', color: 'var(--c1-ink-faint)', fontSize: 11.5, cursor: 'pointer' }}>
                  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>Add document
                </div>
              </div>
            )}
          </div>
        ))}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)', padding: '8px 12px 4px', borderTop: '1px solid oklch(0 0 0 / 0.06)', marginTop: 6 }}>Ungrouped (3)</div>
        {[['partner-update.docx','W'],['scratch-notes.md','M'],['meeting-may12.md','M']].map(([n,ext]) => (
          <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 12px', cursor: 'pointer' }}>
            {extBadge(ext)}<span style={{ flex: 1, fontSize: 12, color: 'var(--c1-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CalmV4DocGroups() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame" style={{ position: 'relative' }}>
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },
        { id: 'd2', name: 'q2-board-memo.docx', ext: 'W' },
      ]} />
      <C2Fmtbar leftOn={true} />
      <div className="c2-main" style={{ gridTemplateColumns: '260px 1fr' }}>
        <C4GroupsRail />
        <div className="c1-editor-wrap">
          <div className="c1-sheet" style={{ maxWidth: 680 }}><C4DocMd /></div>
        </div>
      </div>
      <C2Status />
      <div style={{ position: 'absolute', top: 50, right: 12, background: 'oklch(0.62 0.16 65)', color: 'white', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', padding: '3px 9px', borderRadius: 4, pointerEvents: 'none', zIndex: 10 }}>F1 · SPECULATIVE · confidence: medium</div>
    </div>
  );
}

// ─── F3: Document Groups drag sequence ───────────────────────────────────────

function CalmV4DocGroupsDrag() {
  const accent = 'var(--accent)';
  const accentSoft = 'oklch(from var(--accent) l c h / 0.09)';
  const states = [
    { label: '① Drag starts', over: false, dropped: false, dragging: true,  desc: 'User drags "scratch-notes.md" from Ungrouped. Ghost clone follows cursor.' },
    { label: '② Over group target', over: true,  dropped: false, dragging: true,  desc: 'File hovering over "RFC-007 Read Layer". Group highlights with accent border + "drop to add" hint.' },
    { label: '③ Dropped', over: false, dropped: true,  dragging: false, desc: 'File added. Group row pulses (scale 1→1.01→1). File appears as last item.' },
  ];
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'oklch(0.62 0.16 65)' }}>F3 · speculative · confidence: medium — drag-to-add</div>
        <h2>Adding a document to a group by drag</h2>
        <p className="lead">3-state drag sequence. Drop target highlights with accent border + ring. Ghost clone rotated −1.5°.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {states.map(s => (
          <div key={s.label} className="c4-sc">
            <div className="c4-sc-body">
              <div className="c4-sc-lbl">{s.label}</div>
              <div style={{ border: `1.5px solid ${s.over ? accent : 'oklch(0 0 0 / 0.09)'}`, borderRadius: 6, overflow: 'hidden', boxShadow: s.over ? `0 0 0 3px ${accentSoft}` : 'none', transition: 'border-color 120ms, box-shadow 120ms' }}>
                <div style={{ padding: '7px 10px', display: 'flex', alignItems: 'center', gap: 7, background: s.over ? accentSoft : 'var(--c1-canvas-soft)' }}>
                  <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={s.over ? accent : 'var(--c1-ink-muted)'} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 3h5l1.5 2H13v7H1z"/></svg>
                  <span style={{ fontSize: 12, fontWeight: 600, color: s.over ? accent : 'var(--c1-ink)', flex: 1 }}>RFC-007 Read Layer</span>
                  {s.over && <span style={{ fontSize: 10, color: accent, fontFamily: 'var(--font-mono)' }}>drop to add</span>}
                </div>
                <div style={{ padding: '4px 0' }}>
                  {['rfc-007-readlayer.md','adr-029.md','read-layer-spike.md'].map(n => (
                    <div key={n} style={{ padding: '3px 10px 3px 22px', fontSize: 11.5, color: 'var(--c1-ink-muted)' }}>{n}</div>
                  ))}
                  {s.dropped && <div style={{ padding: '3px 10px 3px 22px', fontSize: 11.5, color: accent, fontWeight: 500, background: accentSoft }}>scratch-notes.md ✓</div>}
                </div>
              </div>
              {s.dragging && (
                <div style={{ marginTop: 10, padding: '5px 10px', background: 'var(--c1-sheet)', border: '1px solid oklch(0 0 0 / 0.09)', borderRadius: 5, display: 'flex', alignItems: 'center', gap: 7, opacity: 0.88, boxShadow: '0 4px 16px oklch(0 0 0 / 0.12)', transform: 'rotate(-1.5deg)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px', background: 'oklch(0 0 0 / 0.04)', border: '1px solid oklch(0 0 0 / 0.07)', borderRadius: 3, color: 'var(--c1-ink-faint)' }}>M</span>
                  <span style={{ fontSize: 12, color: 'var(--c1-ink)' }}>scratch-notes.md</span>
                </div>
              )}
            </div>
            <div className="c4-sc-foot">{s.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── F4: Diff hunk staging (interactive) ─────────────────────────────────────

function CalmV4DiffHunk() {
  const [hunks, setHunks] = React.useState([
    { id: 'h1', accepted: true,  before: 'simplify onboarding',       after: 'streamline first-run setup'            },
    { id: 'h2', accepted: null,  before: 'slipped due to',             after: 'extended in scope when'               },
    { id: 'h3', accepted: false, before: 'insert RFC-007 reference',   after: 'see rfc-007-readlayer.md for detail'  },
  ]);
  const accepted = hunks.filter(h => h.accepted === true).length;
  const kbd = s => <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 10, padding: '1px 5px', background: 'oklch(0 0 0 / 0.05)', border: '1px solid oklch(0 0 0 / 0.10)', borderRadius: 3 }}>{s}</kbd>;

  return (
    <div className="c4-frame" style={{ position: 'relative' }}>
      <C4Titlebar docs={[{ id: 'd1', name: 'q2-progress-review.md', ext: 'M', dirty: true }]} activeId="d1" mode="tandem" />
      {/* Diff header (replaces fmtbar) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 16px', borderBottom: '1px solid oklch(0 0 0 / 0.08)', background: 'var(--c1-canvas-soft)', flexShrink: 0 }}>
        <strong style={{ fontSize: 13, color: 'var(--c1-ink)' }}>Apply Claude's edit</strong>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--c1-ink-muted)', background: 'oklch(0 0 0 / 0.04)', border: '1px solid oklch(0 0 0 / 0.08)', padding: '1px 6px', borderRadius: 3 }}>{accepted}/{hunks.length} accepted</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 10, padding: '2px 8px', borderRadius: 99, background: 'oklch(from var(--accent) l c h / 0.10)', color: 'var(--accent)', border: '1px solid oklch(from var(--accent) l c h / 0.22)' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />Keyboard captured · Esc to release
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: 'var(--c1-ink-muted)', display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span>{kbd('↑↓')} navigate</span><span>{kbd('↵')} accept</span><span>{kbd('⌫')} reject</span><span>{kbd('⌘↵')} apply</span>
        </span>
      </div>
      {/* Speculative banner */}
      <div style={{ background: 'oklch(0.96 0.04 75)', borderBottom: '1px solid oklch(0.87 0.07 65)', padding: '5px 16px', fontSize: 11.5, color: 'oklch(0.40 0.14 65)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <strong>F4 — Speculative (confidence: medium)</strong>
        <span style={{ color: 'oklch(0.45 0.12 65)' }}>· No letter-key bindings — ↵ / ⌫ only; focus-trap pill makes capture state visible.</span>
      </div>
      {/* Hunk list */}
      <div style={{ flex: 1, overflow: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12, background: 'var(--c1-canvas)' }}>
        {hunks.map((h, i) => (
          <div key={h.id} style={{ background: 'var(--c1-sheet)', borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--c1-shadow-sheet)', border: `1px solid ${h.accepted === true ? 'oklch(0.82 0.08 150)' : h.accepted === false ? 'oklch(0.82 0.08 25)' : 'oklch(0 0 0 / 0.09)'}`, borderLeft: `4px solid ${h.accepted === true ? 'oklch(0.55 0.14 150)' : h.accepted === false ? 'oklch(0.55 0.18 25)' : 'oklch(0 0 0 / 0.12)'}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid oklch(0 0 0 / 0.07)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-muted)', background: 'oklch(0 0 0 / 0.04)', border: '1px solid oklch(0 0 0 / 0.07)', padding: '1px 5px', borderRadius: 3 }}>Hunk {i+1}</span>
              <span style={{ fontSize: 12.5, color: 'var(--c1-ink-muted)', flex: 1 }}>"{h.before}" → "{h.after}"</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-faint)' }}>{h.accepted === null ? '[↵] accept  [⌫] reject' : h.accepted ? '✓ accepted' : '✗ rejected'}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {[['Accept', true, 'oklch(0.55 0.14 150)', 'oklch(0.82 0.08 150)', 'oklch(0.48 0.14 150)'],['Reject', false, 'oklch(0.55 0.18 25)', 'oklch(0.82 0.08 25)', 'oklch(0.48 0.16 25)']].map(([label, val, activeBg, border, inactiveColor]) => (
                  <button key={label} onClick={() => setHunks(prev => prev.map(hk => hk.id === h.id ? { ...hk, accepted: val } : hk))}
                    style={{ height: 24, padding: '0 10px', border: `1px solid ${border}`, background: h.accepted === val ? activeBg : 'transparent', color: h.accepted === val ? 'white' : inactiveColor, borderRadius: 4, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer', fontWeight: h.accepted === val ? 600 : 400 }}>{label}</button>
                ))}
              </div>
            </div>
            <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ background: 'oklch(0.97 0.020 25)', color: 'oklch(0.48 0.16 25)', padding: '3px 8px', borderRadius: 3, fontFamily: 'var(--font-serif)', fontSize: 13, textDecoration: h.accepted === false ? 'none' : 'line-through', opacity: h.accepted === false ? 0.45 : 1 }}>− {h.before}</div>
              <div style={{ background: 'oklch(0.97 0.020 150)', color: 'oklch(0.45 0.14 150)', padding: '3px 8px', borderRadius: 3, fontFamily: 'var(--font-serif)', fontSize: 13, opacity: h.accepted === false ? 0.45 : 1 }}>+ {h.after}</div>
            </div>
          </div>
        ))}
      </div>
      {/* Bottom bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid oklch(0 0 0 / 0.08)', background: 'var(--c1-canvas-soft)', flexShrink: 0 }}>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--warning)" strokeWidth="1.5" strokeLinecap="round"><path d="M7 2L1.5 12h11L7 2z"/><path d="M7 6v3"/><circle cx="7" cy="11.5" r=".4" fill="var(--warning)"/></svg>
        <span style={{ fontSize: 11.5, color: 'var(--c1-ink-muted)', flex: 1 }}>Apply creates a <strong style={{ color: 'var(--c1-ink)' }}>single undo step</strong> — individual hunks cannot be un-applied separately.</span>
        <button style={{ height: 28, padding: '0 12px', border: '1px solid oklch(0 0 0 / 0.09)', background: 'transparent', borderRadius: 5, fontSize: 12, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
        <button style={{ height: 28, padding: '0 12px', border: '1px solid oklch(0 0 0 / 0.09)', background: 'transparent', borderRadius: 5, fontSize: 12, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Apply accepted ({accepted})</button>
        <button style={{ height: 28, padding: '0 16px', background: 'var(--c1-ink)', color: 'oklch(0.98 0.003 80)', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Apply all ({hunks.length})</button>
      </div>
    </div>
  );
}

// ─── F6: Outline heading annotation ─────────────────────────────────────────

function CalmV4OutlineAnno() {
  const items = [
    { lvl: 1, text: 'RFC-007 — Read Layer Design', count: 0 },
    { lvl: 2, text: 'Proposed architecture', count: 2, active: true },
    { lvl: 3, text: 'Write path', count: 0 },
    { lvl: 3, text: 'Read path', count: 1 },
    { lvl: 2, text: 'Trade-offs', count: 1 },
    { lvl: 2, text: 'Timeline', count: 0 },
  ];
  const indent = { 1: 12, 2: 24, 3: 38 };
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'oklch(0.62 0.16 65)' }}>F6 · speculative · confidence: low — outline section annotation</div>
        <h2>Section-level annotation from outline panel</h2>
        <p className="lead">A "+ Note" affordance on hovered/active outline items creates a heading-anchored annotation. Confidence is low — requires new coordinate logic server-side. Do not block v0.12.0.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
        <div className="c4-sc" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid oklch(0 0 0 / 0.07)', fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)' }}>Outline panel</div>
          {items.map(item => (
            <div key={item.text} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `6px 12px 6px ${indent[item.lvl]}px`, background: item.active ? 'oklch(from var(--accent) l c h / 0.09)' : 'transparent', borderBottom: '1px solid oklch(0 0 0 / 0.05)' }}>
              <span style={{ flex: 1, fontSize: item.lvl === 1 ? 13 : 12, fontWeight: item.lvl <= 2 ? 500 : 400, color: item.active ? 'var(--accent)' : item.lvl === 1 ? 'var(--c1-ink)' : 'var(--c1-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text}</span>
              {item.count > 0 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, background: item.active ? 'var(--accent)' : 'oklch(0 0 0 / 0.05)', color: item.active ? 'white' : 'var(--c1-ink-faint)', padding: '0 5px', borderRadius: 99, minWidth: 18, textAlign: 'center', border: item.active ? 'none' : '1px solid oklch(0 0 0 / 0.07)' }}>{item.count}</span>}
              {item.active && (
                <button style={{ height: 20, padding: '0 7px', border: '1px solid var(--accent)', background: 'transparent', borderRadius: 3, fontSize: 10, color: 'var(--accent)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0 }}>+ Note</button>
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['Anchor type', 'Section-level annotation anchors to the heading node, not a text range. Range: from heading start to next heading of same/higher level.'],
            ['Coordinate system', 'Must use flat-offset coordinates (extractText() positions), not ProseMirror heading positions. Heading node offset computable from document structure.'],
            ['UI trigger', '"+ Note" appears on hover or active outline item. Creates a note (private) only — not a comment. Comment requires text selection.'],
            ['Confidence: low', 'Section-level anchors require new coordinate logic server-side. No user demand confirmed. Tag with "speculative" in handoff. Do not block v0.12.0.'],
          ].map(([title, body]) => (
            <div key={title} className="c4-sc">
              <div className="c4-sc-body">
                <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--c1-ink)', marginBottom: 5 }}>{title}</div>
                <div style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}>{body}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Exports ─────────────────────────────────────────────────────────────────

Object.assign(window, {
  CalmV4DiffIrrev,
  CalmV4ImportChip,
  CalmV4LegacyHl,
  CalmV4Collision,
  CalmV4ROInfoBar,
  CalmV4WCAGAudit,
  C4GroupsRail, CalmV4DocGroups,
  CalmV4DocGroupsDrag,
  CalmV4DiffHunk,
  CalmV4OutlineAnno,
});
