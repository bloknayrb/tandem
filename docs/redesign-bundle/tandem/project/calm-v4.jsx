/* calm-v4.jsx — all v4 frames and spec panels
   Depends on: calm-v1.jsx + calm-v2.jsx (must be loaded first)
   Globals available: C2Fmtbar, C2Rail, C2Status, C2DocMd, DCSection, DCArtboard
*/

// ─── A3: Merged titlebar ─────────────────────────────────────────────────────

function C4Titlebar({ docs = [], activeId, mode = 'tandem', setMode }) {
  return (
    <div className="c4-titlebar">
      <div className="c4-brand">
        <img src="logo.png" alt="" style={{ width: 20, height: 20, objectFit: 'contain', borderRadius: 4, flexShrink: 0 }} />
        Tandem
      </div>

      <div className="c4-tabs">
        {docs.map(d => (
          <div key={d.id} className={'c4-tab' + (d.id === activeId ? ' on' : '')}>
            <span className="c4-tab-ext">{d.ext}</span>
            <span>{d.name}</span>
            {d.ro    && <span className="c4-tab-ro">RO</span>}
            {d.dirty && <span className="c4-tab-dirty" />}
            <span className="c4-tab-close">
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M1 1l6 6M7 1l-6 6" />
              </svg>
            </span>
          </div>
        ))}
        <div className="c4-tab-add" title="New document ⌘N">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M6 1v10M1 6h10" />
          </svg>
        </div>
      </div>

      <div className="c4-controls">
        <div className="c1-seg" style={{ marginRight: 8 }}>
          <button className={mode === 'solo'   ? 'on' : ''} onClick={() => setMode?.('solo')}>Solo</button>
          <button className={mode === 'tandem' ? 'on' : ''} onClick={() => setMode?.('tandem')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            Tandem{mode === 'tandem' && <span className="c1-claude-pulse" />}
          </button>
        </div>
        <button className="c1-icbtn" title="Keyboard shortcuts ⌘/">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <rect x="2" y="4" width="12" height="9" rx="1.5" /><path d="M5 8h1M8 8h1M11 8h1M5 10h1M8 10h2" />
          </svg>
        </button>
        <button className="c1-icbtn" title="Settings ⌘,">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.73 7.17L14 8l-1.27.83-1.64 2.85L11 13.2l-1.36-.69H6.36L5 13.2l-.09-2.37L3.27 8.83 2 8l1.27-.83L4.91 4.32 5 2.8l1.36.69h3.28L11 2.8l.09 2.37z" />
            <circle cx="8" cy="8" r="2" />
          </svg>
        </button>
        <div className="c2-win-controls">
          <div className="c2-win-sep" />
          <button className="c2-win-btn"><svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor" /></svg></button>
          <button className="c2-win-btn"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0H10V10H0V0ZM1 2V9H9V2H1Z" fill="currentColor" /></svg></button>
          <button className="c2-win-btn close"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 0L0 1L4 5L0 9L1 10L5 6L9 10L10 9L6 5L10 1L9 0L5 4L1 0Z" fill="currentColor" /></svg></button>
        </div>
      </div>
    </div>
  );
}

// ─── A1: Doc body with per-run text-tint authorship ──────────────────────────

function C4DocMd({ showMini = false }) {
  const Chip = ({ dot, label }) => (
    <span className="c4-chip">
      <span className="c4-chip-dot" style={{ background: dot }} />{label}
    </span>
  );

  return (
    <div className="c1-doc">
      <h1>Q2 build report</h1>
      <p className="c1-para" data-author="user">
        <span className="c4-auth" data-author="user">
          We shipped v0.11.0 on May 11 — three weeks behind the v2 design handoff and with three deliberate divergences from the spec.
          <Chip dot="var(--author-user)" label="Bryan · 2m ago" />
        </span>{' '}
        <span className="c4-auth" data-author="claude">
          <span className="c1-anno comment">Engineering surfaced seven decisions that the handoff punted on</span>, and the team is asking for clearer rules before v0.12.0.
          <Chip dot="var(--author-claude)" label="Claude · 4m ago" />
        </span>
      </p>
      <h2>What landed</h2>
      <p className="c1-para" data-author="claude">
        <span className="c4-auth" data-author="claude">
          The merged titlebar (PR #602) collapses brand, doc tabs, mode toggle and chrome into one 44px draggable strip.{' '}
          <span className="c1-anno comment active">Which feels tight on Windows once you add the system controls.</span>{' '}
          Scratchpads (Ctrl+N) now mark their ephemeral state in the tab.
          <Chip dot="var(--author-claude)" label="Claude · 6m ago" />
        </span>
      </p>
      <p className="c1-para" data-author="user">
        <span className="c4-auth" data-author="user">
          Character-level authorship shipped with a denser tint than designed.{' '}
          <span className="c1-anno comment">Two legacy highlight keys (red, purple) were remapped without a migration note</span>;
          users with v0.10 docs see <span className="c1-selected">the wrong colors</span>.
          <Chip dot="var(--author-user)" label="Bryan · 1m ago" />
        </span>
      </p>
      <h2>What's next</h2>
      <p className="c1-para" data-author="claude">
        <span className="c4-auth" data-author="claude">
          v0.12.0 picks up Document Groups, diff hunk staging with focus-trapped keyboard, and the Chat empty state. Confidence labeled on each speculative artboard.
          <Chip dot="var(--author-claude)" label="Claude · 8m ago" />
        </span>
      </p>

      {showMini && (
        <div className="c1-mini" style={{ left: 194, top: 432 }}>
          <button className="c1-mini-btn"><strong>B</strong></button>
          <button className="c1-mini-btn"><em>I</em></button>
          <div className="c1-mini-divider" />
          {['rgba(234,179,8,.45)','rgba(34,197,94,.45)','rgba(96,165,250,.45)','rgba(236,72,153,.45)'].map((c,i) => (
            <span key={i} className="c1-mini-sw" style={{ background: c }} />
          ))}
          <div className="c1-mini-divider" />
          <button className="c1-mini-btn">Note <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)' }}>⏎</span></button>
          <button className="c1-mini-btn accent">Comment <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⌘⏎</span></button>
        </div>
      )}
    </div>
  );
}

// ─── Shared: heldInSolo active rail ─────────────────────────────────────────

function C4HeldActiveRail({ count = 3 }) {
  return (
    <div className="c1-rail" style={{ padding: 0 }}>
      <div className="c1-rail-head" style={{ padding: '18px 14px 14px' }}>
        <span className="on">Annotations <span className="count">4</span></span>
        <span>Chat <span className="count">2</span></span>
        <span>Outline</span>
      </div>
      <div className="c4-held-banner">
        <span className="c4-held-dot" />
        <span style={{ flex: 1, fontSize: 12 }}>
          <strong>{count} Claude annotations held</strong> while in Solo mode
        </span>
        <button className="c4-held-cta">Show all</button>
      </div>
      <div className="c1-cards" style={{ padding: '0 8px', marginTop: 14, minHeight: 360 }}>
        <div className="c1-card comment" style={{ top: 0 }}>
          <div className="head"><span className="dot u" /><span className="who u">You</span><span className="kind">comment</span><span className="t">14m</span></div>
          <div className="snip">Engineering surfaced seven decisions that the handoff punted on</div>
          <div className="body">Want me to list them with proposed owners?</div>
          <div className="actions"><span className="primary">Reply</span><span>Resolve</span></div>
        </div>
        <div className="c1-card note" style={{ top: 160 }}>
          <div className="head"><span className="dot u" /><span className="who u">You</span><span className="kind">note</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'oklch(from var(--warning) l c h / 0.25)', color: 'oklch(from var(--warning) calc(l - 0.18) c h)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Private</span>
            <span className="t">2m</span>
          </div>
          <div className="snip">Two legacy highlight keys…</div>
          <div className="body">Migration note in changelog + first-open toast for upgraded docs.</div>
          <div className="actions"><span className="primary">Send to Claude</span><span>Remove</span></div>
        </div>
      </div>
    </div>
  );
}

// ─── Shared: heldInSolo review rail ─────────────────────────────────────────

function C4HeldReviewRail() {
  const items = [
    { kind: 'comment',     dot: 'var(--author-claude)', label: 'Comment',    time: '14m', snip: 'Engineering surfaced seven decisions',      body: 'Want me to list them with proposed owners? B-section covers five already.' },
    { kind: 'replacement', dot: 'var(--suggestion)',     label: 'Suggestion', time: '8m',  snip: '44px draggable strip felt tight on Windows', body: '"Collapsing toolbar pill" saves 4px; collapses under 920px.' },
    { kind: 'note',        dot: 'var(--warning)',        label: 'Note',       time: '3m',  snip: 'Two legacy highlight keys (red, purple)',    body: 'Migration note in changelog + toast for v0.10 upgrades.' },
  ];

  return (
    <div className="c1-rail" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="c1-rail-head" style={{ padding: '18px 14px 14px' }}>
        <span className="on">Annotations <span className="count">4</span></span>
        <span>Chat</span><span>Outline</span>
      </div>

      <div className="c4-review-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="oklch(0.40 0.14 150)" strokeWidth="1.8" strokeLinecap="round">
            <path d="M13 2l-8 8-3-3" />
          </svg>
          <strong style={{ fontSize: 12.5, color: 'var(--c1-ink)' }}>Review held annotations</strong>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, background: 'var(--c1-sheet)', border: '1px solid oklch(0.84 0.07 150)', padding: '1px 6px', borderRadius: 99, color: 'oklch(0.40 0.14 150)' }}>3 queued</span>
        </div>
        <p style={{ margin: 0, fontSize: 11.5, color: 'var(--c1-ink-muted)', lineHeight: 1.45 }}>
          Claude wrote these while you were in Solo. Choose what to bring back.
        </p>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, i) => (
          <div key={i} className="c4-held-item">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: item.dot, flexShrink: 0 }} />
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--c1-ink)' }}>Claude</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, padding: '0 5px', borderRadius: 3, background: 'oklch(0 0 0 / 0.04)', color: 'var(--c1-ink-muted)', border: '1px solid oklch(0 0 0 / 0.07)' }}>{item.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--c1-ink-faint)' }}>{item.time}</span>
            </div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 11.5, fontStyle: 'italic', color: 'var(--c1-ink-muted)', borderLeft: '2px solid oklch(0 0 0 / 0.08)', paddingLeft: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              "{item.snip}"
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--c1-ink)', lineHeight: 1.4 }}>{item.body}</div>
            <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
              <button className="c4-held-surface">Surface</button>
              <button className="c4-held-dismiss">Dismiss</button>
              <span style={{ flex: 1 }} />
              <button style={{ height: 22, padding: '0 7px', background: 'transparent', color: 'var(--c1-ink-muted)', border: 'none', fontFamily: 'inherit', fontSize: 10.5, cursor: 'pointer' }}>Reveal in editor</button>
            </div>
          </div>
        ))}
      </div>

      <div className="c4-held-bulk">
        <button style={{ flex: 1, height: 26, border: '1px solid oklch(0 0 0 / 0.09)', background: 'var(--c1-sheet)', borderRadius: 4, color: 'var(--c1-ink-muted)', fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>Dismiss all</button>
        <button style={{ flex: 1, height: 26, border: 'none', background: 'oklch(0.55 0.14 150)', borderRadius: 4, color: 'white', fontFamily: 'inherit', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>Surface all</button>
      </div>
    </div>
  );
}

// ─── Frame 1: Markdown canvas (A3 + A1 + A2 mini-toolbar) ───────────────────

function CalmV4Md() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
        { id: 'd2', name: 'v0.12 plan', ext: 'M' },
        { id: 'd3', name: 'board-update.docx', ext: 'W' },
      ]} />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c1-editor-wrap">
          <div className="c1-sheet"><C4DocMd showMini={true} /></div>
        </div>
        <C2Rail />
      </div>
      <C2Status />
    </div>
  );
}

// ─── Frame 2: Docx paged (A3 titlebar) ──────────────────────────────────────

function CalmV4Docx() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d2" docs={[
        { id: 'd1', name: 'progress-report', ext: 'M' },
        { id: 'd2', name: 'board-update-may.docx', ext: 'W', ro: true },
      ]} />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c2-docx-area">
          <div className="c2-page first">
            <div className="c1-doc" style={{ fontSize: 15.5 }}>
              <div className="c1-meta" style={{ textAlign: 'center', letterSpacing: '0.14em', marginBottom: 14 }}>BOARD UPDATE — Q2 2026</div>
              <h1 style={{ textAlign: 'center', marginBottom: 26 }}>Quarterly Progress Review</h1>
              <p className="c1-para" data-author="user">
                <span className="c4-auth" data-author="user">This report summarizes Q2 progress against the three strategic pillars: <span className="c1-anno highlight">shipping the v0.11.0 milestone</span>, accelerating the partnership pipeline, and completing the Series B close.<span className="c4-chip"><span className="c4-chip-dot" style={{ background: 'var(--author-user)' }} />Bryan · author</span></span>
              </p>
              <h2>Engineering progress</h2>
              <p className="c1-para" data-author="claude">
                <span className="c4-auth" data-author="claude">v0.11.0 shipped on May 11. The build included the merged titlebar, character-level authorship, <span className="c1-anno comment">Solo→Tandem transition with held-annotation review</span>, and seven surfaces without prior design artboards.<span className="c4-chip"><span className="c4-chip-dot" style={{ background: 'var(--author-claude)' }} />Claude · wrote</span></span>
              </p>
              <p className="c1-para" data-author="user">
                <span className="c4-auth" data-author="user">Three deliberate engineering divergences from the v2 spec were made. All three are documented in the v3 handoff and addressed in v0.12.0 planning.<span className="c4-chip"><span className="c4-chip-dot" style={{ background: 'var(--author-user)' }} />Bryan · author</span></span>
              </p>
            </div>
          </div>
          <div className="c2-page cont">
            <div className="c2-page-head"><span>Quarterly Progress Review · Q2 2026</span><span>Page 2</span></div>
            <div className="c1-doc" style={{ fontSize: 15.5 }}>
              <h2>Series B timeline</h2>
              <p className="c1-para" data-author="claude">
                <span className="c4-auth" data-author="claude">The round is tracking to close by end of Q3. Lead investor confirmed term sheet in April; two follow-on investors completing diligence.<span className="c4-chip"><span className="c4-chip-dot" style={{ background: 'var(--author-claude)' }} />Claude · wrote</span></span>
              </p>
            </div>
            <div className="c2-page-foot">2</div>
          </div>
        </div>
        <C2Rail showRo={true} />
      </div>
      <C2Status fileType="docx" words="2,140" />
    </div>
  );
}

// ─── Frame 3: Three-panel (A3 + outline + A1) ────────────────────────────────

function CalmV4Three() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
        { id: 'd2', name: 'v0.12 plan', ext: 'M' },
      ]} />
      <C2Fmtbar leftOn={true} />
      <div className="c2-main three">
        <div className="c2-outline-rail">
          <div className="c2-outline-lbl">Outline</div>
          <div className="c2-outline-item h1">Q2 build report</div>
          <div className="c2-outline-item h2 on">What landed <span className="c2-outline-count">2</span></div>
          <div className="c2-outline-item h3">Titlebar merge (PR #602)</div>
          <div className="c2-outline-item h3">Authorship visualization</div>
          <div className="c2-outline-item h3">heldInSolo banner</div>
          <div className="c2-outline-item h2">What's next <span className="c2-outline-count">1</span></div>
          <div className="c2-outline-item h3">Document Groups</div>
          <div className="c2-outline-item h3">Diff hunk staging</div>
          <div className="c2-outline-item h3">Chat empty state</div>
          <div className="c2-outline-meta">
            <span className="lbl">Word count</span>
            <span className="val">1,840 words</span>
            <span className="sub">~7 min read</span>
          </div>
        </div>
        <div className="c1-editor-wrap">
          <div className="c1-sheet" style={{ maxWidth: 620 }}><C4DocMd /></div>
        </div>
        <C2Rail />
      </div>
      <C2Status />
    </div>
  );
}

// ─── A2: Dual-tier selection detail ─────────────────────────────────────────

function CalmV4SelectionDetail() {
  return (
    <div className="c2-detail-grid">
      {/* Left: v2 approach — single combined popup */}
      <div className="c2-detail-pane">
        <div className="c2-detail-lbl">Before (v2) — single popup, audience + formatting combined</div>
        <div className="c1-sheet" style={{ padding: '28px 36px 32px', position: 'relative' }}>
          <div className="c1-doc" style={{ fontSize: 15 }}>
            <p className="c1-para" data-author="user">Users with v0.10 docs see <span className="c1-selected">the wrong colors entirely</span>.</p>
          </div>
          <div className="c1-mini" style={{ left: 80, top: 86 }}>
            <button className="c1-mini-btn"><strong>B</strong></button>
            <button className="c1-mini-btn"><em>I</em></button>
            <div className="c1-mini-divider" />
            {['rgba(234,179,8,.45)','rgba(34,197,94,.45)','rgba(96,165,250,.45)','rgba(236,72,153,.45)'].map((c,i) => (
              <span key={i} className="c1-mini-sw" style={{ background: c }} />
            ))}
            <div className="c1-mini-divider" />
            <button className="c1-mini-btn">Note <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⏎</span></button>
            <button className="c1-mini-btn accent">Comment <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⌘⏎</span></button>
          </div>
        </div>
        <div className="c2-detail-note">Formatting and audience CTA share the same floating bar. Choosing Note vs. Comment is one step, but B/I/highlights and "send to Claude" are competing for attention in a single horizontal row.</div>
      </div>

      {/* Right: v4 A2 — strip above + popup below */}
      <div className="c2-detail-pane">
        <div className="c2-detail-lbl">A2 (v4) — fmt strip above · audience popup below · two peers</div>
        <div className="c1-sheet" style={{ padding: '28px 36px 80px', position: 'relative' }}>
          <div className="c1-doc" style={{ fontSize: 15 }}>
            <p className="c1-para" data-author="user">Users with v0.10 docs see <span className="c1-selected">the wrong colors entirely</span>.</p>
          </div>

          {/* ① Formatting strip ABOVE selection */}
          <div className="c4-fmt-strip" style={{ bottom: 'calc(100% - 52px)', left: 76 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--accent)', padding: '0 5px 0 2px', letterSpacing: '0.04em' }}>①</span>
            <button className="c4-fmt-btn"><strong>B</strong></button>
            <button className="c4-fmt-btn"><em>I</em></button>
            <button className="c4-fmt-btn"><span style={{ textDecoration: 'line-through', fontSize: 11 }}>S</span></button>
            <div className="c4-fmt-divider" />
            {['rgba(234,179,8,.5)','rgba(34,197,94,.5)','rgba(96,165,250,.5)','rgba(236,72,153,.5)'].map((c,i) => (
              <span key={i} className="c1-mini-sw" style={{ background: c }} />
            ))}
          </div>

          {/* ② Audience popup BELOW selection */}
          <div className="c2-popup" style={{ left: 76, top: 86 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'oklch(0.52 0.18 25)', letterSpacing: '0.04em', marginBottom: 2, display: 'block' }}>② audience</span>
            <div style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--c1-ink-muted)', paddingLeft: 8, marginBottom: 6, borderLeft: '2px solid oklch(from var(--author-claude) l c h / 0.45)' }}>
              "the wrong colors entirely"
            </div>
            <textarea className="c2-popup-ta" readOnly value="Need a migration note in changelog + first-open toast for v0.10 users." style={{ minHeight: 44 }} />
            <div className="c2-popup-row">
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)' }}>⌘⏎ send</span>
              <button className="c2-popup-cancel">Cancel</button>
              <button className="c2-popup-submit claude">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>
                Send to Claude
              </button>
            </div>
          </div>
        </div>
        <div className="c2-detail-note">Formatting (①) floats above the selection — never competes with the annotation decision. The audience popup (②) below is focused: just write, then Note or Send. z-index: strip=51, popup=52.</div>
      </div>
    </div>
  );
}

// ─── C1: Changelog on upgrade ────────────────────────────────────────────────

function CalmV4Changelog() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="cl" docs={[
        { id: 'cl', name: 'v0.11.1 Release Notes', ext: '★' },
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M' },
      ]} />
      <C2Fmtbar leftOn={false} rightOn={false} />
      <div className="c4-upgrade-banner">
        <div className="c4-upgrade-icon">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v5l3 3" /><circle cx="8" cy="8" r="6" /></svg>
        </div>
        <div style={{ flex: 1 }}>
          <strong style={{ color: 'var(--c1-ink)' }}>Tandem updated to v0.11.1</strong>
          <span style={{ color: 'var(--c1-ink-muted)', marginLeft: 10, fontSize: 12 }}>Read-only · opened on first launch after upgrade · not saved to history</span>
        </div>
        <button style={{ height: 26, padding: '0 10px', border: 'none', background: 'transparent', borderRadius: 5, fontSize: 12, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>Don't show again</button>
        <button style={{ height: 26, padding: '0 14px', border: 'none', background: 'var(--accent)', borderRadius: 5, fontSize: 12, fontWeight: 600, color: 'white', cursor: 'pointer', fontFamily: 'inherit' }}>Got it</button>
      </div>
      <div className="c2-main" style={{ gridTemplateColumns: '1fr' }}>
        <div className="c1-editor-wrap">
          <div className="c1-sheet">
            <div className="c1-doc">
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--c1-ink-faint)', margin: '0 0 1em' }}>Released 2026-05-13 · v0.11.1</p>
              <h1>What's new</h1>
              <h2>Settings sidebar redesign</h2>
              <p>Each navigation item now has an inline icon. The sidebar header shows a live version chip. A new persistent footer surfaces Changelog, Report a bug, and MCP connection status from every section.</p>
              <h2>Single titlebar — all app chrome unified</h2>
              <p>Brand, document tabs, mode toggle, Claude dot, panel controls, theme, help, and settings now live in one draggable titlebar strip. The secondary toolbar row is removed. Comment and Note actions live exclusively in the floating selection popup.</p>
              <h2>CHANGELOG no longer rewritten on upgrade</h2>
              <p>The auto-open on upgrade now passes <code>readOnly: true</code>. Autosave skips read-only documents, so your CHANGELOG is no longer quietly mutated by remark-stringify's backslash-escape defaults.</p>
              <p style={{ marginTop: '2em', paddingTop: '1em', borderTop: '1px solid oklch(0 0 0 / 0.07)', fontSize: 13, color: 'var(--c1-ink-muted)' }}>
                Full changelog: <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Settings → Changelog</span> · Report issues: <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Settings → Report a bug</span>
              </p>
            </div>
          </div>
        </div>
      </div>
      <C2Status fileType="md" words="312" />
    </div>
  );
}

// ─── C2: Scratchpad tab ──────────────────────────────────────────────────────

function CalmV4Scratchpad() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="sc" docs={[
        { id: 'sc', name: 'Scratchpad', ext: '~', dirty: false },
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M' },
      ]} />
      <C2Fmtbar rightOn={true} />
      <div className="c4-ephemeral">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--c1-ink-faint)" strokeWidth="1.5" strokeLinecap="round"><path d="M3 2h8l2 2v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4l2-2z" /><path d="M7 6v3" /><circle cx="7" cy="11" r=".5" fill="var(--c1-ink-faint)" /></svg>
        <strong style={{ color: 'var(--c1-ink)', fontWeight: 600 }}>Ephemeral</strong> — not written to disk. Content is lost when the tab closes.
        <button style={{ height: 20, padding: '0 8px', border: '1px solid oklch(from var(--warning) l c h / 0.28)', background: 'transparent', borderRadius: 4, fontSize: 11, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit', marginLeft: 4 }}>
          Save As… <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⌘⇧S</span>
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--c1-ink-faint)' }}>upload:// · in-memory · no path</span>
      </div>
      <div className="c2-main">
        <div className="c1-editor-wrap">
          <div className="c1-sheet">
            <div className="c1-doc">
              <h1 style={{ color: 'var(--c1-ink-faint)', fontWeight: 400 }}>Scratchpad</h1>
              <p className="c1-para" data-author="user">
                <span className="c4-auth" data-author="user">Quick draft — gut-checking the read-layer approach before writing the RFC properly. The eventual consistency window (~800ms) feels acceptable for dashboards but I want to verify with the invoicing team before committing.</span>
              </p>
              <p className="c1-para" data-author="user"><span className="c4-auth" data-author="user">Questions for tomorrow's sync:</span></p>
              <ul style={{ paddingLeft: '1.4em', margin: '0 0 1em', fontFamily: 'var(--font-serif)', fontSize: 17 }}>
                <li>P99 warehouse write latency under current production load?</li>
                <li>Does invoicing have a cache invalidation hook we can subscribe to?</li>
                <li>Rollback path if read layer adds &gt;200ms to dashboard load?</li>
              </ul>
              <p style={{ color: 'var(--c1-ink-faint)', fontFamily: 'var(--font-serif)', fontSize: 17 }}>Start writing, or press <code style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>/</code> for blocks…</p>
            </div>
          </div>
        </div>
        <C2Rail />
      </div>
      <C2Status fileType="—" words="84" />
    </div>
  );
}

// ─── B3: heldInSolo — active state ──────────────────────────────────────────

function CalmV4HeldSolo() {
  const [mode, setMode] = React.useState('solo');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
        { id: 'd2', name: 'v0.12 plan', ext: 'M' },
      ]} />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c1-editor-wrap">
          <div className="c1-sheet"><C4DocMd /></div>
        </div>
        <C4HeldActiveRail count={3} />
      </div>
      <C2Status />
    </div>
  );
}

// ─── B3: heldInSolo — review state ──────────────────────────────────────────

function CalmV4HeldReview() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
      ]} />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c1-editor-wrap">
          <div className="c1-sheet"><C4DocMd /></div>
        </div>
        <C4HeldReviewRail />
      </div>
      <C2Status />
    </div>
  );
}

// ─── C4: Connection states spec panel ───────────────────────────────────────

function CalmV4ConnStates() {
  const states = [
    {
      key: 'offline', lbl: 'State 1 — Claude offline >30s', cls: 'warn',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M1 1l14 14M9.17 9.17A5 5 0 0 0 3 8M12.07 12.07A8 8 0 0 0 .93 8M16 5a11 11 0 0 0-2.93-2.07M8 16h.01" /></svg>,
      text: <><strong>Claude offline</strong> — sidecar unreachable. Edits saved locally.</>,
      action: 'Retry now',
      note: 'Auto-retry every 30s. User edits buffered locally.'
    },
    {
      key: 'reconn', lbl: 'State 2 — Reconnecting + countdown', cls: 'warn',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'c4-spin 1s linear infinite' }}><path d="M14 8A6 6 0 0 1 2.27 11.5M2 8a6 6 0 0 1 10.77-3.5" /><path d="M14 5l.5 3M2.5 11l-.5-3" /></svg>,
      text: <><strong>Reconnecting in 5s…</strong></>,
      action: 'Skip wait',
      note: 'Auto-retry in progress. Countdown visible. Spinner signals activity.'
    },
    {
      key: 'lost', lbl: 'State 3 — Connection lost, manual retry', cls: 'err',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M1 1l14 14M9.17 9.17A5 5 0 0 0 3 8M16 5a11 11 0 0 0-2.93-2.07" /></svg>,
      text: <><strong>Connection lost</strong> — edits saved locally, not synced.</>,
      action: 'Retry',
      note: 'Auto-retries exhausted (5 attempts). Persistent until user acts.'
    },
    {
      key: 'ok', lbl: 'State 4 — Reconnected toast (4s)', cls: 'ok',
      icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l3.5 3.5L13 5" /></svg>,
      text: <><strong>Reconnected</strong> — Claude is back online.</>,
      action: null,
      note: 'Auto-dismisses after 4s. Appears as top-right toast, not in rail.'
    },
  ];

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'oklch(0.45 0.14 65)' }}>C4 — connection degradation states</div>
        <h2>Connection banner — 4 states</h2>
        <p className="lead">Appears in the annotation rail when the sidecar is unreachable. Severity escalates from warning → error. Reconnected is a transient success toast.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {states.map(s => (
          <div key={s.key} className="c4-sc">
            <div className="c4-sc-body">
              <div className="c4-sc-lbl">{s.lbl}</div>
              <div className={'c4-sys ' + s.cls}>
                {s.icon}
                <span style={{ flex: 1, fontSize: 12.5 }}>{s.text}</span>
                {s.action && <button style={{ height: 22, padding: '0 9px', border: '1px solid currentColor', background: 'transparent', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', opacity: 0.8 }}>{s.action}</button>}
              </div>
            </div>
            <div className="c4-sc-foot">{s.note}</div>
          </div>
        ))}
      </div>
      <style>{`@keyframes c4-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── C3: Store readonly spec panel ──────────────────────────────────────────

function CalmV4StoreReadonly() {
  const mk = (severity) => {
    const isErr = severity === 'error';
    const cls = isErr ? 'err' : 'warn';
    const title = isErr ? 'Annotation store unwritable' : 'Annotations saving in reduced mode';
    const body = isErr
      ? 'The annotation store cannot be opened (permissions error). Annotations exist in memory but will be lost on close.'
      : 'The annotation store is read-only (disk full or permissions). New annotations are buffered in memory.';
    return (
      <div className="c4-sc">
        <div className="c4-sc-body">
          <div className="c4-sc-lbl">{isErr ? 'Error — store cannot open (action required)' : 'Warning — disk full or permissions (recoverable)'}</div>
          <div className={'c4-sys ' + cls} style={{ alignItems: 'flex-start' }}>
            <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1, fontWeight: 700 }}>{isErr ? '✕' : '⚠'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--c1-ink)', marginBottom: 3 }}>{title}</div>
              <div style={{ fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}>{body}</div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                {['Retry','Open Settings','View logs'].map(a => (
                  <button key={a} style={{ height: 24, padding: '0 10px', border: '1px solid oklch(0 0 0 / 0.12)', background: 'transparent', borderRadius: 4, fontSize: 11, color: 'var(--c1-ink-muted)', cursor: 'pointer', fontFamily: 'inherit' }}>{a}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="c4-sc-foot">{isErr ? 'Persistent — requires Retry or Settings action to clear. No auto-dismiss.' : 'Warning is dismissible. Dismissed state persists in localStorage.'}</div>
      </div>
    );
  };
  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'oklch(0.52 0.18 25)' }}>C3 — store-readonly-banner</div>
        <h2>Store read-only — two severities</h2>
        <p className="lead">Appears at the top of the annotation rail when the durable store cannot be written. Warning is recoverable; error requires user action.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {mk('warning')}
        {mk('error')}
      </div>
    </div>
  );
}

// ─── F5: Chat empty state ────────────────────────────────────────────────────

function CalmV4ChatEmpty() {
  const [mode, setMode] = React.useState('tandem');
  const suggestions = [
    "Summarize what we\u2019ve written so far",
    "What\u2019s the strongest argument in this draft?",
    "Suggest a better opening paragraph",
    "Flag any claims that need a citation",
  ];
  return (
    <div className="c4-frame">
      <C4Titlebar mode={mode} setMode={setMode} activeId="d1" docs={[
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },
      ]} />
      <C2Fmtbar rightOn={true} />
      <div className="c2-main three" style={{ '--grid-three': '220px 1fr 340px' }}>
        <div className="c2-outline-rail">
          <div className="c2-outline-lbl">Outline</div>
          <div className="c2-outline-item h1">RFC-007 — Read Layer</div>
          <div className="c2-outline-item h2 on">Proposed architecture</div>
          <div className="c2-outline-item h3">Write path</div>
          <div className="c2-outline-item h3">Read path</div>
          <div className="c2-outline-item h2">Trade-offs</div>
          <div className="c2-outline-item h2">Timeline</div>
        </div>
        <div className="c1-editor-wrap">
          <div className="c1-sheet" style={{ maxWidth: 620 }}><C4DocMd /></div>
        </div>
        {/* Chat tab — empty state */}
        <div className="c1-rail" style={{ padding: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="c1-rail-head" style={{ padding: '18px 14px 14px' }}>
            <span>Annotations <span className="count">4</span></span>
            <span className="on">Chat</span>
            <span>Outline</span>
          </div>
          <div className="c4-chat-empty">
            <div className="c4-chat-avatar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--author-claude)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--c1-ink)', marginBottom: 5 }}>Claude is ready</div>
              <div style={{ fontSize: 12.5, color: 'var(--c1-ink-muted)', lineHeight: 1.5 }}>Ask a question, request a revision, or select text in the editor to anchor a comment.</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)', textAlign: 'center', marginBottom: 2 }}>Try asking</div>
              {suggestions.map(s => (
                <button key={s} className="c4-chat-chip">{s}</button>
              ))}
            </div>
          </div>
          <div style={{ padding: '10px 12px', borderTop: '1px solid oklch(0 0 0 / 0.07)', display: 'flex', gap: 8, background: 'var(--c1-canvas-soft)', flexShrink: 0 }}>
            <textarea readOnly placeholder="Ask Claude about this document…" rows={1} style={{ flex: 1, border: '1px solid oklch(0 0 0 / 0.09)', background: 'var(--c1-sheet)', borderRadius: 6, padding: '7px 10px', fontSize: 13, fontFamily: 'inherit', color: 'var(--c1-ink)', resize: 'none', outline: 'none' }} />
            <button style={{ height: 32, width: 32, border: 'none', background: 'var(--accent)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 1L1 7l6 1 1 6z" /></svg>
            </button>
          </div>
        </div>
      </div>
      <C2Status />
    </div>
  );
}

// ─── C6: Thread collapsed spec ───────────────────────────────────────────────

function CalmV4ThreadCollapsed() {
  const userC = 'var(--author-user)';
  const claudeC = 'var(--author-claude)';

  function Card({ replies, snippet, lastAuthor, lastTime, expanded }) {
    return (
      <div className="c4-thread" style={{ borderLeft: `3px solid ${lastAuthor === 'claude' ? claudeC : userC}` }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.4 }}>"{snippet}"</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div className="c4-avatars">
            {[userC, claudeC, 'oklch(0.62 0.12 150)'].slice(0, Math.min(replies, 3)).map((c, i) => (
              <span key={i} className="c4-avatar" style={{ background: c }} />
            ))}
          </div>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--c1-ink-muted)' }}>{replies} {replies === 1 ? 'reply' : 'replies'}</span>
          <span style={{ fontSize: 11, color: 'var(--c1-ink-faint)' }}>· {lastTime}</span>
          <span style={{ flex: 1 }} />
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--c1-ink-faint)" strokeWidth="1.5" strokeLinecap="round"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>
            <path d="M2 4l4 4 4-4" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--accent)' }}>C6 — thread collapsed card state</div>
        <h2>Reply thread — collapsed</h2>
        <p className="lead">The card before the user expands it. Avatar stack + reply count + chevron. Left border color = last responder's author color.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div className="c4-sc-lbl">3 replies, Claude replied last</div>
          <Card replies={3} snippet="the dashboard timeline slipped due to an unexpected API redesign in May" lastAuthor="claude" lastTime="2m ago" />
        </div>
        <div>
          <div className="c4-sc-lbl">1 reply, you replied last</div>
          <Card replies={1} snippet="Support volume fell in line with projections" lastAuthor="user" lastTime="just now" />
        </div>
        <div>
          <div className="c4-sc-lbl">7 replies · expanded (chevron rotated)</div>
          <Card replies={7} snippet="Onboarding completion climbed from 34% to 71%" lastAuthor="user" lastTime="5m ago" expanded={true} />
        </div>
        <div className="c4-sc">
          <div className="c4-sc-body">
            <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--c1-ink)', marginBottom: 6 }}>Interaction spec</div>
            <ul style={{ margin: 0, padding: '0 0 0 1.2em', fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.65, display: 'flex', flexDirection: 'column', gap: 3 }}>
              <li>Click anywhere → expands inline (card grows)</li>
              <li>Chevron rotates 180° on expand</li>
              <li>Avatar stack: max 3 shown, overlap −5px each</li>
              <li>"just now" threshold: &lt;60s</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── D4: Toast system spec panel ─────────────────────────────────────────────

function CalmV4Toast() {
  const toasts = [
    { cls: 'info',    icon: 'ℹ', ic: 'var(--c1-ink-muted)', copy: 'Authorship data loaded from cache.',                     dur: '3s',  dismiss: false },
    { cls: 'success', icon: '✓', ic: 'oklch(0.48 0.14 150)', copy: 'Annotation promoted to Claude.',                         dur: '4s',  dismiss: false },
    { cls: 'warning', icon: '⚠', ic: 'oklch(0.45 0.14 65)',  copy: 'Store is read-only. Annotations buffered in memory.',    dur: '6s',  dismiss: true  },
    { cls: 'error',   icon: '✕', ic: 'oklch(0.48 0.16 25)',  copy: 'Failed to save — disk full. Check storage and retry.',  dur: '∞',   dismiss: true  },
  ];

  return (
    <div className="c4-spec">
      <div>
        <div className="c4-spec-tag" style={{ color: 'var(--accent)' }}>D4 — toast notification system</div>
        <h2>4 severities · position · timing · stacking</h2>
        <p className="lead">Top-right stack, newest on top. Max 4 visible; overflow collapses to "+N more". Auto-dismiss timing varies by severity; errors are persistent.</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toasts.map(t => (
          <div key={t.cls} className={'c4-toast ' + t.cls}>
            <span style={{ fontSize: 14, color: t.ic, fontWeight: 700, flexShrink: 0 }}>{t.icon}</span>
            <span style={{ flex: 1, fontSize: 13, color: 'var(--c1-ink)' }}>{t.copy}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)', background: 'oklch(0 0 0 / 0.04)', border: '1px solid oklch(0 0 0 / 0.07)', padding: '1px 6px', borderRadius: 3 }}>
              {t.dur === '∞' ? 'persistent' : `auto-dismiss ${t.dur}`}
            </span>
            {t.dismiss && <button style={{ border: 'none', background: 'transparent', color: 'var(--c1-ink-muted)', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1, flexShrink: 0 }}>×</button>}
          </div>
        ))}
      </div>
      <div className="c4-sc">
        <div className="c4-sc-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 12, color: 'var(--c1-ink-muted)', lineHeight: 1.55 }}>
          <div><strong style={{ color: 'var(--c1-ink)', display: 'block', marginBottom: 3 }}>Position: top-right</strong>Newest toast appears at top. Stack grows downward. Outside the main grid (fixed position), so it doesn't shift layout.</div>
          <div><strong style={{ color: 'var(--c1-ink)', display: 'block', marginBottom: 3 }}>Overflow: +N more</strong>When 5+ toasts are queued, the 5th collapses to a "+2 more" summary chip. Clicking expands the full stack.</div>
        </div>
      </div>
    </div>
  );
}

// ─── Dark mode wrappers ───────────────────────────────────────────────────────

function CalmV4MdDark()    { return <div className="c2-dk"><CalmV4Md /></div>; }
function CalmV4DocxDark()  { return <div className="c2-dk"><CalmV4Docx /></div>; }
function CalmV4ThreeDark() { return <div className="c2-dk"><CalmV4Three /></div>; }

// ─── Exports ─────────────────────────────────────────────────────────────────

Object.assign(window, {
  C4Titlebar, C4DocMd, C4HeldActiveRail, C4HeldReviewRail,
  CalmV4Md, CalmV4Docx, CalmV4Three,
  CalmV4SelectionDetail,
  CalmV4Changelog, CalmV4Scratchpad,
  CalmV4HeldSolo, CalmV4HeldReview,
  CalmV4ConnStates, CalmV4StoreReadonly,
  CalmV4ChatEmpty,
  CalmV4ThreadCollapsed, CalmV4Toast,
  CalmV4MdDark, CalmV4DocxDark, CalmV4ThreeDark,
});
