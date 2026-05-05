/* Tandem — additional surfaces: Find/Replace, Diff view, Command palette,
   Network settings, expanded annotation thread, narrow-window layout,
   onboarding, and Share sheet. Each is exported on `window` so the canvas
   can mount them in their own artboards. */

const { useState, useEffect, useRef } = React;

// ------------------------------------------------------------
// 1. Find / Replace bar — overlay docked top-right of editor
// ------------------------------------------------------------
function FindReplaceBar({ open = true, query = 'dashboard', replace = 'self-service dashboard',
  matches = 7, current = 3, scope = 'doc', flags = { case: false, word: false, regex: false },
  showReplace = true, onClose }) {
  if (!open) return null;
  return (
    <div className="fr-bar" role="search" aria-label="Find and replace">
      <div className="fr-row">
        <div className="fr-input-wrap">
          <Icon name="search" size={12}/>
          <input className="fr-input" defaultValue={query} placeholder="Find" />
          <span className="fr-count mono">{current}/{matches}</span>
          <button className="fr-flag" title="Match case" data-on={flags.case}>Aa</button>
          <button className="fr-flag" title="Whole word" data-on={flags.word}>W</button>
          <button className="fr-flag" title="Regex" data-on={flags.regex}>.*</button>
        </div>
        <div className="fr-nav">
          <button className="tb-icon-btn" title="Previous (⇧↵)"><Icon name="chevUp" size={11}/></button>
          <button className="tb-icon-btn" title="Next (↵)"><Icon name="chevDown" size={11}/></button>
        </div>
        <button className="tb-icon-btn fr-close" title="Close (Esc)" onClick={onClose}><Icon name="x" size={12}/></button>
      </div>
      {showReplace && (
        <div className="fr-row">
          <div className="fr-input-wrap">
            <Icon name="reply" size={11}/>
            <input className="fr-input" defaultValue={replace} placeholder="Replace" />
          </div>
          <div className="fr-nav">
            <button className="btn-ghost fr-act">Replace</button>
            <button className="btn-primary fr-act">Replace all</button>
          </div>
        </div>
      )}
      <div className="fr-scope mono">
        <span className={'fr-scope-pill' + (scope === 'doc' ? ' on' : '')}>This document</span>
        <span className={'fr-scope-pill' + (scope === 'open' ? ' on' : '')}>Open tabs</span>
        <span className="faint">·</span>
        <span className="faint">⌘F find · ⌘⌥F replace · Esc close</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 2. Diff view — Apply changes flow on imported .docx
// ------------------------------------------------------------
function DiffView({ docName = 'partner-update.docx' }) {
  const hunks = [
    {
      id: 'h1', accepted: true, anno: 'Suggestion · Claude · 4m',
      lines: [
        { type: 'ctx', n: ['12','12'], text: 'The project launched in early 2025 with three core goals:' },
        { type: 'del', n: ['13',''], text: 'simplify onboarding, reduce support tickets by 40%, and ship a' },
        { type: 'add', n: ['','13'], text: 'streamline first-run setup, reduce support tickets by 40%, and ship a' },
        { type: 'ctx', n: ['14','14'], text: 'self-service dashboard by Q3.' },
      ],
    },
    {
      id: 'h2', accepted: false, anno: 'Flag · You · 8m',
      lines: [
        { type: 'ctx', n: ['18','18'], text: 'but the dashboard timeline' },
        { type: 'del', n: ['19',''], text: 'slipped due to an unexpected API redesign in May.' },
        { type: 'add', n: ['','19'], text: 'extended in scope when an unplanned API redesign landed in May.' },
      ],
    },
    {
      id: 'h3', accepted: true, anno: 'Comment · You · 11m',
      lines: [
        { type: 'ctx', n: ['41','41'], text: 'During the build, the data team flagged that aggregation queries' },
        { type: 'add', n: ['','42'], text: '[link: see RFC-007 for the read-layer design]' },
        { type: 'ctx', n: ['42','43'], text: 'would not scale past ~1,000 concurrent users…' },
      ],
    },
  ];
  const accepted = hunks.filter(h => h.accepted).length;
  return (
    <div className="diff-view">
      <header className="diff-head">
        <div className="diff-title">
          <Icon name="docW" size={13}/>
          <strong>Apply changes to {docName}</strong>
          <span className="ro-badge" style={{ marginLeft: 8 }}>RO source</span>
        </div>
        <div className="diff-summary mono">
          <span className="diff-stat add">+{accepted} accepted</span>
          <span className="diff-stat del">−{hunks.length - accepted} skipped</span>
          <span className="faint">·</span>
          <span>writes <code>partner-update.tandem.docx</code></span>
        </div>
        <div className="diff-actions">
          <button className="btn-ghost">Cancel</button>
          <button className="btn-ghost">Review one-by-one</button>
          <button className="btn-primary"><Icon name="check" size={11} stroke={2.4}/> Save copy with tracked changes</button>
        </div>
      </header>
      <div className="diff-body">
        {hunks.map(h => (
          <div className={'diff-hunk' + (h.accepted ? ' on' : ' off')} key={h.id}>
            <div className="diff-hunk-head">
              <label className="diff-check">
                <input type="checkbox" defaultChecked={h.accepted}/>
                <span className="diff-check-box">{h.accepted && <Icon name="check" size={9} stroke={3}/>}</span>
                <span>{h.accepted ? 'Include' : 'Skip'}</span>
              </label>
              <span className="diff-anno mono faint">{h.anno}</span>
              <span className="diff-loc mono faint">¶ {h.lines[0].n[0]}</span>
            </div>
            <pre className="diff-pre">
              {h.lines.map((l, i) => (
                <div key={i} className={'diff-line ' + l.type}>
                  <span className="ln old mono">{l.n[0]}</span>
                  <span className="ln new mono">{l.n[1]}</span>
                  <span className="diff-glyph">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                  <span className="diff-text">{l.text}</span>
                </div>
              ))}
            </pre>
          </div>
        ))}
      </div>
      <footer className="diff-foot mono faint">
        Word's tracked-changes XML is preserved. The original .docx is never written; a copy is saved alongside.
      </footer>
    </div>
  );
}

// ------------------------------------------------------------
// 3. Command palette — ⌘K
// ------------------------------------------------------------
function CommandPalette({ query = 'read', onClose }) {
  const sections = [
    { title: 'Commands', items: [
      { ic: 'docMd', label: 'New document', kbd: '⌘N' },
      { ic: 'search', label: 'Find in document', kbd: '⌘F' },
      { ic: 'docW',  label: 'Open file…', kbd: '⌘O' },
      { ic: 'sparkle', label: 'Ask Claude about selection', kbd: '⌘⇧A' },
      { ic: 'settings', label: 'Open Settings', kbd: '⌘,' },
    ]},
    { title: 'Recent files', items: [
      { ic: 'docMd', label: 'q2-dashboard-review.md', meta: '~/work/q2-review · 2m', highlight: true },
      { ic: 'docMd', label: 'rfc-007-readlayer.md', meta: '~/work/q2-review · 12m' },
      { ic: 'docW',  label: 'partner-update.docx', meta: '~/Downloads · 3d · RO' },
    ]},
    { title: 'Headings in current document', items: [
      { ic: 'H1', label: 'Q2 Progress Review — Self-Service Dashboard', meta: 'line 1' },
      { ic: 'H2', label: 'Where the dashboard stalled', meta: 'line 18' },
      { ic: 'H3', label: 'Read-layer rebuild', meta: 'line 24' },
    ]},
    { title: 'Annotations', items: [
      { ic: 'comment', label: '"During the build, the data team flagged…"', meta: 'You · 11m' },
      { ic: 'flag',    label: '"slipped"', meta: 'You · 8m' },
    ]},
  ];
  return (
    <div className="cp-overlay" onClick={onClose}>
      <div className="cp" role="dialog" aria-label="Command palette" onClick={e => e.stopPropagation()}>
        <div className="cp-input-row">
          <Icon name="search" size={14}/>
          <input className="cp-input" defaultValue={query} placeholder="Type a command, file, heading, or @ to mention…" autoFocus/>
          <span className="kbd">esc</span>
        </div>
        <div className="cp-body">
          {sections.map((s, si) => (
            <div className="cp-section" key={s.title}>
              <div className="cp-section-title mono">{s.title}</div>
              {s.items.map((it, i) => (
                <div className={'cp-item' + (si === 1 && i === 0 ? ' sel' : '')} key={s.title + i}>
                  <span className="cp-ic">{typeof it.ic === 'string' && it.ic.length <= 2 ? it.ic : <Icon name={it.ic} size={13}/>}</span>
                  <span className="cp-label">{it.label}</span>
                  {it.meta && <span className="cp-meta mono faint">{it.meta}</span>}
                  {it.kbd && <span className="kbd">{it.kbd}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="cp-foot mono faint">
          <span><span className="kbd">↑↓</span> navigate</span>
          <span><span className="kbd">↵</span> open</span>
          <span><span className="kbd">⌘↵</span> open in new tab</span>
          <span className="grow"/>
          <span>Type <code>?</code> for help · <code>&gt;</code> commands · <code>#</code> headings · <code>@</code> annotations</span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 4. Network settings panel — what powers the degradation banner
// ------------------------------------------------------------
function NetworkPanel() {
  return (
    <div className="net-panel">
      <div className="settings-section">
        <h3>Connection</h3>
        <div className="net-status">
          <span className="sb-dot green"/>
          <div className="net-status-text">
            <strong>Connected</strong> to <code>claude-sidecar</code> via local socket
            <div className="faint mono">pid 41822 · started 2h 14m ago · 0 retries this session</div>
          </div>
          <button className="btn-ghost">Restart sidecar</button>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Sidecar transport</strong>
            <p>How the editor talks to the local Claude process. Unix socket is fastest; HTTP loopback is the cross-platform fallback.</p>
          </div>
          <div className="settings-row-control">
            <div className="seg-radio">
              <button className="on">Unix socket</button>
              <button>HTTP loopback</button>
              <button>WebSocket</button>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Loopback port</strong>
            <p>Used only when sidecar transport is HTTP / WebSocket.</p>
          </div>
          <div className="settings-row-control">
            <input className="settings-input mono" defaultValue="51823" style={{ width: 100 }}/>
            <button className="btn-ghost" style={{ marginLeft: 8 }}>Pick free port</button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Reconnect behavior</h3>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Show degradation banner after</strong>
            <p>Banner appears once Claude has been unreachable for this long. Edits never block.</p>
          </div>
          <div className="settings-row-control">
            <div className="settings-slider">
              <input type="range" min="5" max="120" defaultValue="30"/>
              <span className="mono">30s</span>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Retry strategy</strong>
            <p>Exponential backoff is recommended; constant retry is useful when debugging the sidecar.</p>
          </div>
          <div className="settings-row-control">
            <div className="seg-radio">
              <button className="on">Exponential</button>
              <button>Constant 2s</button>
              <button>Manual only</button>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Hold annotations while offline</strong>
            <p>Local annotations appear immediately; Claude's are queued and replay in order on reconnect.</p>
          </div>
          <div className="settings-row-control">
            <button className="settings-toggle on" aria-pressed="true"><span/></button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <h3>Proxy &amp; certificates</h3>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>HTTP proxy</strong>
            <p>Inherited from system by default. Override only if your org requires a specific egress.</p>
          </div>
          <div className="settings-row-control">
            <div className="seg-radio">
              <button className="on">System</button>
              <button>None</button>
              <button>Custom</button>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-label">
            <strong>Trust additional CAs</strong>
            <p>Drop in PEM-encoded certificate authorities for corporate TLS-inspecting proxies.</p>
          </div>
          <div className="settings-row-control">
            <button className="btn-ghost"><Icon name="docW" size={11}/> Choose .pem…</button>
            <span className="mono faint" style={{ marginLeft: 8 }}>0 added</span>
          </div>
        </div>

        <div className="net-log">
          <div className="net-log-head mono">Recent connection events</div>
          <ul className="net-log-list mono">
            <li><span className="t">14:32:10</span><span className="ev ok">CONNECT</span> sidecar handshake ok · 14ms</li>
            <li><span className="t">14:31:58</span><span className="ev warn">DEGRADED</span> banner shown · 32s without heartbeat</li>
            <li><span className="t">14:31:26</span><span className="ev err">DROP</span> ECONNREFUSED · sidecar pid 41801 exited (signal 0)</li>
            <li><span className="t">12:18:04</span><span className="ev ok">CONNECT</span> sidecar handshake ok · 11ms</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 5. Expanded annotation thread — replies + reactions
// ------------------------------------------------------------
function AnnotationThread() {
  return (
    <div className="thread">
      <div className="thread-anchor">
        <span className="thread-anchor-bar"/>
        <span className="thread-anchor-text">"slipped due to an unexpected API redesign in May"</span>
        <span className="thread-anchor-loc mono faint">¶ 3 · line 19</span>
      </div>

      <div className="thread-msg">
        <div className="thread-msg-head">
          <span className="author-chip user"><span className="author-dot user"/>You</span>
          <span className="thread-type flag">flag</span>
          <span className="thread-time mono faint">8m</span>
          <span className="grow"/>
          <button className="thread-more"><Icon name="more" size={12}/></button>
        </div>
        <div className="thread-body">
          Need to soften — exec audience reads "slipped" as missed deadline. Suggest "extended scope"?
        </div>
        <div className="thread-react-row">
          <span className="react-chip on"><span className="react-emoji">👍</span> 2</span>
          <span className="react-chip"><span className="react-emoji">✨</span> 1</span>
          <button className="react-add"><Icon name="plus" size={10}/></button>
        </div>
      </div>

      <div className="thread-reply">
        <div className="thread-msg-head">
          <span className="author-chip claude"><span className="author-dot claude"/>Claude</span>
          <span className="thread-time mono faint">7m</span>
        </div>
        <div className="thread-body">
          Two phrases that match the exec register: <em>"extended in scope"</em> (neutral, accepts the May change as planned), or <em>"shifted to August"</em> (states the new date plainly). The second is more honest if Aug 12 is firm.
        </div>
        <div className="thread-suggest">
          <div className="thread-suggest-head mono faint">Suggested edit</div>
          <div className="diff">
            <div className="diff-row del">slipped due to an unexpected API redesign</div>
            <div className="diff-row add">extended in scope when an unplanned API redesign landed</div>
          </div>
          <div className="thread-suggest-actions">
            <button className="btn-primary"><Icon name="check" size={11} stroke={2.4}/> Accept</button>
            <button className="btn-ghost">Try another</button>
          </div>
        </div>
      </div>

      <div className="thread-reply">
        <div className="thread-msg-head">
          <span className="author-chip user"><span className="author-dot user"/>You</span>
          <span className="thread-time mono faint">5m</span>
        </div>
        <div className="thread-body">
          Let's go with the first — Aug 12 is still tentative. Apply it and resolve.
        </div>
      </div>

      <div className="thread-resolution">
        <Icon name="check" size={11} stroke={2.4}/>
        <span><strong>Resolved by you</strong> · suggestion accepted · <a href="#" onClick={e => e.preventDefault()}>view edit in history</a></span>
        <button className="btn-ghost thread-reopen">Reopen</button>
      </div>

      <div className="thread-composer">
        <textarea placeholder="Reply to thread…" rows="2"/>
        <div className="thread-composer-row">
          <button className="thread-composer-tool" title="Mention"><Icon name="reply" size={11}/> @</button>
          <button className="thread-composer-tool" title="Quote"><Icon name="quote" size={11}/></button>
          <button className="thread-composer-tool" title="Suggest edit"><Icon name="sparkle" size={11}/></button>
          <span className="grow"/>
          <ShortcutTooltip label="Send reply" keys="⌘↵" placement="top">
            <button className="btn-primary" aria-label="Reply">Reply</button>
          </ShortcutTooltip>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 6. Narrow-window / mobile layout
// ------------------------------------------------------------
function NarrowLayout({ panel = 'sheet' }) {
  return (
    <div className="narrow-app" data-theme="light">
      <div className="narrow-titlebar">
        <button className="narrow-icon"><Icon name="menu" size={14}/></button>
        <div className="narrow-doc">
          <span className="ext">M</span>
          <span className="narrow-doc-name">q2-dashboard-review.md</span>
          <span className="dirty"/>
        </div>
        <button className="narrow-icon"><Icon name="search" size={14}/></button>
        <button className="narrow-icon"><Icon name="more" size={14}/></button>
      </div>

      <div className="narrow-tabbar">
        <span className="claude-pulse"/>
        <span className="narrow-claude-label">Claude · <span style={{ color: 'var(--author-claude)' }}>thinking</span></span>
        <span className="grow"/>
        <span className="narrow-pill">3 annos</span>
      </div>

      <div className="narrow-editor">
        <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.2, margin: '0 0 14px' }}>
          Q2 Progress Review — Self-Service Dashboard
        </h1>
        <p className="para has-anno" data-tandem-author="user" style={{ fontFamily: 'var(--font-serif)', fontSize: 16, lineHeight: 1.55 }}>
          The project launched in early 2025 with three core goals: <span className="anno-suggest">simplify onboarding</span>, reduce support tickets by 40%, and ship a self-service dashboard by Q3. The team completed the first two milestones ahead of schedule, but the dashboard timeline <span className="anno-flag">slipped</span> due to an unexpected API redesign in May.
        </p>
        <p className="para" data-tandem-author="claude" style={{ fontFamily: 'var(--font-serif)', fontSize: 16, lineHeight: 1.55 }}>
          Two factors compounded the gain: the new onboarding routes users to the relevant subset of features for their plan tier…
        </p>
      </div>

      {panel === 'sheet' && (
        <div className="narrow-sheet">
          <div className="narrow-sheet-handle"/>
          <div className="narrow-sheet-tabs">
            <span className="narrow-sheet-tab on">Annotations <span className="count">3</span></span>
            <span className="narrow-sheet-tab">Chat</span>
            <span className="narrow-sheet-tab">Outline</span>
          </div>
          <div className="narrow-sheet-body">
            <AnnotationCard a={window.ANNOS[0]} active/>
            <AnnotationCard a={window.ANNOS[2]}/>
          </div>
        </div>
      )}

      <div className="narrow-bottombar">
        <button className="narrow-bb"><Icon name="comment" size={14}/><span>3</span></button>
        <button className="narrow-bb"><Icon name="sparkle" size={14}/><span>Ask</span></button>
        <button className="narrow-bb on"><Icon name="docMd" size={14}/><span>Edit</span></button>
        <button className="narrow-bb"><Icon name="settings" size={14}/></button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 7. First-run / onboarding
// ------------------------------------------------------------
function Onboarding({ step = 2 }) {
  return (
    <div className="onb">
      <div className="onb-rail">
        <div className="onb-brand">
          <span className="dot"/>
          <strong>Tandem</strong>
        </div>
        <ol className="onb-steps">
          {['Welcome','Identity','Workspace','Claude','Tandem invite'].map((s, i) => (
            <li key={s} className={'onb-step' + (i + 1 === step ? ' on' : i + 1 < step ? ' done' : '')}>
              <span className="onb-step-dot">{i + 1 < step ? <Icon name="check" size={10} stroke={3}/> : i + 1}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <div className="onb-rail-foot mono faint">
          v0.4.2 · build 1f3ac9 · skips when re-launched
        </div>
      </div>

      <div className="onb-stage">
        <div className="onb-meta mono">step {step} of 5</div>
        <h1 className="onb-title">How should we sign your edits?</h1>
        <p className="onb-sub">
          Tandem stamps every paragraph with who last touched it — that's how the authorship gutter works. Pick a name and a color; both are local-first and only sync when you join a tandem.
        </p>

        <div className="onb-card">
          <label className="onb-field">
            <span>Display name</span>
            <input className="settings-input" defaultValue="bryan"/>
          </label>
          <label className="onb-field">
            <span>Initial</span>
            <input className="settings-input mono" defaultValue="B" maxLength="1" style={{ width: 60, textAlign: 'center' }}/>
          </label>
          <div className="onb-field">
            <span>Author color</span>
            <div className="onb-swatches">
              {['#5B5BD6','#3B7DD8','#5B9F4D','#D97757','#B25BD6','#666'].map((c, i) => (
                <span key={c} className={'onb-sw' + (i === 0 ? ' on' : '')} style={{ background: c }}>
                  {i === 0 && <Icon name="check" size={10} stroke={3}/>}
                </span>
              ))}
            </div>
          </div>

          <div className="onb-preview">
            <div className="onb-preview-label mono faint">PREVIEW</div>
            <div className="para has-anno" data-tandem-author="user" style={{ fontFamily: 'var(--font-serif)', fontSize: 15 }}>
              <strong>bryan</strong> · 2:14 PM &nbsp;—&nbsp; This is what your paragraphs will look like with the gutter on the left.
            </div>
          </div>
        </div>

        <div className="onb-actions">
          <button className="btn-ghost">Back</button>
          <span className="grow"/>
          <button className="btn-ghost">Skip for now</button>
          <button className="btn-primary">Continue →</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// 8. Share / export sheet
// ------------------------------------------------------------
function ShareSheet({ onClose }) {
  return (
    <div className="share-overlay" onClick={onClose}>
      <div className="share-sheet" onClick={e => e.stopPropagation()}>
        <header className="share-head">
          <h3>Share & export</h3>
          <span className="share-doc mono faint">q2-dashboard-review.md · 318 words</span>
          <button className="tb-icon-btn" onClick={onClose}><Icon name="x" size={12}/></button>
        </header>

        <div className="share-section">
          <div className="share-section-title">Tandem link</div>
          <div className="share-link-row">
            <code className="share-link">tandem://bryan.local/q2-dashboard-review?token=k3J…9s</code>
            <button className="btn-primary">Copy link</button>
          </div>
          <div className="share-link-meta mono faint">
            Live · expires in 24h · invitees see annotations as they're written
          </div>
          <div className="share-perms">
            <label className="share-perm">
              <input type="radio" name="perm" defaultChecked/>
              <span><strong>Tandem</strong> · invitee can edit, annotate, and Ask Claude</span>
            </label>
            <label className="share-perm">
              <input type="radio" name="perm"/>
              <span><strong>Review</strong> · invitee can annotate, not edit</span>
            </label>
            <label className="share-perm">
              <input type="radio" name="perm"/>
              <span><strong>Read-only</strong> · invitee sees the latest snapshot</span>
            </label>
          </div>
        </div>

        <div className="share-section">
          <div className="share-section-title">Export</div>
          <div className="share-grid">
            <button className="share-tile">
              <span className="share-tile-ic ext-md">M</span>
              <strong>Markdown (.md)</strong>
              <span className="faint">Source — annotations as HTML comments</span>
            </button>
            <button className="share-tile">
              <span className="share-tile-ic ext-pdf">P</span>
              <strong>PDF</strong>
              <span className="faint">Print-ready · annotations in margin</span>
            </button>
            <button className="share-tile">
              <span className="share-tile-ic ext-docx">W</span>
              <strong>Word (.docx)</strong>
              <span className="faint">Tracked changes for accepted suggestions</span>
            </button>
            <button className="share-tile">
              <span className="share-tile-ic ext-html">&lt;/&gt;</span>
              <strong>Standalone HTML</strong>
              <span className="faint">Single file, offline-readable</span>
            </button>
            <button className="share-tile">
              <span className="share-tile-ic ext-png">▦</span>
              <strong>Snapshot PNG</strong>
              <span className="faint">Selection or full document</span>
            </button>
            <button className="share-tile">
              <span className="share-tile-ic ext-clip">⌘C</span>
              <strong>Copy as rich text</strong>
              <span className="faint">Paste into Slack, Notion, email</span>
            </button>
          </div>

          <div className="share-options">
            <label className="share-option">
              <input type="checkbox" defaultChecked/> Include resolved annotations
            </label>
            <label className="share-option">
              <input type="checkbox" defaultChecked/> Strip authorship metadata
            </label>
            <label className="share-option">
              <input type="checkbox"/> Include Claude chat transcript
            </label>
          </div>
        </div>

        <footer className="share-foot mono faint">
          All exports run locally — nothing leaves this machine unless you copy the link above.
        </footer>
      </div>
    </div>
  );
}

Object.assign(window, {
  FindReplaceBar, DiffView, CommandPalette, NetworkPanel,
  AnnotationThread, NarrowLayout, Onboarding, ShareSheet,
});

// ============================================================
// Composed frame wrappers — these slot into design canvas artboards
// ============================================================

function FindReplaceFrame({ tw }) {
  const [findOpen, setFindOpen] = React.useState(true);
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent, '--editor-font': 'var(--font-serif)', '--rail-w': '360px',
    }}>
      <TopToolbar docName="q2-dashboard-review.md" dirty={true} panelLayout="right" theme={tw.theme || 'light'}/>
      <DocTabs
        docs={[
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
          { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
        ]}
        active="d1"
      />
      <div className="main" data-rail="right" style={{ position: 'relative' }}>
        <EditorBody showMini={false} showCursor={false}/>
        {findOpen
          ? <FindReplaceBar onClose={() => setFindOpen(false)}/>
          : <button className="btn-primary" onClick={() => setFindOpen(true)}
              style={{ position: 'absolute', top: 16, right: 376, zIndex: 5 }}>Reopen Find &amp; replace</button>}
        <SideRail mode="annotations" annotations={ANNOS} chat={CHAT}/>
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true}/>
    </div>
  );
}

function DiffFrame({ tw }) {
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent, '--editor-font': 'var(--font-serif)', '--rail-w': '360px',
    }}>
      <TopToolbar docName="partner-update.docx" dirty={true} panelLayout="right" theme={tw.theme || 'light'}/>
      <DocTabs
        docs={[
          { id: 'd3', name: 'partner-update.docx', ext: 'D', dirty: true },
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M' },
        ]}
        active="d3"
      />
      <div className="main" data-rail="right">
        <DiffView docName="partner-update.docx"/>
        <SideRail mode="chat" annotations={ANNOS} chat={CHAT}/>
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true}/>
    </div>
  );
}

function PaletteFrame({ tw }) {
  const [paletteOpen, setPaletteOpen] = React.useState(true);
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent, '--editor-font': 'var(--font-serif)', '--rail-w': '360px',
    }}>
      <TopToolbar docName="q2-dashboard-review.md" dirty={true} panelLayout="right" theme={tw.theme || 'light'}/>
      <DocTabs
        docs={[
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
          { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
        ]}
        active="d1"
      />
      <div className="main" data-rail="right" style={{ position: 'relative' }}>
        <EditorBody showMini={false} showCursor={false}/>
        <SideRail mode="annotations" annotations={ANNOS} chat={CHAT}/>
        {paletteOpen
          ? <CommandPalette onClose={() => setPaletteOpen(false)}/>
          : <ShortcutTooltip label="Open command palette" keys="⌘K" placement="bottom">
              <button className="btn-primary" onClick={() => setPaletteOpen(true)}
                style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }} aria-label="Open command palette">Open command palette</button>
            </ShortcutTooltip>}
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true}/>
    </div>
  );
}

function ThreadFrame({ tw }) {
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent, '--editor-font': 'var(--font-serif)', '--rail-w': '420px',
    }}>
      <TopToolbar docName="q2-dashboard-review.md" dirty={true} panelLayout="right" theme={tw.theme || 'light'}/>
      <DocTabs
        docs={[
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
          { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
        ]}
        active="d1"
      />
      <div className="main" data-rail="right">
        <EditorBody showMini={false} showCursor={false}/>
        <AnnotationThread/>
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true}/>
    </div>
  );
}

function OnboardingFrame({ tw }) {
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent,
    }}>
      <TopToolbar docName="welcome" dirty={false} panelLayout="hidden" theme={tw.theme || 'light'}/>
      <Onboarding step={2}/>
    </div>
  );
}

function ShareFrame({ tw }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="app" data-theme={tw.theme || 'light'} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent, '--editor-font': 'var(--font-serif)', '--rail-w': '360px',
    }}>
      <TopToolbar docName="q2-dashboard-review.md" dirty={true} panelLayout="right" theme={tw.theme || 'light'}/>
      <DocTabs
        docs={[
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
          { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
        ]}
        active="d1"
      />
      <div className="main" data-rail="right" style={{ position: 'relative' }}>
        <EditorBody showMini={false} showCursor={false}/>
        <SideRail mode="annotations" annotations={ANNOS} chat={CHAT}/>
        {!open && (
          <button
            className="btn-primary"
            onClick={() => setOpen(true)}
            style={{ position: 'absolute', top: 16, right: 376, zIndex: 5 }}
          >Reopen Share & export</button>
        )}
      </div>
      <StatusBar claudeState="idle" docName="q2-dashboard-review.md" dirty={true}/>
      {open && <ShareSheet onClose={() => setOpen(false)}/>}
    </div>
  );
}

function SettingsNetworkFrame({ tw }) {
  return <NetworkPanel/>;
}

function MobileFrame({ tw }) {
  return (
    <div style={{ width: '100%', height: '100%', background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}>
      <NarrowLayout/>
    </div>
  );
}

Object.assign(window, {
  FindReplaceFrame, DiffFrame, PaletteFrame, ThreadFrame,
  OnboardingFrame, ShareFrame, SettingsNetworkFrame, MobileFrame,
});
