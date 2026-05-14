/* calm-v1.jsx — synthesis frame: borderless chrome (A) + editor sheet (B)
   + anchor-aligned tinted rail cards (C+E) + frosted mini-toolbar (D).
   Cards are positioned at vertical offsets matching their anchors. */

function CalmV1Synthesis() {
  const [mode, setMode] = React.useState('tandem');

  return (
    <div className="c1-frame">

      {/* ── Titlebar ─────────────────────────────────────────────── */}
      <div className="c1-titlebar">
        <div className="c1-brand">
          <span className="c1-mark" />
          Tandem
        </div>
        <span className="c1-crumb">~/work/reports</span>
        <span className="c1-doc-name">progress-report.md</span>
        <span className="c1-dirty" title="unsaved" />
        <div className="grow" />
        <div className="c1-seg" role="tablist">
          <button className={mode === 'solo' ? 'on' : ''} onClick={() => setMode('solo')}>Solo</button>
          <button className={mode === 'tandem' ? 'on' : ''} onClick={() => setMode('tandem')}>Tandem</button>
        </div>
        <span className="c1-claude-pulse" title="Claude reading" />
        <button className="c1-icbtn" title="Toggle theme">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" />
          </svg>
        </button>
        <button className="c1-icbtn" title="Panel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <path d="M10 3v10" />
          </svg>
        </button>
        <button className="c1-icbtn" title="More">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"><circle cx="4" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12" cy="8" r="1" /></svg>
        </button>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div className="c1-tabs">
        <div className="c1-tab on"><span className="ext">md</span>progress-report</div>
        <div className="c1-tab dirty"><span className="ext">md</span>v0.12 plan<span className="dot" /></div>
        <div className="c1-tab"><span className="ext">md</span>HANDOFF</div>
        <div className="c1-tab"><span className="ext">md</span>changelog</div>
      </div>

      {/* ── Main ─────────────────────────────────────────────────── */}
      <div className="c1-main">

        {/* Editor sheet */}
        <div className="c1-editor-wrap">
          <div className="c1-sheet">
            <div className="c1-doc">
              <h1>Q2 build report</h1>

              <p className="c1-para" data-author="user">
                We shipped v0.11.0 on May 11 — three weeks behind the v2 design handoff and
                with three deliberate divergences from the spec.{' '}
                <span className="c1-anno comment">
                  Engineering surfaced seven decisions that the handoff punted on
                </span>
                , and the team is asking for clearer rules of engagement before v0.12.0.
              </p>

              <h2>What landed</h2>

              <p className="c1-para" data-author="claude">
                The merged titlebar (PR #602) collapses brand, doc tabs, mode toggle and
                chrome into one 44px draggable strip{' '}
                <span className="c1-anno comment active">
                  which feels tight on Windows once you add the system controls
                </span>
                . Solo→Tandem transition got a real heldInSolo banner. Scratchpads (Ctrl+N)
                now mark their ephemeral state in the tab.
              </p>

              <p className="c1-para" data-author="user">
                Character-level authorship shipped with a denser tint than the design called
                for — a side-by-side review with the original spec is in the rail.{' '}
                <span className="c1-anno comment">
                  Two of the legacy highlight keys (red, purple) were remapped without a
                  migration note
                </span>
                ; users with existing docs from v0.10 are seeing{' '}
                <span className="c1-selected">the wrong colors</span>.
              </p>

              {/* Floating mini-toolbar over the selected text "the wrong colors" */}
              <div className="c1-mini" style={{ left: 222, top: 512 }}>
                <button className="c1-mini-btn"><strong>B</strong></button>
                <button className="c1-mini-btn"><em>I</em></button>
                <button className="c1-mini-btn"><span style={{ textDecoration: 'line-through' }}>S</span></button>
                <button className="c1-mini-btn" style={{ fontFamily: 'var(--font-mono)' }}>{'</>'}</button>
                <div className="c1-mini-divider" />
                <div style={{ display: 'inline-flex', gap: 4, padding: '0 4px' }}>
                  <span className="c1-mini-sw" style={{ background: 'oklch(from var(--warning) l c h / 0.45)' }} />
                  <span className="c1-mini-sw" style={{ background: 'oklch(from var(--success) l c h / 0.45)' }} />
                  <span className="c1-mini-sw" style={{ background: 'oklch(from var(--author-user) l c h / 0.45)' }} />
                  <span className="c1-mini-sw" style={{ background: 'oklch(from var(--author-claude) l c h / 0.45)' }} />
                </div>
                <div className="c1-mini-divider" />
                <button className="c1-mini-btn accent">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 8h10M8 3v10" /></svg>
                  Note
                </button>
                <button className="c1-mini-btn">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 4l5 5 5-5" /></svg>
                </button>
              </div>

              <h2>What's next</h2>

              <p className="c1-para" data-author="claude">
                v0.12.0 picks up Document Groups, diff hunk staging with focus-trapped
                keyboard handling, and the Chat empty state. The speculative artboards in
                section F lay these out — confidence is labeled on each.
              </p>
            </div>
          </div>
        </div>

        {/* Rail — anchor-aligned cards */}
        <div className="c1-rail">
          <div className="c1-rail-head">
            <span className="on">Annotations <span className="count">4</span></span>
            <span>Chat <span className="count">2</span></span>
            <span>Outline</span>
          </div>

          <div className="c1-cards">

            {/* aligned to the "comment" anno in para 1 (~top 86px in editor) */}
            <div className="c1-card comment" style={{ top: 0 }}>
              <div className="head">
                <span className="dot c" />
                <span className="who c">Claude</span>
                <span className="kind">comment</span>
                <span className="t">14m</span>
              </div>
              <div className="snip">Engineering surfaced seven decisions that the handoff punted on</div>
              <div className="body">Want me to list them with proposed owners? B-section in the v3 handoff covers five already.</div>
              <div className="actions">
                <span className="primary">Reply</span>
                <span>Resolve</span>
              </div>
            </div>

            {/* aligned to the suggest anno (~top 220px). Marked active to show the
                state where its anchor in the editor is also outlined. */}
            {/* Claude replacement proposal — accept/dismiss */}
            <div className="c1-card replacement active" style={{ top: 168 }}>
              <div className="head">
                <span className="dot c" />
                <span className="who c">Claude</span>
                <span className="kind">replacement</span>
                <span className="t">8m</span>
              </div>
              <div className="snip">which feels tight on Windows once you add the system controls</div>
              <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '5px 8px', borderRadius: 6, background: 'oklch(0 0 0 / 0.04)', marginBottom: 4 }}>
                <span style={{ textDecoration: 'line-through', color: 'var(--error)', marginRight: 6 }}>44px draggable strip</span>
                <span style={{ color: 'var(--success)' }}>collapsing toolbar pill</span>
              </div>
              <div className="body" style={{ fontSize: 12, color: 'var(--c1-ink-muted)' }}>Collapses to a popover under 920px. Saves 4px at standard width.</div>
              <div className="actions"><span className="primary">Accept</span><span>Dismiss</span></div>
            </div>

            {/* User's private note to self */}
            <div className="c1-card note" style={{ top: 350 }}>
              <div className="head">
                <span className="dot u" />
                <span className="who u">You</span>
                <span className="kind">note</span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 99, background: 'oklch(from var(--warning) l c h / 0.25)', color: 'oklch(from var(--warning) calc(l - 0.18) c h)', fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Private</span>
                <span className="t">2m</span>
              </div>
              <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
              <div className="body">Migration note in changelog + first-open toast for upgraded docs.</div>
              <div className="actions"><span className="primary">Send to Claude</span><span>Remove</span></div>
            </div>

            <div className="c1-card comment" style={{ top: 512 }}>
              <div className="head">
                <span className="dot c" />
                <span className="who c">Claude</span>
                <span className="kind">comment</span>
                <span className="t">22m</span>
              </div>
              <div className="snip">three deliberate divergences from the spec</div>
              <div className="body">All three documented in v3 handoff — intentional and logged.</div>
              <div className="actions"><span className="primary">Accept</span><span>Dismiss</span></div>
            </div>

          </div>
        </div>
      </div>

      {/* ── Status (from A — plain mono labels on the canvas) ────── */}
      <div className="c1-status">
        <span><span className="sb-dot" />connected</span>
        <span>tandem · Claude reading</span>
        <span>solo: 0 held</span>
        <div className="right">
          <span>md · UTF-8</span>
          <span>ln 14, col 38</span>
          <span>1,840 words</span>
        </div>
      </div>
    </div>
  );
}

/* ── Detail view: zoom-in on the card↔anchor connection ─────────── */
function CalmV1Detail() {
  return (
    <div className="c1-frame" style={{ gridTemplateRows: '1fr', background: 'oklch(0.94 0.012 70)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 22, padding: '28px 26px', alignItems: 'start' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--c1-ink-faint)' }}>
            Card · anchor connection
          </div>
          <div className="c1-sheet" style={{ padding: '34px 44px 40px' }}>
            <div className="c1-doc" style={{ fontSize: 16 }}>
              <p className="c1-para" data-author="claude">
                The merged titlebar collapses brand, doc tabs, mode toggle and chrome
                into one 44px draggable strip{' '}
                <span className="c1-anno comment active" id="c1-detail-anchor">
                  which feels tight on Windows once you add the system controls
                </span>
                . Solo→Tandem got a real heldInSolo banner.
              </p>
              <p className="c1-para" data-author="user">
                Character-level authorship shipped with a denser tint than the design
                called for.
              </p>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--c1-ink-muted)', maxWidth: 520, lineHeight: 1.55 }}>
            The active card shares the replacement tint (violet) of the anchor; a
            thin leader gradient on hover or selection connects them. No 1px border anywhere
            on either side — only tone, weight, and shape.
          </div>
        </div>

        <div style={{ position: 'relative', minHeight: 280 }}>
          <div className="c1-rail-head" style={{ paddingTop: 8 }}>
            <span className="on">Annotations</span>
          </div>
          <div className="c1-card replacement active" style={{ position: 'relative', left: 0, right: 0, marginTop: 14 }}>
            <div className="head">
              <span className="dot c" />
              <span className="who c">Claude</span>
              <span className="kind">replacement</span>
              <span className="t">8m</span>
            </div>
            <div className="snip">which feels tight on Windows once you add the system controls</div>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '5px 8px', borderRadius: 6, background: 'oklch(0 0 0 / 0.04)', marginBottom: 4 }}>
              <span style={{ textDecoration: 'line-through', color: 'var(--error)', marginRight: 6 }}>44px draggable strip</span>
              <span style={{ color: 'var(--success)' }}>collapsing toolbar pill</span>
            </div>
            <div className="actions"><span className="primary">Accept</span><span>Dismiss</span></div>
          </div>
          {/* leader line — visible because the card is active */}
          <div className="c1-leader-line" style={{
            top: 90, left: -22, width: 24,
            '--c1-leader': 'oklch(from var(--suggestion) l c h / 0.6)',
          }} />
        </div>

      </div>
    </div>
  );
}

Object.assign(window, { CalmV1Synthesis, CalmV1Detail });
