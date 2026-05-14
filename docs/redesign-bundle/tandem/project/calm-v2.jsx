/* calm-v2.jsx — four frame components:
   CalmV2Md, CalmV2Docx, CalmV2Three, CalmV2SelectionDetail
   Shared sub-components: C2Titlebar, C2Tabs, C2Fmtbar, C2Rail, C2Status
*/

// ─── Shared sub-components ────────────────────────────────────────

function C2WinControls() {
  return (
    <div className="c2-win-controls">
      <div className="c2-win-sep" />
      <button className="c2-win-btn" title="Minimize">
        <svg width="10" height="1" viewBox="0 0 10 1" aria-hidden="true">
          <rect width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button className="c2-win-btn" title="Maximize">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0H10V10H0V0ZM1 2V9H9V2H1Z" fill="currentColor" />
        </svg>
      </button>
      <button className="c2-win-btn close" title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 0L0 1L4 5L0 9L1 10L5 6L9 10L10 9L6 5L10 1L9 0L5 4L1 0Z" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}

function C2Sep() {
  return <div className="c2-fdiv" />;
}

function C2Titlebar({ docName = 'progress-report.md', crumb = '~/work/reports', dirty = true, mode, setMode }) {
  return (
    <div className="c1-titlebar">
      <div className="c1-brand"><span className="c1-mark" />Tandem</div>
      <span className="c1-crumb">{crumb}</span>
      <span className="c1-doc-name">{docName}</span>
      {dirty && <span className="c1-dirty" title="Unsaved changes" />}
      <div className="grow" />
      <div className="c1-seg">
        <button className={mode === 'solo' ? 'on' : ''} onClick={() => setMode?.('solo')}>Solo</button>
        <button className={mode === 'tandem' ? 'on' : ''} onClick={() => setMode?.('tandem')} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>Tandem<span className="c1-claude-pulse" title="Claude reading" /></button>
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
      <C2WinControls />
    </div>
  );
}

function C2Fmtbar({ leftOn = false, rightOn = true }) {
  const Btn = ({ title, children, on }) => (
    <button className={'c2-fbtn' + (on ? ' on' : '')} title={title}>{children}</button>
  );
  return (
    <div className="c2-fmtbar">
      <Btn title="Toggle left panel ⌘⇧[" on={leftOn}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" strokeLinecap="round" /></svg>
      </Btn>
      <C2Sep />
      <Btn title="Undo ⌘Z">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M3 7.5A5 5 0 1 1 5.5 12" /><path d="M3 4v3.5h3.5" /></svg>
      </Btn>
      <Btn title="Redo ⌘⇧Z">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M13 7.5A5 5 0 1 0 10.5 12" /><path d="M13 4v3.5H9.5" /></svg>
      </Btn>
      <C2Sep />
      <Btn title="Heading style"><span style={{ fontWeight: 600, fontSize: 12 }}>H ▾</span></Btn>
      <C2Sep />
      <Btn title="Bold ⌘B"><strong style={{ fontSize: 13 }}>B</strong></Btn>
      <Btn title="Italic ⌘I"><em style={{ fontSize: 13 }}>I</em></Btn>
      <Btn title="Strikethrough ⌘⇧X"><span style={{ textDecoration: 'line-through', fontSize: 13 }}>S</span></Btn>
      <Btn title="Inline code ⌘E"><span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{'</>'}</span></Btn>
      <C2Sep />
      <Btn title="Bullet list ⌘⇧8">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="2.5" cy="4.5" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="2.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
          <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" />
        </svg>
      </Btn>
      <Btn title="Ordered list ⌘⇧7">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" /></svg>
      </Btn>
      <Btn title="Blockquote ⌘⇧B">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M3 6h4v4H3V6zm6 0h4v4h-4V6z" /></svg>
      </Btn>
      <C2Sep />
      <Btn title="Link ⌘K">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M6 10l-2 2a2.5 2.5 0 0 0 3.5 0l3-3a2.5 2.5 0 0 0 0-3.5l-.5-.5" /><path d="M10 6l2-2a2.5 2.5 0 0 0-3.5 0l-3 3a2.5 2.5 0 0 0 0 3.5l.5.5" /></svg>
      </Btn>
      <Btn title="Code block">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M5 5l-3 3 3 3M11 5l3 3-3 3" /></svg>
      </Btn>
      <Btn title="Horizontal rule"><span style={{ fontSize: 13 }}>—</span></Btn>
      <C2Sep />
      <div className="c2-fswatches" title="Highlight color">
        <span className="c2-fsw" style={{ background: 'rgba(234,179,8,0.50)' }} />
        <span className="c2-fsw" style={{ background: 'rgba(34,197,94,0.50)' }} />
        <span className="c2-fsw" style={{ background: 'rgba(96,165,250,0.50)' }} />
        <span className="c2-fsw" style={{ background: 'rgba(236,72,153,0.50)' }} />
      </div>
      <div style={{ flex: 1 }} />
      <Btn title="Toggle right panel ⌘⇧]" on={rightOn}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" strokeLinecap="round" /></svg>
      </Btn>
    </div>
  );
}

function C2Rail({ showRo = false, minHeight = 540 }) {
  return (
    <div className="c1-rail" style={{ padding: 0 }}>
      <div className="c1-rail-head" style={{ padding: '18px 14px 14px' }}>
        <span className="on">Annotations <span className="count">4</span></span>
        <span>Chat <span className="count">2</span></span>
        <span>Outline</span>
      </div>

      {showRo && (
        <>
          <div className="c2-ro-info">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <rect x="4" y="8" width="8" height="6" rx="1" /><path d="M6 8V6a2 2 0 0 1 4 0v2" />
            </svg>
            <div>
              <strong>Read-only DOCX</strong>
              Annotations don't modify the source file. When review is complete,{' '}
              <a href="#">Apply changes → Export copy…</a>
            </div>
          </div>
          <div className="c2-ro-sep" />
        </>
      )}

      <div className="c1-cards" style={{ padding: '0 8px', minHeight }}>
        <div className="c1-card comment" style={{ top: showRo ? 10 : 0 }}>
          <div className="head">
            <span className="dot c" /><span className="who c">Claude</span>
            <span className="kind">comment</span><span className="t">14m</span>
          </div>
          <div className="snip">Engineering surfaced seven decisions that the handoff punted on</div>
          <div className="body">Want me to list them with proposed owners? B-section in v3 covers five already.</div>
          <div className="actions"><span className="primary">Reply</span><span>Resolve</span></div>
        </div>

        <div className="c1-card replacement active" style={{ top: showRo ? 196 : 178 }}>
          <div className="head">
            <span className="dot c" /><span className="who c">Claude</span>
            <span className="kind">replacement</span><span className="t">8m</span>
          </div>
          <div className="snip">which feels tight on Windows once you add the system controls</div>
          <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '5px 8px', borderRadius: 6, background: 'oklch(0 0 0 / 0.04)', marginBottom: 4 }}>
            <span style={{ textDecoration: 'line-through', color: 'var(--error)', marginRight: 6 }}>44px draggable strip</span>
            <span style={{ color: 'var(--success)' }}>collapsing toolbar pill</span>
          </div>
          <div className="body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)' }}>Saves 4px at standard width; collapses further under 920px.</div>
          <div className="actions"><span className="primary">Accept</span><span>Dismiss</span></div>
        </div>

        <div className="c1-card note" style={{ top: showRo ? 374 : 356 }}>
          <div className="head">
            <span className="dot u" /><span className="who u">You</span>
            <span className="kind">note</span>
            <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'oklch(from var(--warning) l c h / 0.25)', color: 'oklch(from var(--warning) calc(l - 0.18) c h)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Private</span>
            <span className="t">2m</span>
          </div>
          <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
          <div className="body">Migration note in changelog + first-open toast for upgraded docs.</div>
          <div className="actions"><span className="primary">Send to Claude</span><span>Remove</span></div>
        </div>

        <div className="c1-card comment" style={{ top: showRo ? 520 : 502 }}>
          <div className="head">
            <span className="dot c" /><span className="who c">Claude</span>
            <span className="kind">comment</span><span className="t">22m</span>
          </div>
          <div className="snip">three deliberate divergences from the spec</div>
          <div className="body">All three documented in v3 handoff — intentional and logged.</div>
          <div className="actions"><span className="primary">Accept</span><span>Dismiss</span></div>
        </div>
      </div>
    </div>
  );
}

function C2Status({ fileType = 'md', words = '1,840' }) {
  return (
    <div className="c1-status" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '0 22px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
        connected
      </span>
      <span>tandem · Claude reading</span>
      <div className="c2-pills">
        <span className="c2-pill comment">4 comments</span>
        <span className="c2-pill replacement">1 replacement</span>
        <span className="c2-pill note">2 notes</span>
      </div>
      <div style={{ flex: 1 }} />
      <span>{fileType} · UTF-8</span>
      <span>ln 14, col 38</span>
      <span>{words} words</span>
    </div>
  );
}

// ─── Shared doc body ─────────────────────────────────────────────

function C2DocMd({ showMini = false }) {
  return (
    <div className="c1-doc">
      <h1>Q2 build report</h1>
      <p className="c1-para" data-author="user">
        We shipped v0.11.0 on May 11 — three weeks behind the v2 design handoff and with three deliberate divergences from the spec.{' '}
        <span className="c1-anno comment">Engineering surfaced seven decisions that the handoff punted on</span>,
        and the team is asking for clearer rules before v0.12.0.
      </p>
      <h2>What landed</h2>
      <p className="c1-para" data-author="claude">
        The merged titlebar (PR #602) collapses brand, doc tabs, mode toggle and chrome into one 44px draggable strip.{' '}
        <span className="c1-anno comment active">Which feels tight on Windows once you add the system controls.</span>{' '}
        Scratchpads (Ctrl+N) now mark their ephemeral state in the tab.
      </p>
      <p className="c1-para" data-author="user">
        Character-level authorship shipped with a denser tint than the design called for.{' '}
        <span className="c1-anno comment">Two legacy highlight keys (red, purple) were remapped without a migration note</span>;
        users with v0.10 docs see{' '}
        <span className="c1-selected">the wrong colors</span>.
      </p>
      <h2>What's next</h2>
      <p className="c1-para" data-author="claude">
        v0.12.0 picks up Document Groups, diff hunk staging with focus-trapped keyboard, and the Chat empty state.
        The speculative artboards in section F lay these out — confidence labeled on each.
      </p>

      {showMini && (
        <div className="c1-mini" style={{ left: 200, top: 420 }}>
          <button className="c1-mini-btn"><strong>B</strong></button>
          <button className="c1-mini-btn"><em>I</em></button>
          <div className="c1-mini-divider" />
          <div style={{ display: 'inline-flex', gap: 4, padding: '0 4px' }}>
            <span className="c1-mini-sw" style={{ background: 'rgba(234,179,8,0.45)' }} />
            <span className="c1-mini-sw" style={{ background: 'rgba(34,197,94,0.45)' }} />
            <span className="c1-mini-sw" style={{ background: 'rgba(96,165,250,0.45)' }} />
            <span className="c1-mini-sw" style={{ background: 'rgba(236,72,153,0.45)' }} />
          </div>
          <div className="c1-mini-divider" />
          <button className="c1-mini-btn">Note <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)' }}>⏎</span></button>
          <button className="c1-mini-btn accent">Comment <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⌘⏎</span></button>
        </div>
      )}
    </div>
  );
}

// ─── Tab design — warm ledger ────────────────────────────────────

function C2Tabs({ docs, activeId }) {
  // Arch-shaped tabs: active dissolves into canvas, inactive faded
  return (
    <div className="c2-tabs-ledger">
      {docs.map(d => (
        <div key={d.id} className={'c2-tab-ledger' + (d.id === activeId ? ' on' : '')}>
          <span className={'c2-ext' + (d.extClass ? ' ' + d.extClass : '')}>{d.extLabel || d.ext}</span>
          {d.name}
          {d.ro && <span className="c2-ro-badge">RO</span>}
          {d.dirty && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--warning)', display: 'inline-block', marginLeft: 1 }} />}
        </div>
      ))}
    </div>
  );
}


// ─── Frame 1: Markdown canvas view ───────────────────────────────

function CalmV2Md() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c2-frame">
      <C2Titlebar mode={mode} setMode={setMode} />
      <C2Tabs
        activeId="d1"
        docs={[
          { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
          { id: 'd2', name: 'v0.12 plan', ext: 'M' },
          { id: 'd3', name: 'board-update.docx', ext: 'W', extClass: 'w' },
        ]}
      />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c1-editor-wrap">
          <div className="c1-sheet">
            <C2DocMd showMini={true} />
          </div>
        </div>
        <C2Rail />
      </div>
      <C2Status />
    </div>
  );
}

// ─── Frame 2: Word document — paged view ─────────────────────────

function CalmV2Docx() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c2-frame">
      <C2Titlebar
        mode={mode} setMode={setMode}
        docName="board-update-may.docx"
        dirty={false}
      />
      <C2Tabs
        activeId="d2"
        docs={[
          { id: 'd1', name: 'progress-report', ext: 'M' },
          { id: 'd2', name: 'board-update-may.docx', ext: 'W', extClass: 'w', ro: true },
        ]}
      />
      <C2Fmtbar />
      <div className="c2-main">
        <div className="c2-docx-area">
          {/* Page 1 */}
          <div className="c2-page first">
            <div className="c1-doc" style={{ fontSize: 15.5 }}>
              <div className="c1-meta" style={{ textAlign: 'center', letterSpacing: '0.14em', marginBottom: 14 }}>BOARD UPDATE — Q2 2026</div>
              <h1 style={{ textAlign: 'center', marginBottom: 26 }}>Quarterly Progress Review</h1>
              <p className="c1-para" data-author="user">
                This report summarizes Q2 progress against the three strategic pillars established at the January all-hands:{' '}
                <span className="c1-anno highlight">shipping the v0.11.0 milestone</span>,
                accelerating the partnership pipeline, and completing the Series B close.
              </p>
              <h2>Engineering progress</h2>
              <p className="c1-para" data-author="claude">
                v0.11.0 shipped on May 11. The build included the merged custom titlebar, real-time
                character-level authorship visualization,{' '}
                <span className="c1-anno comment">Solo→Tandem transition with held-annotation review</span>,
                and seven surfaces that shipped without prior design artboards.
              </p>
              <p className="c1-para" data-author="user">
                Three deliberate engineering divergences from the v2 design spec were made during the build.
                All three are documented in the v3 handoff and will be addressed in v0.12.0 planning.
              </p>
              <h2>Partnership pipeline</h2>
              <p className="c1-para" data-author="user">
                Fourteen inbound inquiries received in Q2. Three progressed to detailed evaluation.{' '}
                <span className="c1-anno comment">Non-disclosure obligations prevent fuller disclosure
                in this document</span> — see the confidential appendix for detail.
              </p>
            </div>
          </div>
          {/* Page 2 — continuation, partially visible */}
          <div className="c2-page cont">
            <div className="c2-page-head">
              <span>Quarterly Progress Review · Q2 2026</span>
              <span>Page 2</span>
            </div>
            <div className="c1-doc" style={{ fontSize: 15.5 }}>
              <h2>Series B timeline</h2>
              <p className="c1-para" data-author="claude">
                The round is tracking to close by end of Q3. Lead investor confirmed term sheet in April;
                two follow-on investors completing diligence.
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

// ─── Frame 3: Three-panel layout ─────────────────────────────────

function CalmV2Three() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="c2-frame">
      <C2Titlebar mode={mode} setMode={setMode} />
      <C2Tabs
        activeId="d1"
        docs={[
          { id: 'd1', name: 'progress-report', ext: 'M', dirty: true },
          { id: 'd2', name: 'v0.12 plan', ext: 'M' },
        ]}
      />
      <C2Fmtbar leftOn={true} />
      <div className="c2-main three">
        {/* Left outline rail */}
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
        {/* Center editor — sheet on warm canvas */}
        <div className="c1-editor-wrap">
          <div className="c1-sheet" style={{ maxWidth: 620 }}>
            <C2DocMd />
          </div>
        </div>
        {/* Right annotation rail */}
        <C2Rail />
      </div>
      <C2Status />
    </div>
  );
}

// ─── Frame 4: Selection → annotation creation popup detail ───────

function CalmV2SelectionDetail() {
  return (
    <div className="c2-detail-grid">
      {/* Left pane: mini-toolbar strip */}
      <div className="c2-detail-pane">
        <div className="c2-detail-lbl">State 1 — Selection: formatting strip</div>

        <div className="c1-sheet" style={{ padding: '28px 36px 32px', maxWidth: '100%', position: 'relative' }}>
          <div className="c1-doc" style={{ fontSize: 15 }}>
            <p className="c1-para" data-author="user">
              Character-level authorship shipped with a denser tint than designed.
              Two legacy highlight keys (red, purple) were remapped; users with v0.10 docs see{' '}
              <span className="c1-selected">the wrong colors entirely</span>.
            </p>
          </div>
          {/* Mini-toolbar: simple state */}
          <div className="c1-mini" style={{ left: 130, top: 104 }}>
            <button className="c1-mini-btn"><strong>B</strong></button>
            <button className="c1-mini-btn"><em>I</em></button>
            <div className="c1-mini-divider" />
            <div style={{ display: 'inline-flex', gap: 4, padding: '0 4px' }}>
              <span className="c1-mini-sw" style={{ background: 'rgba(234,179,8,0.45)' }} />
              <span className="c1-mini-sw" style={{ background: 'rgba(34,197,94,0.45)' }} />
              <span className="c1-mini-sw" style={{ background: 'rgba(96,165,250,0.45)' }} />
              <span className="c1-mini-sw" style={{ background: 'rgba(236,72,153,0.45)' }} />
            </div>
            <div className="c1-mini-divider" />
            <button className="c1-mini-btn">
              Note <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)' }}>⏎</span>
            </button>
            <button className="c1-mini-btn accent">
              Comment <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⌘⏎</span>
            </button>
          </div>
        </div>

        <div className="c2-detail-note">
          Formatting (B/I) and highlight colors are secondary. The audience decision —{' '}
          <em>Note</em> (private, for yourself) vs <em>Comment</em> (sent to Claude) — is the primary
          CTA, always rightmost and most prominent. Notes can be graduated to Comments.
          Structure tools stay in the persistent fmt bar; composing-time, not review-time.
        </div>
      </div>

      {/* Right pane: expanded popup */}
      <div className="c2-detail-pane">
        <div className="c2-detail-lbl">State 2 — "Comment" expanded</div>

        <div className="c1-sheet" style={{ padding: '28px 36px 32px', maxWidth: '100%', position: 'relative' }}>
          <div className="c1-doc" style={{ fontSize: 15 }}>
            <p className="c1-para" data-author="user">
              Character-level authorship shipped with a denser tint than designed.
              Two legacy highlight keys (red, purple) were remapped; users with v0.10 docs see{' '}
              <span className="c1-selected">the wrong colors entirely</span>.
            </p>
          </div>
          {/* Expanded popup — appears where the mini-toolbar was, anchored to the selection */}
          <div className="c2-popup" style={{ left: 100, top: 98 }}>
            {/* Quoted anchor — shows which text this note is about */}
            <div style={{
              fontFamily: 'var(--font-serif)', fontStyle: 'italic',
              fontSize: 12.5, color: 'var(--c1-ink-muted)',
              paddingLeft: 10, paddingBottom: 8, marginBottom: 6,
              borderLeft: '2px solid oklch(from var(--author-claude) l c h / 0.55)',
              borderBottom: '1px solid oklch(0 0 0 / 0.07)',
            }}>
              "the wrong colors entirely"
            </div>
            <textarea
              className="c2-popup-ta"
              readOnly
              value="Need a migration note in the changelog and a first-open toast for v0.10 users."
            />
            <div className="c2-popup-row">
              <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--c1-ink-faint)' }}>⌘⏎ to send</span>
              <button className="c2-popup-cancel">Cancel</button>
              <button className="c2-popup-submit claude">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                  <path d="M3 8h10M9 4l4 4-4 4" />
                </svg>
                Send to Claude
              </button>
            </div>
          </div>
        </div>

        <div className="c2-detail-note">
          Pressing "Comment" expands the strip to a textarea popup inline — same frosted glass,
          same position. The audience is already locked (no radio, no dropdown). Cancel returns to the
          formatting strip. "Note" (private) follows the same pattern but submits with a dark button.
        </div>
      </div>
    </div>
  );
}

// ─── Dark mode wrappers ───────────────────────────────────────────

function CalmV2MdDark() {
  return <div className="c2-dk"><CalmV2Md /></div>;
}

function CalmV2DocxDark() {
  return <div className="c2-dk"><CalmV2Docx /></div>;
}

function CalmV2ThreeDark() {
  return <div className="c2-dk"><CalmV2Three /></div>;
}

Object.assign(window, {
  CalmV2Md, CalmV2Docx, CalmV2Three, CalmV2SelectionDetail,
  CalmV2MdDark, CalmV2DocxDark, CalmV2ThreeDark,
});
