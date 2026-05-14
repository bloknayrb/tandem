/* v3-surfaces.jsx — C1–C7: new surfaces that shipped in v0.11.0 with no artboard */

// ── C1: Changelog on upgrade ─────────────────────────────────────────────────
function C1ChangelogFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
    }}>
      <TopToolbar docName="v0.11.1 Release Notes" dirty={false} panelLayout="hidden" theme={theme} mode="tandem" claudeState="idle" />
      <DocTabs docs={[
        { id: 'cl', name: 'v0.11.1 Release Notes', ext: '★' },
        { id: 'd1', name: 'rfc-007-readlayer.md', ext: 'M' },
      ]} active="cl" />
      <FormattingBar leftVisible={false} rightVisible={false} />
      <div className="main" data-rail="hidden">
        <div className="editor-wrap">

          {/* Upgrade banner — distinct from read-only doc banner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 20px',
            background: 'var(--accent-soft)',
            borderBottom: '1px solid var(--accent-border)',
            fontSize: 13, flexShrink: 0,
          }}>
            <div style={{
              width: 30, height: 30, background: 'var(--accent)', borderRadius: 7,
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3v5l3 3"/><circle cx="8" cy="8" r="6"/>
              </svg>
            </div>
            <div style={{ flex: 1 }}>
              <strong style={{ color: 'var(--ink)' }}>Tandem updated to v0.11.1</strong>
              <span style={{ color: 'var(--ink-muted)', marginLeft: 10, fontSize: 12 }}>
                Read-only · opened automatically on first launch after upgrade · not saved to history
              </span>
            </div>
            <button className="btn-ghost" style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
              Don't show again
            </button>
            <button className="btn-primary" style={{ padding: '0 16px', height: 28, fontSize: 12 }}>
              Got it
            </button>
          </div>

          <div className="editor-scroll">
            <div className="editor-doc">
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-faint)', margin: '0 0 1em' }}>Released 2026-05-13 · v0.11.1</p>
              <h1 style={{ marginTop: 0 }}>What's new</h1>

              <h2>Settings sidebar redesign</h2>
              <p className="para" style={{ paddingLeft: 0 }}>Each navigation item now has an inline icon. The sidebar header shows a live version chip. A new persistent footer surfaces Changelog, Report a bug, and MCP connection status from every section.</p>

              <h2>Single titlebar — all app chrome unified</h2>
              <p className="para" style={{ paddingLeft: 0 }}>Brand, document tabs, mode toggle, Claude dot, panel controls, theme, help, and settings now live in one draggable titlebar strip. The secondary toolbar row is removed. Comment and Note actions live exclusively in the floating selection popup.</p>

              <h2>CHANGELOG no longer rewritten on upgrade</h2>
              <p className="para" style={{ paddingLeft: 0 }}>The auto-open on upgrade now passes <code>readOnly: true</code>. Autosave skips read-only documents, so your CHANGELOG is no longer quietly mutated by remark-stringify's backslash-escape defaults.</p>

              <h2>Tutorial annotation anchors fixed</h2>
              <p className="para" style={{ paddingLeft: 0 }}>Two tutorial annotations in <code>welcome.md</code> were silently failing since March 2026 because the welcome copy changed and the <code>targetText</code> anchors didn't. Re-anchored to phrases that currently exist in the file (each occurring exactly once).</p>

              <p style={{ marginTop: '2em', paddingTop: '1em', borderTop: '1px solid var(--hair)', fontSize: 13, color: 'var(--ink-muted)' }}>
                Full changelog: <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Settings → Changelog</span> · Report issues: <span style={{ color: 'var(--accent)', fontWeight: 500 }}>Settings → Report a bug</span>
              </p>
            </div>
          </div>
        </div>
      </div>
      <StatusBar claudeState="idle" docName="v0.11.1 Release Notes" dirty={false} />
    </div>
  );
}

// ── C2: Scratchpad (Ctrl+N / tandem_scratchpad) ──────────────────────────────
function C2ScratchpadFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
      '--editor-font': 'var(--font-serif)',
      '--rail-w': '320px',
    }}>
      <TopToolbar docName="Scratchpad" dirty={false} panelLayout="right" theme={theme} mode="tandem" claudeState="idle" />

      {/* Tab row — scratchpad tab uses ~ prefix, no .md ext badge */}
      <div className="tabs">
        <div className="tab active" style={{ color: 'var(--ink)', borderBottomColor: 'var(--accent)' }}>
          {/* Ephemeral indicator: dashed circle instead of file ext */}
          <span style={{
            width: 14, height: 14, borderRadius: '50%',
            border: '1.5px dashed var(--ink-faint)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="6" height="6" viewBox="0 0 8 8" fill="none" stroke="var(--ink-faint)" strokeWidth="1.5">
              <path d="M4 1v3l2 2"/>
            </svg>
          </span>
          <span style={{ fontWeight: 500 }}>Scratchpad</span>
          <span className="x"><Icon name="x" size={10} stroke={1.8} /></span>
        </div>
        <div className="tab">
          <span className="ext">M</span>
          <span>rfc-007-readlayer.md</span>
          <span className="x"><Icon name="x" size={10} stroke={1.8} /></span>
        </div>
        <div className="grow" />
        <div className="tab-add"><Icon name="plus" size={12} /></div>
      </div>

      <FormattingBar leftVisible={false} rightVisible={true} />
      <div className="main" data-rail="right">
        <div className="editor-wrap">

          {/* Ephemeral notice bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '6px 16px',
            background: 'var(--surface-2)',
            borderBottom: '1px solid var(--hair)',
            fontSize: 12, color: 'var(--ink-muted)', flexShrink: 0,
          }}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="var(--ink-faint)" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 2h8l2 2v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4l2-2z"/>
              <path d="M7 6v3"/><circle cx="7" cy="11" r="0.5" fill="var(--ink-faint)"/>
            </svg>
            <span>
              <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Ephemeral</strong> — not written to disk. Content is lost when the tab closes.
            </span>
            <button className="btn-ghost" style={{ fontSize: 11, height: 22, padding: '0 8px' }}>
              Save As… <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-faint)' }}>⌘⇧S</span>
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--ink-faint)' }}>upload:// · in-memory · no path</span>
          </div>

          <div className="editor-scroll">
            <div className="editor-doc" style={{ position: 'relative' }}>
              <h1 style={{ color: 'var(--ink-faint)', fontWeight: 400 }}>Scratchpad</h1>
              <p className="para" style={{ paddingLeft: 0 }}>
                <span data-tandem-author="user">
                  Quick draft — gut-checking the read-layer approach before writing the RFC properly. The eventual consistency window (~800ms) feels acceptable for dashboards but I want to verify with the invoicing team before committing.
                </span>
              </p>
              <p className="para" style={{ paddingLeft: 0 }}>
                <span data-tandem-author="user">Questions for tomorrow's sync:</span>
              </p>
              <ul style={{ paddingLeft: '1.4em', margin: '0 0 1em' }}>
                <li>P99 warehouse write latency under current production load?</li>
                <li>Does invoicing have a cache invalidation hook we can subscribe to?</li>
                <li>What's the rollback path if the read layer adds >200ms to dashboard load?</li>
              </ul>
              <p style={{ color: 'var(--ink-faint)', fontFamily: 'var(--editor-font)', fontSize: 'var(--editor-size)' }}>
                Start writing, or press <code>/</code> for blocks…
              </p>
            </div>
          </div>
        </div>
        <SideRail mode="annotations" annotations={ANNOS.slice(0,2)} chat={CHAT} />
      </div>
      <StatusBar claudeState="idle" docName="Scratchpad" dirty={false} />
    </div>
  );
}

// ── C3: Store-readonly banner close-up ───────────────────────────────────────
function C3StoreReadonlySpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const warn = 'oklch(0.62 0.16 65)';
  const warnSoft = 'oklch(0.97 0.04 75)';
  const warnBorder = 'oklch(0.88 0.08 65)';
  const err = 'oklch(0.55 0.18 25)';
  const errSoft = 'oklch(0.97 0.03 25)';

  function Banner({ severity = 'warning', dismissed = false }) {
    const isErr = severity === 'error';
    const bg = isErr ? errSoft : warnSoft;
    const border = isErr ? 'oklch(0.86 0.10 25)' : warnBorder;
    const accent = isErr ? err : warn;
    const icon = isErr ? '✕' : '⚠';
    const title = isErr ? 'Annotation store unwritable' : 'Annotations saving in reduced mode';
    const body = isErr
      ? 'The annotation store cannot be opened (permissions error). Your annotations exist in memory but will be lost on close.'
      : 'The annotation store is read-only (disk full or permissions). New annotations are buffered in memory.';
    return (
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '10px 14px', borderRadius: 8,
        background: bg, border: `1px solid ${border}`,
        fontFamily: 'Inter Tight, sans-serif',
        opacity: dismissed ? 0.4 : 1,
      }}>
        <span style={{ fontSize: 14, color: accent, flexShrink: 0, marginTop: 1 }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 12.5, color: ink, marginBottom: 3 }}>{title}</div>
          <div style={{ fontSize: 12, color: muted, lineHeight: 1.5 }}>{body}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button style={{ height: 24, padding: '0 10px', border: `1px solid ${border}`, background: 'transparent', borderRadius: 4, fontSize: 11, color: muted, cursor: 'pointer', fontFamily: 'inherit' }}>Retry</button>
            <button style={{ height: 24, padding: '0 10px', border: `1px solid ${border}`, background: 'transparent', borderRadius: 4, fontSize: 11, color: muted, cursor: 'pointer', fontFamily: 'inherit' }}>Open Settings</button>
            <button style={{ height: 24, padding: '0 10px', border: 'none', background: 'transparent', borderRadius: 4, fontSize: 11, color: muted, cursor: 'pointer', fontFamily: 'inherit' }}>View logs</button>
          </div>
        </div>
        {!dismissed && <button style={{ border: 'none', background: 'transparent', color: muted, cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 40, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.18 25)', marginBottom: 4 }}>C3 — store-readonly-banner</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Store read-only warning</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>Appears in the annotation rail when the durable store cannot be written. Two severity tiers; not auto-dismissed.</p>
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Warning — disk full or permissions (recoverable)</div>
          <Banner severity="warning" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Error — store cannot open (action required)</div>
          <Banner severity="error" />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: '16px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <div><strong style={{ color: ink }}>Dismiss behavior:</strong> Warning is dismissible (× button). Dismissed state persists in localStorage. Error is persistent — requires Retry or Settings action to clear.</div>
        <div><strong style={{ color: ink }}>Placement:</strong> Banner appears at the top of the rail body, above annotation cards. Sits below the held-in-Solo banner if both are active. testid: <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>store-readonly-banner</code></div>
      </div>
    </div>
  );
}

// ── C4: Connection banner — 4 states ─────────────────────────────────────────
function C4ConnStatesSpec({ tw = {} }) {
  const theme = tw.theme || 'light';
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';

  function StateCard({ label, children, note }) {
    return (
      <div style={{ background: 'var(--surface,white)', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden' }}>
        <div style={{ padding: '10px 14px 6px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>{label}</div>
        <div style={{ padding: '0 14px 8px' }}>{children}</div>
        {note && <div style={{ padding: '6px 14px 10px', borderTop: `1px solid ${hair}`, fontSize: 11, color: muted, lineHeight: 1.4 }}>{note}</div>}
      </div>
    );
  }

  // Reuse existing conn-banner style structure
  const BannerBase = ({ bg, border, accent, children }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8,
      background: bg, border: `1px solid ${border}`,
      fontFamily: 'Inter Tight, sans-serif', fontSize: 12.5, color: accent,
    }}>{children}</div>
  );

  return (
    <div data-theme={theme} style={{
      width: '100%', height: '100%',
      background: 'oklch(0.96 0.008 80)',
      padding: 36, display: 'flex', flexDirection: 'column', gap: 24,
      fontFamily: 'Inter Tight, sans-serif',
    }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.62 0.16 65)', marginBottom: 4 }}>C4 — conn-banner · 4 states</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Connection degradation states</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <StateCard label="State 1 (existing) — offline >30s"
          note="Sidecar unreachable >30s. Auto-retry every 30s in background. User edits are buffered locally.">
          <BannerBase bg="var(--warning-soft, oklch(0.97 0.04 75))" border="oklch(0.84 0.10 65)" accent="oklch(0.45 0.16 65)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M1 1l14 14M9.17 9.17A5 5 0 0 0 3 8M12.07 12.07A8 8 0 0 0 0.93 8M16 5a11 11 0 0 0-2.93-2.07M8 16h.01"/></svg>
            <span style={{ flex: 1 }}><strong>Claude offline</strong> — sidecar unreachable. Your edits are saved locally.</span>
            <button className="conn-retry">Retry now</button>
          </BannerBase>
        </StateCard>

        <StateCard label="State 2 — reconnecting (active retry + countdown)"
          note="Auto-retry is in progress. Countdown shows next attempt. Spinner indicates activity.">
          <BannerBase bg="var(--warning-soft, oklch(0.97 0.04 75))" border="oklch(0.84 0.10 65)" accent="oklch(0.45 0.16 65)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'tandem-spin 1s linear infinite' }}>
              <path d="M14 8A6 6 0 0 1 2.27 11.5M2 8a6 6 0 0 1 10.77-3.5"/><path d="M14 5l.5 3M2.5 11l-.5-3"/>
            </svg>
            <span style={{ flex: 1 }}><strong>Reconnecting in 5s…</strong> — auto-retry active.</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, opacity: 0.7 }}>5</span>
            <button className="conn-retry" style={{ opacity: 0.6 }}>Skip wait</button>
          </BannerBase>
        </StateCard>

        <StateCard label="State 3 — connection lost, manual retry"
          note="Auto-retries exhausted (after 5 attempts). User must act. Edits still buffered.">
          <BannerBase bg="var(--error-soft, oklch(0.97 0.03 25))" border="oklch(0.84 0.08 25)" accent="oklch(0.48 0.16 25)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M1 1l14 14M9.17 9.17A5 5 0 0 0 3 8M16 5a11 11 0 0 0-2.93-2.07"/></svg>
            <span style={{ flex: 1 }}><strong>Connection lost</strong> — edits saved locally, not synced.</span>
            <button className="conn-retry">Retry</button>
          </BannerBase>
        </StateCard>

        <StateCard label="State 4 — reconnected (transient success toast, 4s)"
          note="Auto-dismisses after 4s. Appears at top-right as a toast, not in the rail. Severity: success.">
          <BannerBase bg="var(--success-soft, oklch(0.96 0.03 150))" border="oklch(0.82 0.08 150)" accent="oklch(0.42 0.14 150)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8l3.5 3.5L13 5"/></svg>
            <span style={{ flex: 1 }}><strong>Reconnected</strong> — Claude is back online.</span>
            <button style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 15, padding: 0, opacity: 0.6 }}>×</button>
          </BannerBase>
        </StateCard>
      </div>

      <style>{`@keyframes tandem-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── C5: Settings dialog at <860px ────────────────────────────────────────────
function C5NarrowSettingsFrame({ tw = {} }) {
  const theme = tw.theme || 'light';
  const [navOpen, setNavOpen] = React.useState(false);

  return (
    <div data-theme={theme} style={{
      width: '100%', height: '100%',
      background: 'oklch(0.22 0.012 270 / 0.32)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Inter Tight, sans-serif',
    }}>
      {/* Narrow settings dialog — 560px wide */}
      <div style={{
        width: 560, maxHeight: '86vh',
        background: 'var(--surface, white)',
        border: '1px solid var(--hair, oklch(0.92 0.005 280))',
        borderRadius: 12,
        boxShadow: '0 24px 60px oklch(0 0 0 / 0.25)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header with hamburger */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '13px 16px',
          borderBottom: '1px solid var(--hair, oklch(0.92 0.005 280))',
        }}>
          <button
            onClick={() => setNavOpen(!navOpen)}
            style={{ width: 28, height: 28, border: '1px solid var(--hair, oklch(0.92 0.005 280))', background: navOpen ? 'var(--surface-sunk)' : 'transparent', borderRadius: 5, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'center', justifyContent: 'center', padding: 0 }}
          >
            {[0,1,2].map(i => <span key={i} style={{ width: 11, height: 1.5, background: 'var(--ink-muted, oklch(0.48 0.008 280))', borderRadius: 1, display: 'block' }}/>)}
          </button>
          <strong style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            {navOpen ? 'Settings' : 'Settings → Appearance'}
          </strong>
          <div style={{ flex: 1 }} />
          <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-faint)', fontSize: 18, padding: 0 }}>×</button>
        </div>

        {/* Content */}
        {navOpen ? (
          /* Nav overlay — full-column nav */
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
            {['Editor', 'Appearance', 'Accessibility', 'Network', 'About'].map((item, i) => (
              <div key={item} onClick={() => setNavOpen(false)} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 20px',
                cursor: 'pointer',
                background: i === 1 ? 'var(--accent-soft)' : 'transparent',
                color: i === 1 ? 'var(--accent-strong)' : 'var(--ink)',
                fontSize: 14, fontWeight: i === 1 ? 600 : 400,
              }}>
                <span style={{ width: 16, height: 16, display: 'inline-block', background: 'var(--surface-sunk)', borderRadius: 3 }} />
                {item}
                {i === 1 && <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent)', background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', padding: '1px 6px', borderRadius: 3 }}>current</span>}
              </div>
            ))}
          </div>
        ) : (
          /* Settings content — single column */
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ margin: '0 0 12px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-faint)', fontFamily: 'JetBrains Mono, monospace' }}>Appearance</h3>
              {[['Theme', 'System · Light · Dark'], ['Editor font', 'Serif · Sans · Mono'], ['Font size', '16px'], ['Density', 'Cozy']].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--hair)' }}>
                  <span style={{ fontSize: 13, color: 'var(--ink)' }}>{label}</span>
                  <span style={{ fontSize: 12, color: 'var(--ink-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--hair)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
          <button className="btn-primary" style={{ fontSize: 12, padding: '0 16px' }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ── C6: Reply thread — collapsed card state ──────────────────────────────────
function C6ThreadCollapsedSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const userC = 'var(--author-user, oklch(0.55 0.14 245))';
  const claudeC = '#D97757';

  function AvatarStack({ n = 3 }) {
    const cols = [userC, claudeC, 'oklch(0.62 0.12 150)'];
    return (
      <div style={{ display: 'flex', marginLeft: 2 }}>
        {cols.slice(0, n).map((c, i) => (
          <span key={i} style={{
            width: 16, height: 16, borderRadius: '50%',
            background: c, border: '1.5px solid white',
            marginLeft: i > 0 ? -5 : 0, zIndex: n - i,
            display: 'inline-block', flexShrink: 0,
          }} />
        ))}
      </div>
    );
  }

  function CollapsedCard({ replies, snippet, lastAuthor, lastTime, expanded = false }) {
    return (
      <div style={{
        background: 'white', border: `1px solid ${hair}`,
        borderRadius: 8, padding: '10px 12px',
        display: 'flex', flexDirection: 'column', gap: 6,
        cursor: 'pointer',
        borderLeft: `3px solid ${lastAuthor === 'claude' ? claudeC : userC}`,
      }}>
        <div style={{ fontSize: 11.5, fontFamily: 'Source Serif 4, serif', fontStyle: 'italic', color: muted, lineHeight: 1.4 }}>
          "{snippet}"
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AvatarStack n={Math.min(replies, 3)} />
          <span style={{ fontSize: 11.5, fontWeight: 600, color: muted }}>
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </span>
          <span style={{ fontSize: 11, color: 'oklch(0.72 0.006 280)' }}>· {lastTime}</span>
          <div style={{ flex: 1 }} />
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={muted} strokeWidth="1.5" strokeLinecap="round" style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}>
            <path d="M2 4l4 4 4-4"/>
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.16 275)', marginBottom: 4 }}>C6 — thread collapsed card state</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Reply thread — collapsed</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>The card before the user expands it. Avatar stack + reply count + chevron. Left border color = last responder's author color.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>3 replies, Claude replied last</div>
          <CollapsedCard replies={3} snippet="the dashboard timeline slipped due to an unexpected API redesign in May" lastAuthor="claude" lastTime="2m ago" />
        </div>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>1 reply, you replied last</div>
          <CollapsedCard replies={1} snippet="Support volume fell in line with projections" lastAuthor="user" lastTime="just now" />
        </div>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>7 replies · expanded state</div>
          <CollapsedCard replies={7} snippet="Onboarding completion climbed from 34% to 71%" lastAuthor="user" lastTime="5m ago" expanded={true} />
        </div>
        <div style={{ padding: '14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.55 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 6 }}>Interaction spec</strong>
          Click anywhere on collapsed card → expand inline (same card grows). Chevron rotates 180°. Avatar stack: max 3 avatars shown, overlap 5px each. Reply count is always the full count. "just now" threshold: &lt;60s. testid: <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>thread-collapsed</code>
        </div>
      </div>
    </div>
  );
}

// ── C7: Document-level annotation summary ────────────────────────────────────
function C7AnnoSummarySpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const faint = 'oklch(0.68 0.006 280)';
  const userC = 'oklch(0.55 0.14 245)';
  const claudeC = '#D97757';
  const mono = { fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 };

  function SummaryPill({ count, label, color }) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 99,
        background: `color-mix(in oklch, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in oklch, ${color} 25%, transparent)`,
        fontSize: 11, fontWeight: 500, color: ink,
        fontFamily: 'Inter Tight, sans-serif',
      }}>
        <span style={{ ...mono, fontSize: 10, fontWeight: 700, color }}>{count}</span>
        {label}
      </span>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.16 275)', marginBottom: 4 }}>C7 — document-level annotation summary</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Two placement options</h2>
      </div>

      {/* Option A: StatusBar slot */}
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Option A — StatusBar slot (recommended): peer of "held: 3"</div>
        <div style={{
          display: 'flex', alignItems: 'center', height: 26,
          padding: '0 16px', background: 'var(--surface-muted, oklch(0.975 0.005 80))',
          border: `1px solid ${hair}`, borderRadius: 6,
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: faint, gap: 12,
        }}>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'oklch(0.55 0.14 150)' }} />
            Connected
          </span>
          <span>·</span>
          <span>1,842 words</span>
          <span>·</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <SummaryPill count={4} label="notes" color={faint} />
            <SummaryPill count={2} label="comments" color={userC} />
            <SummaryPill count={1} label="suggestion" color={claudeC} />
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ color: claudeC, fontWeight: 600 }}>held: 3</span>
          <span>·</span>
          <span>Bryan · Solo</span>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: muted }}>Compact pill row. Clicking the summary row opens the annotation rail filtered to that type. Zero-count types are hidden. Updates live.</p>
      </div>

      {/* Option B: Rail header */}
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Option B — Rail header (alternative): above filter chips</div>
        <div style={{
          background: 'var(--surface-muted, oklch(0.975 0.005 80))',
          border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${hair}` }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: ink }}>7 annotations</span>
            <span style={{ flex: 1 }} />
            <SummaryPill count={4} label="notes" color={faint} />
            <SummaryPill count={2} label="comments" color={userC} />
            <SummaryPill count={1} label="suggestion" color={claudeC} />
          </div>
          <div style={{ padding: '8px 12px', display: 'flex', gap: 6 }}>
            {['All · 7', 'Notes · 4', 'Comments · 2', 'Suggestions · 1'].map(label => (
              <span key={label} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 99, border: `1px solid ${hair}`, background: label.startsWith('All') ? ink : 'transparent', color: label.startsWith('All') ? 'white' : muted, cursor: 'pointer' }}>{label}</span>
            ))}
          </div>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 12, color: muted }}>More prominent; replaces the plain count badge in the rail tab. Adds 32px height to rail header. Suitable if summary is high-value at a glance.</p>
      </div>

      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Decision: Option A (StatusBar)</strong> — keeps the rail header compact and consistent with the existing filter-chip pattern. StatusBar already carries per-session metadata; annotation counts are a natural peer of word count and held-count.
      </div>
    </div>
  );
}

Object.assign(window, {
  C1ChangelogFrame,
  C2ScratchpadFrame,
  C3StoreReadonlySpec,
  C4ConnStatesSpec,
  C5NarrowSettingsFrame,
  C6ThreadCollapsedSpec,
  C7AnnoSummarySpec,
});
