/* v3-chrome.jsx — A1, A2, A3 chrome & authorship artboards
   Loaded after app.jsx; references Icon, WinControls, TopToolbar,
   DocTabs, FormattingBar, EditorBody, SideRail, StatusBar, ANNOS, CHAT
   which are all global from earlier script tags.
*/

// ── CSS injection ───────────────────────────────────────────────────────────
(function() {
  if (document.getElementById('v3-chrome-styles')) return;
  const s = document.createElement('style');
  s.id = 'v3-chrome-styles';
  s.textContent = `
    /* A1 — Refined character-level authorship
       Shipped uses: color-mix(in srgb, author 58%/64%, fg) — dense in long passages.
       Proposed: ~25% text tint (subtle pattern) + stronger hover reveal.
       color-mix() fallback is rgba for older WebView2 on Win10 (Chromium <111).
    */
    .v3c-auth { border-radius: 2px; transition: background 140ms, color 140ms; }
    .v3c-auth[data-tandem-author="user"] {
      color: rgba(68, 90, 160, 0.82);
      color: color-mix(in srgb, var(--tandem-author-user, oklch(0.55 0.14 245)) 28%, var(--ink, oklch(0.22 0.012 280)));
    }
    .v3c-auth[data-tandem-author="claude"] {
      color: rgba(160, 88, 52, 0.82);
      color: color-mix(in srgb, #D97757 32%, var(--ink, oklch(0.22 0.012 280)));
    }
    .v3c-auth[data-tandem-author="user"]:hover {
      background: rgba(91, 91, 214, 0.10);
      background: color-mix(in oklch, var(--author-user, oklch(0.55 0.14 245)) 10%, transparent);
    }
    .v3c-auth[data-tandem-author="claude"]:hover {
      background: rgba(217, 119, 87, 0.12);
      background: color-mix(in oklch, #D97757 12%, transparent);
    }

    /* Hover-reveal author chip */
    .v3c-auth { position: relative; cursor: default; }
    .v3c-chip {
      display: none;
      position: absolute;
      bottom: calc(100% + 5px);
      left: 0;
      background: oklch(0.18 0.012 270);
      color: oklch(0.94 0.005 80);
      font-family: var(--font-sans, 'Inter Tight', sans-serif);
      font-size: 10.5px;
      font-weight: 500;
      padding: 3px 8px;
      border-radius: 4px;
      white-space: nowrap;
      pointer-events: none;
      z-index: 80;
      gap: 5px;
      align-items: center;
      box-shadow: 0 3px 10px rgba(0,0,0,0.22);
    }
    .v3c-chip-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block;
    }
    .v3c-auth:hover .v3c-chip { display: inline-flex; }

    /* A1 — Legend panel */
    .v3c-legend {
      display: flex; gap: 14px; align-items: center;
      padding: 8px 14px;
      background: var(--surface-muted, oklch(0.975 0.005 80));
      border-top: 1px solid var(--hair, oklch(0.92 0.005 280));
      font-size: 11px;
      font-family: var(--font-sans, 'Inter Tight', sans-serif);
      color: var(--ink-muted, oklch(0.48 0.008 280));
    }
    .v3c-legend-item { display: flex; align-items: center; gap: 6px; }
    .v3c-legend-swatch {
      width: 28px; height: 10px; border-radius: 2px;
    }

    /* A2 — Formatting strip above selection */
    .v3-fmt-strip {
      position: absolute;
      display: inline-flex;
      align-items: center;
      gap: 1px;
      background: var(--surface, white);
      border: 1px solid var(--hair, oklch(0.92 0.005 280));
      border-radius: 6px;
      padding: 3px;
      box-shadow: 0 2px 8px rgba(20,20,30,0.10), 0 1px 2px rgba(20,20,30,0.04);
      z-index: 51;
      pointer-events: none;
    }
    .v3-fmt-btn {
      height: 26px; min-width: 26px; padding: 0 6px;
      border: none; background: transparent; border-radius: 3px;
      font-size: 12px; font-weight: 500;
      color: var(--ink, oklch(0.22 0.012 280)); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      font-family: var(--font-sans, 'Inter Tight', sans-serif);
    }
    .v3-callout-tag {
      position: absolute;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9px; letter-spacing: 0.04em;
      padding: 2px 7px; border-radius: 3px; white-space: nowrap;
      pointer-events: none; z-index: 200;
    }

    /* A3 — Merged titlebar with inline tabs */
    .v3-tb { padding: 0 !important; gap: 0 !important; height: var(--h-toolbar, 44px) !important; }
    .v3-title-tabs {
      display: flex; align-items: stretch; height: 100%;
      overflow: hidden; flex: 1; min-width: 0;
    }
    .v3-ttab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 0 11px; height: 100%;
      font-size: 12px; color: var(--ink-subtle, oklch(0.68 0.006 280));
      cursor: pointer; white-space: nowrap; flex-shrink: 0;
      border-right: 1px solid var(--hair, oklch(0.92 0.005 280));
      border-bottom: 2px solid transparent;
      font-family: var(--font-sans, 'Inter Tight', sans-serif);
      -webkit-app-region: no-drag;
    }
    .v3-ttab.on {
      color: var(--ink, oklch(0.22 0.012 280));
      background: var(--bg, oklch(0.985 0.004 80));
      border-bottom-color: var(--accent, oklch(0.52 0.16 275));
    }
    .v3-ttab-ext {
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: 9px; color: var(--ink-faint, oklch(0.82 0.005 280));
      background: var(--surface-sunk, oklch(0.96 0.006 80));
      border: 1px solid var(--hair, oklch(0.92 0.005 280));
      border-radius: 3px; padding: 0 4px;
    }
    .v3-ttab.on .v3-ttab-ext { color: var(--accent, oklch(0.52 0.16 275)); border-color: var(--accent-border, oklch(0.85 0.06 275)); background: var(--accent-soft, oklch(0.95 0.03 275)); }
    .v3-ttab-x { width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center; opacity: 0; color: var(--ink-faint); border-radius: 2px; }
    .v3-ttab:hover .v3-ttab-x { opacity: 1; }
    .v3-tabadd {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 100%; flex-shrink: 0;
      color: var(--ink-faint, oklch(0.82 0.005 280));
      border-right: 1px solid var(--hair, oklch(0.92 0.005 280));
      cursor: pointer; -webkit-app-region: no-drag;
    }
    .v3-tabadd:hover { color: var(--ink); background: var(--surface-muted); }
  `;
  document.head.appendChild(s);
})();

// ── Shared helper: annotation callout badge ──────────────────────────────────
function V3CalloutTag({ children, color = 'oklch(0.52 0.16 275)', style = {} }) {
  return (
    <div className="v3-callout-tag" style={{
      background: color,
      color: 'white',
      ...style,
    }}>{children}</div>
  );
}

// ── A1: Refined character-level authorship body ─────────────────────────────
function V3EditorBodyCharAuth() {
  const chip = (color, dot, name) => (
    <span className="v3c-chip">
      <span className="v3c-chip-dot" style={{ background: dot }} />
      {name}
    </span>
  );
  return (
    <div className="editor-wrap">
      <div className="editor-scroll">
        <div className="editor-doc">
          <h1>RFC-007 — Read Layer Design</h1>

          <p className="para" style={{ paddingLeft: 0 }}>
            <span className="v3c-auth" data-tandem-author="user">
              The existing reporting API cannot power dashboard widgets at scale.{chip('user','var(--author-user)','Bryan · 2m ago')}
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="claude">
              Aggregation queries hit a hard ceiling at ~1,000 concurrent users under the current schema design.{chip('claude','#D97757','Claude · 4m ago')}
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="user">
              We need a dedicated read layer before the dashboard can ship in Q3.{chip('user','var(--author-user)','Bryan · 2m ago')}
            </span>
          </p>

          <h2>Proposed architecture</h2>

          <p className="para" style={{ paddingLeft: 0 }}>
            <span className="v3c-auth" data-tandem-author="claude">
              A denormalized warehouse table, updated on every write, serves as the read source for all dashboard queries.{chip('claude','#D97757','Claude · 4m ago')}
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="user">
              The write path is unchanged; only the read path is new.{chip('user','var(--author-user)','Bryan · 1m ago')}
            </span>
          </p>

          <h2>Trade-offs</h2>

          <p className="para" style={{ paddingLeft: 0 }}>
            <span className="v3c-auth" data-tandem-author="user">
              Eventual consistency (write → warehouse lag ~800ms) is acceptable for dashboard use cases,{chip('user','var(--author-user)','Bryan · 1m ago')}
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="claude" style={{ position: 'relative' }}>
              but may require cache invalidation logic for the invoicing module.
              {/* Hover state simulated open for demo */}
              <span className="v3c-chip" style={{ display: 'inline-flex', left: '20%' }}>
                <span className="v3c-chip-dot" style={{ background: '#D97757' }} />
                Claude · wrote 4m ago
              </span>
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="user">
              The admin console and billing views can reuse the same layer.{chip('user','var(--author-user)','Bryan · 1m ago')}
            </span>
          </p>

          <p className="para" style={{ paddingLeft: 0 }}>
            <span className="v3c-auth" data-tandem-author="claude">
              We estimate a two-week implementation window with no regression risk to the existing write path.{chip('claude','#D97757','Claude · 4m ago')}
            </span>
            {' '}
            <span className="v3c-auth" data-tandem-author="user">
              I can schedule the read-layer work as the first item in Q3 sprint planning.{chip('user','var(--author-user)','Bryan · 1m ago')}
            </span>
          </p>
        </div>
      </div>

      {/* Legend strip at bottom of editor */}
      <div className="v3c-legend">
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ink-faint)', marginRight: 4 }}>Authorship</span>
        <span className="v3c-legend-item">
          <span className="v3c-legend-swatch" style={{ background: 'color-mix(in srgb, oklch(0.55 0.14 245) 28%, oklch(0.22 0.012 280))', opacity: 0.6 }} />
          You (text tint ~28%)
        </span>
        <span className="v3c-legend-item">
          <span className="v3c-legend-swatch" style={{ background: 'color-mix(in srgb, #D97757 32%, oklch(0.22 0.012 280))', opacity: 0.6 }} />
          Claude (text tint ~32%)
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--ink-faint)' }}>
          Hover any run to reveal author · Toggle: ⌘⇧A · data-tandem-author on inline spans
        </span>
      </div>
    </div>
  );
}

function A1AuthorshipFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
      '--rail-w': '340px',
    }}>
      <TopToolbar docName="rfc-007-readlayer.md" dirty={true} panelLayout="right" theme={theme} mode="tandem" claudeState="reading" />
      <DocTabs docs={[
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },
        { id: 'd2', name: 'q2-dashboard-review.md', ext: 'M' },
      ]} active="d1" />
      <FormattingBar leftVisible={false} rightVisible={true} />
      <div className="main" data-rail="right" style={{ '--h-fmtbar': '0px' }}>
        <V3EditorBodyCharAuth />
        <SideRail mode="annotations" annotations={ANNOS} chat={CHAT} />
      </div>
      <StatusBar claudeState="reading" docName="rfc-007-readlayer.md" dirty={true} />
    </div>
  );
}

// ── A2: Two-tier selection — formatting strip + audience popup ───────────────
function A2DualSurface({ tw = {} }) {
  const theme = tw.theme || 'light';
  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
    }}>
      <TopToolbar docName="q2-dashboard-review.md" dirty={true} panelLayout="hidden" theme={theme} mode="tandem" claudeState="idle" />
      <DocTabs docs={[{ id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true }]} active="d1" />
      <FormattingBar leftVisible={false} rightVisible={false} />
      <div className="main" data-rail="hidden">
        <div className="editor-wrap" style={{ overflow: 'visible', position: 'relative' }}>
          <div className="editor-scroll" style={{ paddingTop: 56, paddingBottom: 280 }}>
            <div className="editor-doc" style={{ maxWidth: 760, margin: '0 auto', position: 'relative' }}>
              <h1>Q2 Progress Review</h1>
              <p className="para" style={{ paddingLeft: 0, lineHeight: 1.65, position: 'relative' }}>
                The project launched in early 2025 with three core goals: simplify onboarding, reduce support tickets by 40%, and ship a self-service dashboard by Q3. The team completed the first two milestones ahead of schedule, but{' '}
                {/* Selected text */}
                <span style={{
                  background: 'oklch(0.85 0.10 245 / 0.35)',
                  borderRadius: 2,
                  padding: '1px 0',
                  outline: '1.5px solid oklch(0.72 0.13 245 / 0.5)',
                  outlineOffset: 1,
                  position: 'relative',
                }}>the dashboard timeline slipped due to an unexpected API redesign</span>
                {' '}in May.

                {/* ① Formatting strip — ABOVE selection */}
                <div className="v3-fmt-strip" style={{ bottom: 'calc(100% + 10px)', left: '38%', transform: 'translateX(-10%)' }}>
                  <button className="v3-fmt-btn" style={{ fontWeight: 700 }}>B</button>
                  <button className="v3-fmt-btn" style={{ fontStyle: 'italic' }}>I</button>
                  <button className="v3-fmt-btn" style={{ textDecoration: 'line-through', fontSize: 11 }}>S</button>
                  <div style={{ width: 1, height: 14, background: 'var(--hair)', margin: '0 2px' }} />
                  <button className="v3-fmt-btn" style={{ fontWeight: 600, fontSize: 11 }}>H ▾</button>
                  <div style={{ width: 1, height: 14, background: 'var(--hair)', margin: '0 2px' }} />
                  <button className="v3-fmt-btn">
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5L8 4.5"/><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5L8 11.5"/>
                    </svg>
                  </button>
                  {/* ① label */}
                  <span style={{
                    position: 'absolute', top: -22, left: 0,
                    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.04em',
                    background: 'oklch(0.55 0.14 245)', color: 'white',
                    padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap',
                  }}>① BubbleMenu — B/I/S/H/link only · transform text</span>
                </div>

                {/* ② Audience popup — BELOW selection */}
                <div className="ar-pop" style={{
                  position: 'absolute',
                  top: 'calc(100% + 8px)',
                  left: '38%',
                  transform: 'translateX(-10%)',
                  zIndex: 52,
                }}>
                  <div className="ar-pop-arrow" style={{ top: -5, bottom: 'unset', transform: 'rotate(180deg) translateX(50%)' }} />
                  <textarea
                    className="ar-pop-textarea"
                    placeholder='"Note to self" — or message Claude…'
                    rows={2}
                    style={{ resize: 'none' }}
                    readOnly
                  />
                  <div className="ar-pop-actions">
                    <div className="ar-pop-swatches">
                      <span className="ar-sw yellow" /><span className="ar-sw green" />
                      <span className="ar-sw blue" /><span className="ar-sw pink" />
                    </div>
                    <div className="ar-pop-spacer" />
                    <button className="ar-btn ar-btn-note">Note to self <span className="ar-kbd">⏎</span></button>
                    <button className="ar-btn ar-btn-comment">Send to Claude <span className="ar-kbd">⌘⏎</span></button>
                  </div>
                  {/* ② label */}
                  <span style={{
                    position: 'absolute', bottom: -22, right: 0,
                    fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.04em',
                    background: 'oklch(0.52 0.18 25)', color: 'white',
                    padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap',
                  }}>② ARPopup — annotation creation · audience choice · peers, not alternatives</span>
                </div>

              </p>
            </div>
          </div>

          {/* Side annotation */}
          <div style={{
            position: 'absolute', right: 24, top: '50%', transform: 'translateY(-50%)',
            background: 'var(--surface)', border: '1px solid var(--hair)',
            borderRadius: 8, padding: '12px 14px', maxWidth: 240,
            fontSize: 12, lineHeight: 1.5, color: 'var(--ink-muted)',
            boxShadow: 'var(--shadow-card)',
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 6 }}>A2 — What changed</div>
            <p style={{ margin: '0 0 6px' }}><strong style={{ color: 'var(--ink)' }}>Two peers, not one strip.</strong> The formatting bar and annotation popup are separate concerns sharing the same selection event.</p>
            <p style={{ margin: 0 }}>z-index: strip = 51, popup = 52. When both are visible, popup wins overlap. Popup suppresses when slash menu or find bar is active.</p>
          </div>
        </div>
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true} />
    </div>
  );
}

// ── A3: Merged titlebar (brand · tabs · controls in one 44px strip) ──────────
function V3TitleBar({ docs = [], activeDoc, mode = 'tandem', onMode, theme = 'light', onTheme, claudeState = 'reading', platform = 'mac' }) {
  return (
    <div className="toolbar titlebar v3-tb plat-mac" data-tauri-drag-region style={{ display: 'flex', alignItems: 'stretch' }}>
      {platform === 'mac' && (
        <div className="winctl mac" data-no-drag style={{ padding: '0 10px 0 8px', alignSelf: 'center' }}>
          <button className="wc close"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 1l4 4M5 1l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
          <button className="wc min"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 3h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
          <button className="wc max"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1.5 1.5h3v3h-3z" fill="none" stroke="currentColor" strokeWidth="1.1"/></svg></button>
        </div>
      )}

      {/* Brand */}
      <div className="brand" data-no-drag style={{ borderRight: '1px solid var(--hair)', height: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px 0 4px', flexShrink: 0 }}>
        <span className="mark"><img src="logo.png" alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} /></span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>Tandem</span>
      </div>

      {/* Inline tabs */}
      <div className="v3-title-tabs" data-no-drag>
        {docs.map(d => (
          <div key={d.id} className={`v3-ttab${d.id === activeDoc ? ' on' : ''}`}>
            <span className="v3-ttab-ext">{d.ext}</span>
            <span style={{ fontWeight: 500, fontSize: 12 }}>{d.name}</span>
            {d.dirty && <span className="dirty" />}
            <span className="v3-ttab-x"><svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l6 6M7 1l-6 6"/></svg></span>
          </div>
        ))}
        <div className="v3-tabadd" title="New document (⌘N)">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M6 1v10M1 6h10"/></svg>
        </div>
      </div>

      {/* Drag region */}
      <div style={{ flex: 1, minWidth: 20 }} />

      {/* Mode toggle */}
      <div className="seg" data-no-drag style={{ alignSelf: 'center', marginRight: 8 }}>
        <button className={mode === 'solo' ? 'on' : ''}>Solo</button>
        <button className={mode === 'tandem' ? 'on' : ''}>Tandem</button>
      </div>

      {/* Claude dot */}
      <span className={`claude-pulse${claudeState === 'idle' ? ' idle' : ''}`} style={{ marginRight: 10, alignSelf: 'center' }} data-no-drag />
      <div className="tb-divider" style={{ alignSelf: 'center', margin: '0 4px 0 0', flexShrink: 0 }} />

      {/* Chrome buttons */}
      <button className="tb-icon-btn" title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} onClick={() => onTheme?.()} data-no-drag style={{ alignSelf: 'center' }}>
        <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
      </button>
      <button className="tb-icon-btn" title="Keyboard shortcuts ⌘/" data-no-drag style={{ alignSelf: 'center' }}>
        <Icon name="help" size={14} />
      </button>
      <button className="tb-icon-btn" title="Settings ⌘," data-no-drag style={{ alignSelf: 'center' }}>
        <Icon name="settings" size={14} />
      </button>

      {platform !== 'mac' && <WinControls platform="win" />}
    </div>
  );
}

function A3TitlebarFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  const docs = [
    { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M', dirty: true },
    { id: 'd2', name: 'q2-dashboard-review.md', ext: 'M' },
    { id: 'd3', name: 'q2-board-memo.docx', ext: 'W' },
  ];
  return (
    <div data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      display: 'grid',
      gridTemplateRows: '44px 36px 1fr 26px',
      height: '100%',
      background: 'var(--bg)',
      color: 'var(--ink)',
      overflow: 'hidden',
      '--editor-font': 'var(--font-serif)',
      '--rail-w': '340px',
    }}>
      {/* ① Merged TitleBar — annotation */}
      <div style={{ position: 'relative' }}>
        <V3TitleBar docs={docs} activeDoc="d1" mode="tandem" theme={theme} claudeState="reading" platform="mac" />
        <div className="v3-callout-tag" style={{
          background: 'oklch(0.52 0.16 275)', color: 'white',
          bottom: 4, left: '50%', transform: 'translateX(-50%)',
          border: '1px solid oklch(0.42 0.18 275)',
        }}>
          ① TitleBar.svelte — brand · doc tabs · mode toggle · theme · settings · window controls · all in one draggable strip (PR #602)
        </div>
      </div>

      {/* ② Formatting toolbar — annotation */}
      <div style={{ position: 'relative' }}>
        <FormattingBar leftVisible={false} rightVisible={true} />
        <div className="v3-callout-tag" style={{
          background: 'oklch(0.55 0.14 150)', color: 'white',
          bottom: 4, left: '50%', transform: 'translateX(-50%)',
        }}>
          ② FormattingBar.svelte — formatting only · separate from titlebar · appears when editor has focus
        </div>
      </div>

      {/* Main */}
      <div className="main" data-rail="right">
        <EditorBody showMini={false} showCursor={true} />
        <SideRail mode="annotations" annotations={ANNOS} chat={CHAT} />
      </div>

      {/* Status */}
      <StatusBar claudeState="reading" docName="rfc-007-readlayer.md" dirty={true} />
    </div>
  );
}

Object.assign(window, {
  A1AuthorshipFrame,
  A2DualSurface,
  A3TitlebarFrame,
  V3TitleBar,
  V3EditorBodyCharAuth,
});
