/* Tandem editor — main app shell, all states */

const { useState, useEffect, useRef } = React;

// ---------- Window controls (custom titlebar) ----------
// Platform-aware traffic lights / min-max-close. The whole titlebar is
// draggable except interactive children (data-tauri-drag-region honored
// at runtime; in mocks the attribute is decorative).
function WinControls({ platform = typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win' }) {
  if (platform === 'mac') {
    return (
      <div className="winctl mac" data-no-drag>
        <button className="wc close" aria-label="Close" title="Close"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 1l4 4M5 1l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg></button>
        <button className="wc min" aria-label="Minimize" title="Minimize"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 3h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg></button>
        <button className="wc max" aria-label="Zoom" title="Zoom"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1.5 1.5h3v3h-3z" fill="none" stroke="currentColor" strokeWidth="1.1" /></svg></button>
      </div>);

  }
  // Windows / Linux: trailing edge, square buttons
  return (
    <div className="winctl win" data-no-drag>
      <button className="wcw" aria-label="Minimize" title="Minimize"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1" /></svg></button>
      <button className="wcw" aria-label="Maximize" title="Maximize"><svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1" /></svg></button>
      <button className="wcw close" aria-label="Close" title="Close"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1" /></svg></button>
    </div>);

}

// ---------- Toolbar ----------
function TopToolbar({ docName = 'progress-report.md', dirty = true, mode = 'tandem', onMode, panelLayout = 'right', onPanelLayout, theme = 'light', onTheme, onTweaks, onShortcuts, claudeState = 'reading', platform = typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win' }) {
  return (
    <div className={'toolbar titlebar plat-' + platform} data-tauri-drag-region>
      {platform === 'mac' && <WinControls platform="mac" />}

      <div className="brand" data-no-drag>
        <span className="mark" aria-hidden="true">
          <img src="logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
        </span>
        Tandem
      </div>

      <div style={{ flex: 1 }} />

      <div className="seg" role="tablist" aria-label="Mode" data-no-drag>
        <button className={mode === 'solo' ? 'on' : ''} onClick={() => onMode?.('solo')}>Solo</button>
        <button className={mode === 'tandem' ? 'on' : ''} onClick={() => onMode?.('tandem')}>Tandem</button>
      </div>

      <div className="claude-presence" title={`Claude: ${claudeState}`} data-no-drag>
        <span className={'claude-pulse' + (claudeState === 'idle' ? ' idle' : '')} />
      </div>

      <div className="tb-divider" />

      {/* Panel layout controls: single toggle + three-panel option */}
      <ShortcutTooltip label={panelLayout === 'hidden' ? 'Show panel' : 'Hide panel'} keys="⌘⇧P" placement="left" platform={platform}>
        <button
          className={'tb-icon-btn' + (panelLayout !== 'hidden' && panelLayout !== 'three' ? ' active' : '')}
          onClick={() => onPanelLayout?.(panelLayout === 'hidden' ? 'right' : 'hidden')}
          data-no-drag>
          
          <Icon name={panelLayout === 'left' ? 'panelL' : 'panelR'} />
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Three-panel mode" placement="left" platform={platform}>
        <button
          className={'tb-icon-btn' + (panelLayout === 'three' ? ' active' : '')}
          onClick={() => onPanelLayout?.(panelLayout === 'three' ? 'right' : 'three')}
          data-no-drag
          title="Three-panel: outline left · editor · annotations right">
          
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <rect x="1" y="2" width="14" height="12" rx="1.5" />
            <path d="M5 2v12M11 2v12" />
          </svg>
        </button>
      </ShortcutTooltip>

      <button className="tb-icon-btn" title="Toggle theme" onClick={() => onTheme?.(theme === 'light' ? 'dark' : 'light')} data-no-drag>
        <Icon name={theme === 'light' ? 'moon' : 'sun'} />
      </button>
      <ShortcutTooltip label="Keyboard shortcuts" keys="⌘/" placement="left" platform={platform}>
        <button className="tb-icon-btn" aria-label="Keyboard shortcuts" onClick={onShortcuts} data-no-drag><Icon name="help" /></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Settings" keys="⌘," placement="left" platform={platform}>
        <button className="tb-icon-btn" aria-label="Settings" onClick={onTweaks} data-no-drag><Icon name="settings" /></button>
      </ShortcutTooltip>

      {platform !== 'mac' && <WinControls platform={platform} />}
    </div>);

}

// ---------- Tabs ----------
function DocTabs({ docs, active, onSelect, recentOpen = false }) {
  return (
    <div className="tabs">
      {docs.map((d) =>
      <div key={d.id} className={'tab' + (d.id === active ? ' active' : '')} onClick={() => onSelect?.(d.id)}>
          <span className="ext">{d.ext}</span>
          <span className="tab-name">{d.name}</span>
          {d.readOnly && <span className="ro-badge" title="Read-only · .docx — annotate without overwriting">RO</span>}
          {d.dirty && <span className="dirty" />}
          <span className="x"><Icon name="x" size={10} stroke={1.8} /></span>
        </div>
      )}
      <div className="tab-add-wrap">
        <div className="tab-add" title="Open file" style={{ justifyContent: "center" }}><Icon name="plus" size={12} /></div>
        {recentOpen &&
        <div className="recent-menu">
            <div className="recent-head">Recent files</div>
            <div className="recent-item">
              <span className="ext">M</span>
              <span className="recent-name">readlayer-rfc.md</span>
              <span className="recent-time">2h</span>
            </div>
            <div className="recent-item">
              <span className="ext">M</span>
              <span className="recent-name">q2-okrs.md</span>
              <span className="recent-time">yesterday</span>
            </div>
            <div className="recent-item">
              <span className="ext">W</span>
              <span className="recent-name">board-update-may.docx</span>
              <span className="recent-time">3d</span>
            </div>
            <div className="recent-divider" />
            <div className="recent-item action">
              <Icon name="plus" size={11} />
              <span>Browse files…</span>
              <span className="recent-time">⌘O</span>
            </div>
            <div className="recent-item action">
              <Icon name="docMd" size={11} />
              <span>New document</span>
              <span className="recent-time">⌘N</span>
            </div>
          </div>
        }
      </div>
    </div>);

}

// ---------- Formatting bar — sits between tabs and editor ----------
// Separate from the title bar (which is the drag region) so formatting
// buttons never interfere with window dragging. Mirrors FormattingToolbar.svelte.
function FormattingBar({ platform = typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win', hasSelection = false, onToggleLeft, onToggleRight, leftVisible = false, rightVisible = true }) {
  const div = () => <div className="tb-divider" />;
  return (
    <div className="fmt-bar">
      {/* Left rail toggle — far left */}
      <ShortcutTooltip label={leftVisible ? 'Hide left panel' : 'Show left panel'} keys="⌘⇧[" placement="bottom" platform={platform}>
        <button className={'tb-icon-btn' + (leftVisible ? ' active' : '')} aria-label="Toggle left panel" onClick={onToggleLeft}>
          <Icon name="panelL" size={14} />
        </button>
      </ShortcutTooltip>
      {div()}
      {/* Undo / Redo */}
      <ShortcutTooltip label="Undo" keys="⌘Z" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Undo"><Icon name="undo" size={14} /></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Redo" keys="⌘⇧Z" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Redo"><Icon name="redo" size={14} /></button>
      </ShortcutTooltip>

      {div()}

      {/* Heading */}
      <button className="tb-fmt-btn" title="Heading" style={{ minWidth: 36, fontWeight: 600, fontSize: 12 }}>H ▾</button>

      {div()}

      {/* Inline marks */}
      <ShortcutTooltip label="Bold" keys="⌘B" placement="bottom" platform={platform}>
        <button className="tb-fmt-btn" aria-label="Bold" style={{ fontWeight: 700 }}>B</button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Italic" keys="⌘I" placement="bottom" platform={platform}>
        <button className="tb-fmt-btn" aria-label="Italic" style={{ fontStyle: 'italic' }}>I</button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Strikethrough" keys="⌘⇧X" placement="bottom" platform={platform}>
        <button className="tb-fmt-btn" aria-label="Strikethrough" style={{ textDecoration: 'line-through' }}>S</button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Inline code" keys="⌘E" placement="bottom" platform={platform}>
        <button className="tb-fmt-btn" aria-label="Inline code" style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>&lt;/&gt;</button>
      </ShortcutTooltip>

      {div()}

      {/* Lists + blockquote */}
      <ShortcutTooltip label="Bullet list" keys="⌘⇧8" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Bullet list">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="2.5" cy="4.5" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="2.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="2.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
            <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" />
          </svg>
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Ordered list" keys="⌘⇧7" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Ordered list">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8" />
            <text x="0.5" y="6" fontSize="4.5" fill="currentColor" stroke="none" fontFamily="monospace" fontWeight="bold">1.</text>
            <text x="0.5" y="9.5" fontSize="4.5" fill="currentColor" stroke="none" fontFamily="monospace" fontWeight="bold">2.</text>
            <text x="0.5" y="13" fontSize="4.5" fill="currentColor" stroke="none" fontFamily="monospace" fontWeight="bold">3.</text>
          </svg>
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Blockquote" keys="⌘⇧B" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Blockquote"><Icon name="quote" size={14} /></button>
      </ShortcutTooltip>

      {div()}

      {/* Link + code block + HR */}
      <ShortcutTooltip label="Link" keys="⌘K" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Link"><Icon name="link" size={14} /></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Code block" placement="bottom" platform={platform}>
        <button className="tb-icon-btn" aria-label="Code block"><Icon name="code" size={14} /></button>
      </ShortcutTooltip>
      <button className="tb-fmt-btn" title="Horizontal rule" style={{ fontSize: 13, color: 'var(--ink-faint)' }}>—</button>

      {div()}

      {/* Highlight swatches */}
      <div className="tb-swatches" title="Highlight color">
        <span className="tb-sw" style={{ background: 'rgba(234,179,8,0.5)' }} />
        <span className="tb-sw" style={{ background: 'rgba(34,197,94,0.5)' }} />
        <span className="tb-sw" style={{ background: 'rgba(96,165,250,0.5)' }} />
        <span className="tb-sw" style={{ background: 'rgba(236,72,153,0.5)' }} />
      </div>

      {div()}

      {/* Comment + Note — selection-gated */}
      <button className="tb-fmt-btn" title={hasSelection ? 'Add comment' : 'Select text first'}
      style={{ color: hasSelection ? 'var(--ink)' : 'var(--ink-faint)', fontSize: 12 }}>
        Comment
      </button>
      <button className="tb-fmt-btn" title={hasSelection ? 'Add note' : 'Select text first'}
      style={{ color: hasSelection ? 'var(--ink)' : 'var(--ink-faint)', fontSize: 12 }}>
        Note
      </button>

      {div()}
      {/* Right rail toggle — far right */}
      <ShortcutTooltip label={rightVisible ? 'Hide right panel' : 'Show right panel'} keys="⌘⇧]" placement="bottom" platform={platform}>
        <button className={'tb-icon-btn' + (rightVisible ? ' active' : '')} aria-label="Toggle right panel" onClick={onToggleRight} style={{ alignItems: "center", justifyContent: "center", textAlign: "center", gap: "6px" }}>
          <Icon name="panelR" size={14} />
        </button>
      </ShortcutTooltip>
    </div>);

}

// Two-button annotation model: audience (Note to self vs Comment to Claude)
// is the primary decision, not type. Formatting + highlight colors are secondary.
// Based on annotation-redesign-design-brief.md — the popup should make
// the audience distinction feel natural without requiring explanation.
function SelectionMiniToolbar({ x, y, onPick, platform = typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win' }) {
  const [inputMode, setInputMode] = React.useState(null); // null | 'note' | 'comment'
  const [text, setText] = React.useState('');

  if (inputMode) {
    const isComment = inputMode === 'comment';
    return (
      <div className="mini-tb mini-tb--input" style={{ left: x, top: y, transform: 'translate(-50%, -100%)', marginTop: -10, minWidth: 320, padding: '8px 10px', gap: 6, flexDirection: 'column', alignItems: 'stretch' }}>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={isComment ? 'Write a comment for Claude…' : 'Write a note to yourself…'}
          rows={2}
          style={{
            width: '100%', border: 'none', outline: 'none', resize: 'none',
            fontFamily: 'inherit', fontSize: 13, background: 'transparent',
            color: 'var(--ink)', lineHeight: 1.45
          }} />
        
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
          <button className="mini-btn" onClick={() => {setInputMode(null);setText('');}} style={{ fontSize: 11, padding: '0 8px' }}>Cancel</button>
          {isComment ?
          <button className="mini-btn accent" disabled={!text.trim()} onClick={() => onPick?.('comment', text)} style={{ fontSize: 11, padding: '0 10px' }}>
              <Icon name="comment" size={11} /> Send to Claude
            </button> :

          <button className="mini-btn" disabled={!text.trim()} onClick={() => onPick?.('note', text)} style={{ fontSize: 11, padding: '0 10px', borderColor: 'var(--hair)' }}>
              <Icon name="docMd" size={11} /> Save note
            </button>
          }
        </div>
      </div>);

  }

  // Research finding: popup should surface only the 2 marks users apply
  // *after* reading (Bold, Italic) + highlights + the audience choice.
  // Structure tools (H, lists, blockquote, code block, link) stay in the
  // persistent toolbar — they're composing-time decisions, not review-time.
  // Strikethrough & inline code removed from popup to reduce decision load
  // and keep the Note/Comment buttons as the clear primary action.
  return (
    <div className="mini-tb" style={{ left: x, top: y, transform: 'translate(-50%, -100%)', marginTop: -10 }}>
      {/* Quick-format marks — post-reading emphasis only */}
      <ShortcutTooltip label="Bold" keys="⌘B" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Bold"><Icon name="bold" size={14} /></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Italic" keys="⌘I" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Italic"><Icon name="italic" size={14} /></button>
      </ShortcutTooltip>
      <div className="mini-divider" />
      {/* Highlight — one-click, no audience decision needed */}
      <div className="mini-swatches" title="Highlight — yellow / green / blue / pink">
        <span className="mini-sw" style={{ background: 'rgba(234,179,8,0.45)' }} />
        <span className="mini-sw" style={{ background: 'rgba(34,197,94,0.45)' }} />
        <span className="mini-sw" style={{ background: 'rgba(96,165,250,0.45)' }} />
        <span className="mini-sw" style={{ background: 'rgba(236,72,153,0.45)' }} />
      </div>
      <div className="mini-divider" />
      {/* Audience choice — the primary design moment, uncluttered */}
      <ShortcutTooltip label="Private note — visible only to you" keys="⏎" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Note to self" onClick={() => setInputMode('note')} style={{ fontSize: 12, padding: '0 9px' }}>
          Note
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Comment — Claude is notified" keys="⌘⏎" placement="top" platform={platform}>
        <button className="mini-btn accent" aria-label="Comment to Claude" onClick={() => setInputMode('comment')} style={{ fontSize: 12, padding: '0 9px' }}>
          <Icon name="comment" size={12} /> Comment
        </button>
      </ShortcutTooltip>
    </div>);

}

// ---------- Slash menu ----------
function SlashMenu({ x, y }) {
  const items = [
  { ic: 'H1', label: 'Heading 1', k: '#' },
  { ic: 'H2', label: 'Heading 2', k: '##' },
  { ic: '•', label: 'Bullet list', k: '-' },
  { ic: '1.', label: 'Numbered list', k: '1.' },
  { ic: '"', label: 'Quote', k: '>' },
  { ic: '< >', label: 'Code block', k: '```' }];

  return (
    <div className="slash" style={{ left: x, top: y }}>
      {items.map((it, i) =>
      <div className={'slash-item' + (i === 0 ? ' sel' : '')} key={it.label}>
          <span className="ic">{it.ic}</span>
          <span>{it.label}</span>
          <span className="k">{it.k}</span>
        </div>
      )}
    </div>);

}

// ---------- Editor body ----------
function EditorBody({ showMini = true, showCursor = true, showSlash = false, dimmed = false, connection = 'ok', docType = 'md' }) {
  const paged = docType === 'docx' || docType === 'doc';
  return (
    <div className={'editor-wrap' + (paged ? ' paged' : '')}>
      {connection === 'degraded' &&
      <div className="conn-banner" role="status">]
          <Icon name="wifi" size={13} />
          <span><strong>Reconnecting…</strong> Claude is offline. Your edits are saved locally.</span>
          <button className="conn-retry">Retry now</button>
        </div>
      }
      <div className="editor-scroll">
        <div className={'editor-doc' + (paged ? ' editor-doc--paged' : '')}>
          {paged ?
          <>
              <div className="page-sheet">
                <h1>Q2 Progress Review — Self-Service Dashboard</h1>

                <p className="para has-anno" data-tandem-author="user">
                  The project launched in early 2025 with three core goals: <span className="anno-suggest">simplify onboarding</span>, reduce support tickets by 40%, and ship a self-service dashboard by Q3. The team completed the first two milestones ahead of schedule, but the dashboard timeline <span className="anno-flag">slipped</span> due to an unexpected API redesign in May.
                </p>

                <h2>What worked</h2>

                <p className="para has-anno" data-tandem-author="user" data-claude-focus>
                  Onboarding completion climbed from <strong>34% to 71%</strong> after we cut the welcome flow from nine screens to four. Support volume fell <span className="anno-question">in line with projections</span>, with the largest decreases in account-setup and password-reset categories. {showCursor && <span className="claude-cursor" style={{ marginLeft: 2 }} />}
                </p>

                <p className="para" data-tandem-author="claude">
                  Two factors compounded the gain: the new onboarding routes users to the relevant subset of features for their plan tier, and the inline help component now answers ~38% of would-be tickets directly inside the product.
                </p>

                <h2>Where the dashboard stalled</h2>

                <p className="para has-anno" data-tandem-author="user">
                  The original spec assumed the existing reporting API could power most widgets. <span className="anno-comment">During the build, the data team flagged that aggregation queries would not scale past ~1,000 concurrent users without a redesigned read layer.</span>
                </p>
                <div className="page-foot"><span>1</span></div>
              </div>

              <div className="page-sheet">
                <div className="page-head"><span>Q2 Progress Review · q2-board-memo.docx</span></div>

                <p className="para" data-tandem-author="user">
                  We paused dashboard work for six weeks while the API was rebuilt against a denormalized warehouse.
                </p>

                <blockquote>
                  "We underestimated the coupling between the dashboard's read pattern and the legacy invoicing schema. The right call would have been to scope a thin read service in the original RFC."
                  <br />— J. Patel, eng lead
                </blockquote>

                <p className="para" data-tandem-author="user">
                  Despite the slip, the rebuilt read layer is now reusable across <code>/billing</code>, <code>/usage</code>, and the upcoming admin console — work the original timeline would have spent on duplicated query code.
                </p>

                <h2>Outlook for Q3</h2>

                <p className="para" data-tandem-author="user">
                  Dashboard cut-over is scheduled for <strong>August 12</strong>, with a two-week dark-launch period to validate query performance under production load.
                </p>
                <div className="page-foot"><span>2</span></div>
              </div>
            </> :

          <>
              <h1>Q2 Progress Review — Self-Service Dashboard</h1>

              <p className="para has-anno" data-tandem-author="user">
                The project launched in early 2025 with three core goals: <span className="anno-suggest">simplify onboarding</span>, reduce support tickets by 40%, and ship a self-service dashboard by Q3. The team completed the first two milestones ahead of schedule, but the dashboard timeline <span className="anno-flag">slipped</span> due to an unexpected API redesign in May.
              </p>

              <h2>What worked</h2>

              <p className="para has-anno" data-tandem-author="user" data-claude-focus>
                Onboarding completion climbed from <strong>34% to 71%</strong> after we cut the welcome flow from nine screens to four. Support volume fell <span className="anno-question">in line with projections</span>, with the largest decreases in account-setup and password-reset categories. {showCursor && <span className="claude-cursor" style={{ marginLeft: 2 }} />}
              </p>

              <p className="para" data-tandem-author="claude">
                Two factors compounded the gain: the new onboarding routes users to the relevant subset of features for their plan tier, and the inline help component now answers ~38% of would-be tickets directly inside the product.
              </p>

              <h2>Where the dashboard stalled</h2>

              <p className="para has-anno" data-tandem-author="user">
                The original spec assumed the existing reporting API could power most widgets. <span className="anno-comment">During the build, the data team flagged that aggregation queries would not scale past ~1,000 concurrent users without a redesigned read layer.</span> We paused dashboard work for six weeks while the API was rebuilt against a denormalized warehouse.
              </p>

              <blockquote>
                "We underestimated the coupling between the dashboard's read pattern and the legacy invoicing schema. The right call would have been to scope a thin read service in the original RFC."
                <br />— J. Patel, eng lead
              </blockquote>

              <p className="para" data-tandem-author="user">
                Despite the slip, the rebuilt read layer is now reusable across <code>/billing</code>, <code>/usage</code>, and the upcoming admin console — work the original timeline would have spent on duplicated query code.
              </p>

              <h2>Outlook for Q3</h2>

              <p className="para" data-tandem-author="user">
                Dashboard cut-over is scheduled for <strong>August 12</strong>, with a two-week dark-launch period to validate query performance under production load.
              </p>
            </>
          }
        </div>

        {showMini && <SelectionMiniToolbar x={420} y={300} />}
        {showSlash && <SlashMenu x={88} y={520} />}
      </div>
    </div>);

}

// ---------- Annotation card ----------
// Audience-first model (supersedes the v1 3-type taxonomy). The card dispatches
// to the AR* card components from annotation-redesign.jsx so the main artboards
// and the close-up annotation-system artboards share one render path.
//
// Dispatch rules (in priority order):
//   suggestedText present     → ARSuggestionCard
//   author === 'import'       → ARNoteCard (imported notes arrive as private)
//   author === 'claude'       → ARClaudeCommentCard
//   audience === 'private'    → ARNoteCard
//   audience === 'outbound'   → ARUserCommentCard
//   type === 'highlight'      → ARHighlightCard
function AnnotationCard({ a, active }) {
  if (a.diff || a.suggestedText) {
    const del = a.diff?.del ?? a.snippet;
    const add = a.diff?.add ?? a.suggestedText;
    return <ARSuggestionCard del={del} add={add} body={a.body} time={a.time} active={active} />;
  }
  if (a.type === 'highlight') {
    return <ARHighlightCard snippet={a.snippet} color={a.color || 'yellow'} time={a.time} />;
  }
  if (a.author === 'claude') {
    return <ARClaudeCommentCard snippet={a.snippet} body={a.body} time={a.time} active={active} />;
  }
  // user or import, audience-driven
  const isPrivate = a.audience === 'private' || a.type === 'note' || a.author === 'import';
  if (isPrivate) {
    return <ARNoteCard snippet={a.snippet} body={a.body} time={a.time} active={active} />;
  }
  return <ARUserCommentCard snippet={a.snippet} body={a.body} time={a.time} active={active} awaiting={a.awaiting} />;
}

// Legacy card kept for the `cards` close-up artboard which intentionally shows the
// pre-redesign visual language for diffing. New work renders via AnnotationCard above.
function LegacyAnnotationCard({ a, active }) {
  const isSuggestion = !!a.diff;
  const isNote = a.type === 'note' || a.directedAt === 'self';
  const isImport = a.author === 'import';

  // Visual label for the type badge
  const typeLabel = isSuggestion ? 'suggestion' :
  isNote ? 'note' :
  isImport ? 'imported' :
  a.type; // 'comment', 'highlight', 'flag'

  const borderVar = isSuggestion ? 'var(--suggestion)' :
  isNote ? 'var(--ink-faint)' :
  a.type === 'flag' ? 'var(--author-user)' :
  a.author === 'claude' ? 'var(--author-claude)' :
  'var(--author-user)';

  return (
    <div className={'acard' + (active ? ' active' : '') + (a.resolved ? ' resolved' : '')}
    style={{ borderLeftColor: borderVar }}>
      <div className="acard-head">
        <span className={'author-chip ' + a.author}>
          <span className={'author-dot ' + a.author} />
          {a.author === 'user' ? 'You' : a.author === 'import' ? 'Imported' : 'Claude'}
        </span>
        <span className={'acard-type ' + (isSuggestion ? 'suggest' : isNote ? 'note' : a.type)}>
          {typeLabel}
        </span>
        <span className="acard-time">{a.time}</span>
      </div>
      {a.snippet && <div className="acard-snippet">"{a.snippet}"</div>}
      {isSuggestion ?
      <div className="diff">
          <div className="diff-row del">{a.diff.del}</div>
          <div className="diff-row add">{a.diff.add}</div>
        </div> :
      a.body ?
      <div className="acard-body">{a.body}</div> :
      null}
      <div className="acard-actions">
        {isSuggestion ?
        // Claude suggestion (comment + suggestedText) — accept replaces text in doc
        <>
            <button className="btn-primary"><Icon name="check" size={11} stroke={2.4} /> Accept</button>
            <button className="btn-ghost btn-danger">Dismiss</button>
            <span className="btn-spacer" />
            <button className="btn-ghost"><Icon name="reply" size={12} /> Reply</button>
          </> :
        isNote ?
        // User private note — can convert to comment (notifies Claude)
        <>
            <button className="btn-ghost" title="Promote to comment — Claude will be notified" style={{ fontWeight: 600 }}>
              <Icon name="comment" size={11} /> Convert to comment
            </button>
            <span className="btn-spacer" />
            <button className="btn-ghost"><Icon name="more" size={12} /></button>
          </> :
        isImport ?
        // Imported .docx comment — arrived as note, awaiting triage
        <>
            <button className="btn-primary" style={{ fontSize: 11 }}>
              <Icon name="comment" size={11} /> Send to Claude
            </button>
            <button className="btn-ghost" style={{ fontSize: 11 }}>Keep as note</button>
            <span className="btn-spacer" />
            <button className="btn-ghost"><Icon name="more" size={12} /></button>
          </> :
        a.author === 'claude' ?
        // Claude comment — accept / dismiss / reply
        <>
            <button className="btn-primary"><Icon name="check" size={11} stroke={2.4} /> Accept</button>
            <button className="btn-ghost btn-danger">Dismiss</button>
            <span className="btn-spacer" />
            <button className="btn-ghost"><Icon name="reply" size={12} /> Reply</button>
          </> :

        // User comment / highlight / flag — edit and remove
        <>
            <button className="btn-ghost"><Icon name="reply" size={12} /> Reply</button>
            <span className="btn-spacer" />
            <button className="btn-ghost" title="Edit"><Icon name="more" size={12} /></button>
          </>
        }
      </div>
    </div>);

}

// ---------- Collapsible filter bar ----------
function CollapsibleFilterBar({ filter, setFilter, counts }) {
  const [open, setOpen] = React.useState(false);
  const activeLabel = filter === 'all' ? 'All' : filter === 'hl' ? 'Highlights' : filter === 'notes' ? 'Notes' : filter === 'comm' ? 'Comments' : 'Suggestions';
  const activeCount = filter === 'all' ? counts.all : filter === 'hl' ? counts.hl : filter === 'notes' ? counts.notes : filter === 'comm' ? counts.comm : counts.sugg;

  return (
    <div className="filter-collapse">
      {/* Header row — always visible */}
      <div className="filter-collapse-head" onClick={() => setOpen((v) => !v)}>
        <span className="filter-collapse-active">
          {activeLabel}
          {filter !== 'all' && activeCount > 0 && <span className="n" style={{ marginLeft: 4 }}>{activeCount}</span>}
          {filter === 'all' && <span className="n" style={{ marginLeft: 4 }}>{counts.all}</span>}
        </span>
        <span className="filter-collapse-hint">
          {open ? 'Filter' : 'Filter'}
        </span>
        <span className={'filter-collapse-chev' + (open ? ' open' : '')}>
          <Icon name="chevD" size={11} stroke={2} />
        </span>
      </div>

      {/* Expanded chips */}
      {open &&
      <div className="filter-bar filter-bar--facet" role="tablist" aria-label="Filter by type" style={{ padding: '4px 10px 8px' }}>
          <span className={'chip' + (filter === 'all' ? ' on' : '')} onClick={() => {setFilter('all');setOpen(false);}}>All <span className="n">{counts.all}</span></span>
          <span className={'chip' + (filter === 'hl' ? ' on' : '')} onClick={() => {setFilter('hl');setOpen(false);}}>Highlights {counts.hl > 0 && <span className="n">{counts.hl}</span>}</span>
          <span className={'chip' + (filter === 'notes' ? ' on' : '')} onClick={() => {setFilter('notes');setOpen(false);}}>Notes {counts.notes > 0 && <span className="n">{counts.notes}</span>}</span>
          <span className={'chip' + (filter === 'comm' ? ' on' : '')} onClick={() => {setFilter('comm');setOpen(false);}}>Comments {counts.comm > 0 && <span className="n">{counts.comm}</span>}</span>
          <span className={'chip' + (filter === 'sugg' ? ' on' : '')} onClick={() => {setFilter('sugg');setOpen(false);}}>Suggestions {counts.sugg > 0 && <span className="n">{counts.sugg}</span>}</span>
        </div>
      }
    </div>);

}

// ---------- Side rail ----------
// tabs: array of tab ids this rail shows, e.g. ['annotations','chat'] or ['outline']
// allTabs: all available tab ids (for the + picker)
const ALL_TAB_DEFS = [
{ id: 'annotations', label: 'Annotations', icon: 'comment' },
{ id: 'chat', label: 'Chat', icon: 'reply' },
{ id: 'outline', label: 'Outline', icon: 'bullet' },
{ id: 'search', label: 'Search', icon: 'search' }];


function SideRail({ mode = 'annotations', onMode, annotations, chat, heldCount = 0, readOnly = false, onShowAll, tabs = ['annotations', 'chat', 'outline'], onTabsChange, side = 'right' }) {
  const [filter, setFilter] = React.useState('all');
  const [showTabPicker, setShowTabPicker] = React.useState(false);
  const pickerRef = React.useRef(null);

  // Close picker on outside click
  React.useEffect(() => {
    if (!showTabPicker) return;
    function handleClick(e) {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setShowTabPicker(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTabPicker]);

  const open = annotations.filter((a) => !a.resolved);
  const counts = {
    all: open.length,
    hl: open.filter((a) => a.type === 'highlight').length,
    notes: open.filter((a) => (a.audience === 'private' || a.type === 'note' || a.author === 'import') && !a.diff && a.type !== 'highlight').length,
    comm: open.filter((a) => a.audience === 'outbound' && !a.diff).length,
    sugg: open.filter((a) => !!a.diff || !!a.suggestedText).length,
    pending: open.length,
    resolved: annotations.length - open.length
  };
  const matches = (a) => {
    if (filter === 'all') return true;
    if (filter === 'hl') return a.type === 'highlight';
    if (filter === 'sugg') return !!a.diff || !!a.suggestedText;
    if (filter === 'notes') return (a.audience === 'private' || a.type === 'note' || a.author === 'import') && !a.diff && a.type !== 'highlight';
    if (filter === 'comm') return a.audience === 'outbound' && !a.diff;
    return true;
  };
  const visible = annotations.filter(matches);

  // Collapse to icons when more than 3 tabs
  const compact = tabs.length > 3;

  // Ensure active mode is one of the visible tabs
  const activeMode = tabs.includes(mode) ? mode : tabs[0];

  function tabLabel(id) {
    if (id === 'annotations') return <>Annotations{!compact && <span className="count">{counts.pending}</span>}</>;
    if (id === 'chat') return <>Chat{!compact && <span className="count">3</span>}</>;
    if (id === 'outline') return 'Outline';
    if (id === 'search') return 'Search';
    return id;
  }

  function tabIcon(id) {
    const def = ALL_TAB_DEFS.find((t) => t.id === id);
    return <Icon name={def?.icon || 'file'} size={13} />;
  }

  return (
    <aside className="rail">
      <div className="rail-tabs">
        {tabs.map((id) =>
        <div
          key={id}
          className={'rail-tab' + (activeMode === id ? ' active' : '') + (compact ? ' compact' : '')}
          onClick={() => onMode?.(id)}
          title={compact ? ALL_TAB_DEFS.find((t) => t.id === id)?.label : undefined}>
          
            {compact ? tabIcon(id) : tabLabel(id)}
          </div>
        )}
        <span className="rail-spacer" />

        {/* + tab picker */}
        <div style={{ position: 'relative' }} ref={pickerRef}>
          <button
            className="rail-flip-btn"
            title="Add or remove tabs"
            onClick={() => setShowTabPicker((v) => !v)}
            style={{ fontWeight: 600, fontSize: 13 }}>
            
            <Icon name="plus" size={12} />
          </button>
          {showTabPicker &&
          <div className="rail-tab-picker">
              <div className="rail-tab-picker-head">Tabs in this panel</div>
              {ALL_TAB_DEFS.map((def) => {
              const active = tabs.includes(def.id);
              return (
                <div
                  key={def.id}
                  className={'rail-tab-picker-item' + (active ? ' on' : '')}
                  onClick={() => {
                    if (active && tabs.length === 1) return; // keep at least one
                    const next = active ? tabs.filter((t) => t !== def.id) : [...tabs, def.id];
                    onTabsChange?.(next);
                    if (active && def.id === activeMode) onMode?.(next[0]);
                  }}>
                  
                    <span className="rail-tab-picker-check">{active ? <Icon name="check" size={10} stroke={2.5} /> : null}</span>
                    <Icon name={def.icon} size={12} />
                    <span>{def.label}</span>
                  </div>);

            })}
            </div>
          }
        </div>

        {/* Close panel */}
        <ShortcutTooltip label="Hide panel" keys="⌘⇧P" placement="left">
          <button className="rail-flip-btn" title="Hide panel">
            <Icon name="x" size={12} stroke={1.8} />
          </button>
        </ShortcutTooltip>
      </div>

      {readOnly &&
      <div className="rail-info">
          <Icon name="lock" size={12} />
          <div>
            <strong>Read-only</strong> · .docx is reviewed, never overwritten.
            <a href="#" onClick={(e) => e.preventDefault()}>What changes?</a>
          </div>
        </div>
      }

      {heldCount > 0 &&
      <div className="rail-banner held">
          <span className="held-dot" />
          <span><strong>{heldCount}</strong> annotation{heldCount === 1 ? '' : 's'} held in Solo</span>
          <button className="held-cta" onClick={onShowAll}>Show all</button>
        </div>
      }

      {activeMode === 'annotations' &&
      <div className="rail-body">
          <CollapsibleFilterBar filter={filter} setFilter={setFilter} counts={counts} />
          {visible.map((a, i) => <AnnotationCard key={a.id} a={a} active={i === 0} />)}
          {readOnly &&
        <div className="float-card" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Apply to .docx</div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                Export accepted annotations as Word tracked changes. The original file is never overwritten — a copy is saved alongside.
              </div>
              <button className="btn-primary" style={{ width: '100%' }}>
                <Icon name="check" size={11} stroke={2.4} /> Apply changes…
              </button>
            </div>
        }
        </div>
      }

      {activeMode === 'chat' && <ChatPanel chat={chat} />}
      {activeMode === 'outline' && <OutlinePanel />}
      {activeMode === 'search' && <SearchPanel />}
    </aside>);

}

// ---------- Outline (with search) ----------
function OutlinePanel() {
  const [query, setQuery] = React.useState('');
  const items = [
  { lvl: 1, text: 'Q2 Progress Review — Self-Service Dashboard', annos: 1 },
  { lvl: 2, text: 'What worked', active: true, annos: 2 },
  { lvl: 2, text: 'Where the dashboard stalled', annos: 1 },
  { lvl: 3, text: 'Read-layer rebuild', annos: 0 },
  { lvl: 2, text: 'Outlook for Q3', annos: 1 }];

  const wc = { words: 318, paras: 7, read: 2 };
  const MOCK_RESULTS = [
  { text: 'simplify onboarding', para: 'The project launched in early 2025…' },
  { text: 'Onboarding completion', para: 'Onboarding completion climbed from 34% to 71%…' },
  { text: 'onboarding routes users', para: 'Two factors compounded the gain…' }];

  const results = query.trim().length > 1 ?
  MOCK_RESULTS.filter((r) => r.text.toLowerCase().includes(query.toLowerCase())) :
  null;

  return (
    <div className="rail-body outline-body" style={{ display: 'flex', flexDirection: 'column', padding: 0 }}>
      {/* Search field at top of outline */}
      <div className="outline-search-wrap">
        <Icon name="search" size={13} />
        <input
          className="outline-search"
          placeholder="Find in document…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search document" />
        
        {query &&
        <button className="outline-search-clear" onClick={() => setQuery('')}>
            <Icon name="x" size={11} stroke={1.8} />
          </button>
        }
      </div>

      {results !== null ?
      <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
          <div className="outline-meta mono" style={{ padding: '0 14px 8px' }}>
            {results.length} result{results.length !== 1 ? 's' : ''} for "{query}"
          </div>
          {results.length === 0 ?
        <div style={{ padding: '20px 14px', fontSize: 13, color: 'var(--ink-faint)', textAlign: 'center' }}>No matches</div> :
        results.map((r, i) =>
        <div key={i} className={'search-result' + (i === 0 ? ' active' : '')}>
                <div className="search-result-match">{r.text}</div>
                <div className="search-result-ctx">{r.para}</div>
              </div>
        )
        }
          {results.length > 0 &&
        <div className="search-replace-bar">
              <input className="outline-search" placeholder="Replace with…" style={{ fontSize: 12 }} />
              <button className="search-replace-btn">Replace</button>
              <button className="search-replace-btn">All</button>
            </div>
        }
        </div> :

      <>
          <div className="outline-meta mono" style={{ padding: '8px 14px 4px' }}>
            <span>{wc.words} words</span>
            <span className="dot-sep">·</span>
            <span>{wc.paras} ¶</span>
            <span className="dot-sep">·</span>
            <span>{wc.read} min read</span>
          </div>
          <div className="outline-list">
            {items.map((it, i) =>
          <div key={i} className={'outline-item lvl-' + it.lvl + (it.active ? ' active' : '')}>
                <span className="outline-tick" />
                <span className="outline-text">{it.text}</span>
                {it.annos > 0 && <span className="outline-anno-dot">{it.annos}</span>}
              </div>
          )}
          </div>
          <div className="outline-foot mono faint">
            H1–H3 only · click to jump · ⌥↑↓ to reorder
          </div>
        </>
      }
    </div>);

}

// ---------- Chat ----------
function ChatPanel({ chat }) {
  return (
    <>
      <div className="rail-body">
        <div className="chat-stream">
          {chat.map((m, i) =>
          <div key={i} className={'chat-msg ' + m.from}>
              <div className="who">
                <span className={'author-dot ' + m.from} />
                <strong style={{ color: m.from === 'claude' ? 'var(--author-claude)' : 'var(--author-user)' }}>
                  {m.from === 'user' ? 'You' : 'Claude'}
                </strong>
                <span className="mono faint" style={{ fontSize: 10 }}>{m.time}</span>
              </div>
              {m.anchor && <div className="chat-anchor">"{m.anchor}"</div>}
              <div className="chat-bubble">{m.body}</div>
            </div>
          )}
          <div className="chat-msg claude">
            <div className="who">
              <span className="author-dot claude" />
              <strong style={{ color: 'var(--author-claude)' }}>Claude</strong>
              <span className="mono faint" style={{ fontSize: 10 }}>typing…</span>
            </div>
            <div className="chat-typing"><span /><span /><span /></div>
          </div>
        </div>
      </div>
      <div className="chat-input">
        <div style={{ flex: 1 }}>
          <div className="chat-attach">
            <Icon name="quote" size={11} />
            "the dashboard timeline slipped due to…"
            <span className="x"><Icon name="x" size={10} /></span>
          </div>
          <textarea placeholder="Ask Claude about the selection, or type a message…" />
        </div>
        <ShortcutTooltip label="Send" keys="⌘↵" placement="top">
          <button className="btn-primary" style={{ height: 36, padding: '0 14px' }} aria-label="Send">Send</button>
        </ShortcutTooltip>
      </div>
    </>);

}

// ---------- Status bar ----------
// Matches StatusBar.svelte: connection dot left, inline name editor center,
// held-count pill (solo mode only), saving indicator, Claude status right.
function StatusBar({ claudeState = 'reading', dirty = true, saving = false, heldCount = 0, mode = 'tandem', onShowHeld, paged = false, docName, crumb = '~/work/q2-review' }) {
  const [name, setName] = React.useState('bryan');
  return (
    <div className="statusbar">
      <div className="left">
        <span className="sb-dot green" />
        <span>Connected</span>
        <span className="faint">·</span>
        <span>2 docs open</span>
        {saving ?
        <>
            <span className="faint">·</span>
            <span style={{ color: 'var(--accent)' }}>Saving…</span>
          </> :

        <>
            <span className="faint">·</span>
            <span>{dirty ? 'unsaved' : 'saved 12s ago'}</span>
          </>
        }
        {paged &&
        <>
            <span className="faint">·</span>
            <span>Page <strong>1</strong> of 2</span>
          </>
        }
        {/* Held-count pill — only shown in Solo mode, matches StatusBar.svelte */}
        {heldCount > 0 && mode === 'solo' &&
        <button className="sb-held" onClick={onShowHeld} title="Show held annotations — switches to Tandem">
            <span className="held-dot" />
            <strong>{heldCount}</strong> held
          </button>
        }
      </div>
      {/* Inline name editor — matches StatusBar.svelte user-name-input */}
      <div className="center">
        <span className="faint" style={{ fontSize: 10 }}>You:</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Display name"
          title="Your display name"
          maxLength={32}
          style={{
            background: 'transparent', border: 'none',
            borderBottom: '1px dashed transparent', color: 'var(--ink-muted)',
            font: 'inherit', fontSize: 11, width: 72, outline: 'none', padding: '0 2px'
          }}
          onFocus={(e) => e.target.style.borderBottomColor = 'var(--ink-muted)'}
          onBlur={(e) => e.target.style.borderBottomColor = 'transparent'} />
        
      </div>
      <div className="right">
        <span className="faint">claude</span>
        <span className={'claude-pulse' + (claudeState === 'idle' ? ' idle' : '')} />
        <span style={{ color: 'var(--author-claude)' }}>{mode === 'solo' ? 'paused · Solo' : claudeState}</span>
      </div>
    </div>);

}

// ---------- Sample data ----------
// Audience-first model. Records carry `audience: 'private' | 'outbound'`.
// Renderer dispatches via AnnotationCard:
//   diff/suggestedText      → suggestion
//   type === 'highlight'    → highlight
//   author === 'claude'     → Claude comment
//   audience === 'private'  → note (slate edge; promotable to comment)
//   audience === 'outbound' → user comment (cobalt edge; Claude notified)
// `author === 'import'` arrives as a private note awaiting triage.
const ANNOS = [
{
  // Claude suggestion: type='comment' + suggestedText in real data
  id: 'a1', author: 'claude', type: 'comment', audience: 'outbound', time: '2m',
  snippet: 'simplify onboarding',
  diff: { del: 'simplify onboarding', add: 'streamline first-run setup' }
},
{
  // Claude comment (no replacement)
  id: 'a2', author: 'claude', type: 'comment', audience: 'outbound', time: '4m',
  snippet: 'in line with projections',
  body: 'Do you have the actual % drop, or should I quote the Q1 OKR target here?'
},
{
  // User private note — slate edge, promotable to comment
  id: 'a3', author: 'user', type: 'note', audience: 'private', time: '8m',
  snippet: 'slipped',
  body: 'Need to soften — exec audience reads "slipped" as missed deadline.'
},
{
  // User comment directed at Claude
  id: 'a4', author: 'user', type: 'comment', audience: 'outbound', time: '11m',
  snippet: 'During the build, the data team flagged…',
  body: 'Add the original RFC link here once Sami sends it over.'
},
{
  // Imported .docx comment — arrives as private note pending triage
  id: 'a5', author: 'import', type: 'note', audience: 'private', time: '1h',
  snippet: 'reusable across /billing, /usage…',
  body: 'Worth a callout box — strongest framing of the slip as a net positive.'
}];


const CHAT = [
{ from: 'user', time: '2:14 PM', anchor: 'simplify onboarding', body: 'Can you suggest a more specific phrasing here? "Simplify" feels generic.' },
{ from: 'claude', time: '2:14 PM', body: 'I dropped a suggestion in the panel — "streamline first-run setup" reads more concrete and matches the metric you cite (34→71% completion).' },
{ from: 'user', time: '2:18 PM', body: 'Good. Also: anywhere this report sounds defensive about the slip?' }];


// ---------- Composite ----------
function ShortcutsModal({ onClose, platform = typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win' }) {
  const fmt = (s) => window.formatShortcut(s, platform);
  const groups = [
  { title: 'Editing', items: [
    [fmt('⌘B'), 'Bold'], [fmt('⌘I'), 'Italic'], [fmt('⌘K'), 'Link'],
    [fmt('⌘Z') + ' / ' + fmt('⌘⇧Z'), 'Undo / Redo'], ['/', 'Open block menu']]
  },
  { title: 'Create annotations', items: [
    [fmt('⏎'), 'Note to self (private)'], [fmt('⌘⏎'), 'Comment to Claude'],
    [fmt('⌘⇧H'), 'Highlight']]
  },
  { title: 'Review annotations', items: [
    ['Tab', 'Next annotation'], [fmt('⇧Tab'), 'Previous annotation'],
    ['Y', 'Accept'], ['N', 'Dismiss'], ['Z', 'Undo last action']]
  },
  { title: 'App', items: [
    [fmt('⌘F'), 'Find in document'], ['?', 'Keyboard shortcuts'],
    [fmt('⌘,'), 'Settings'], [fmt('⌃Tab'), 'Cycle tabs'],
    [fmt('⌘S'), 'Save document']]
  }];

  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h3>Keyboard shortcuts</h3>
          <button className="tb-icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="x" size={12} /></button>
        </div>
        <div className="shortcuts-grid">
          {groups.map((g) =>
          <section className="shortcuts-group" key={g.title}>
              <h4>{g.title}</h4>
              <ul>
                {g.items.map(([k, label]) =>
              <li key={k}><span className="kbd">{k}</span><span>{label}</span></li>
              )}
              </ul>
            </section>
          )}
        </div>
        <div className="shortcuts-foot">
          <span className="faint">Most shortcuts work everywhere.</span>
          <a className="link" href="#">Full reference →</a>
        </div>
      </div>
    </div>);

}

function TandemApp({ tw, connection = 'ok', initialShortcutsOpen = false }) {
  const [mode, setMode] = useState('tandem');
  const [panelLayout, setPanelLayout] = useState(tw.panelLayout || 'right');
  const [theme, setTheme] = useState(tw.theme || 'light');
  const [railMode, setRailMode] = useState('annotations');
  const [leftRailMode, setLeftRailMode] = useState('outline');
  const [shortcutsOpen, setShortcutsOpen] = useState(initialShortcutsOpen);
  const [rightTabs, setRightTabs] = useState(['annotations', 'chat']);
  const [leftTabs, setLeftTabs] = useState(['outline']);
  const platform = tw.platform || (window.detectPlatform ? window.detectPlatform() : 'win');

  useEffect(() => {setPanelLayout(tw.panelLayout || 'right');}, [tw.panelLayout]);
  useEffect(() => {setTheme(tw.theme || 'light');}, [tw.theme]);

  const isThreePanel = panelLayout === 'three';

  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent || undefined,
      '--editor-font': tw.editorFont === 'sans' ? 'var(--font-sans)' : tw.editorFont === 'mono' ? 'var(--font-mono)' : 'var(--font-serif)',
      '--editor-size': (tw.editorSize || 17) + 'px',
      '--rail-w': (tw.railWidth || 360) + 'px'
    }}>
      <TopToolbar
        docName="q2-dashboard-review.md"
        dirty={true}
        mode={mode}
        onMode={setMode}
        panelLayout={panelLayout}
        onPanelLayout={setPanelLayout}
        theme={theme}
        onTheme={setTheme}
        onTweaks={() => window.parent?.postMessage({ type: '__edit_mode_dismissed' }, '*')}
        onShortcuts={() => setShortcutsOpen((v) => !v)}
        platform={platform} />

      <DocTabs
        docs={[
        { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
        { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
        { id: 'd3', name: 'partner-update.docx', ext: 'W' }]
        }
        active="d1" />

      <FormattingBar
        onToggleLeft={() => setPanelLayout((v) => v === 'three' ? 'right' : v === 'left' ? 'hidden' : 'left')}
        onToggleRight={() => setPanelLayout((v) => v === 'hidden' ? 'right' : 'hidden')}
        leftVisible={panelLayout === 'three' || panelLayout === 'left'}
        rightVisible={panelLayout !== 'hidden'} />
      

      <div className="main" data-rail={isThreePanel ? 'three' : panelLayout}>
        {/* Left rail — three-panel only, defaults to Outline */}
        {isThreePanel &&
        <SideRail
          mode={leftRailMode}
          onMode={setLeftRailMode}
          annotations={ANNOS}
          chat={CHAT}
          tabs={leftTabs}
          onTabsChange={setLeftTabs}
          side="left" />

        }

        <EditorBody showMini={tw.showMini ?? true} showCursor={true} connection={connection} />

        {/* Right rail */}
        {panelLayout !== 'hidden' &&
        <SideRail
          mode={railMode}
          onMode={setRailMode}
          annotations={ANNOS}
          chat={CHAT}
          tabs={isThreePanel ? rightTabs : ['annotations', 'chat', 'outline']}
          onTabsChange={isThreePanel ? setRightTabs : undefined}
          side="right" />

        }
      </div>

      <StatusBar claudeState="annotating" docName="q2-dashboard-review.md" dirty={true} />
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} platform={platform} />}
    </div>);

}

window.TandemApp = TandemApp;
window.EditorBody = EditorBody;
window.TopToolbar = TopToolbar;
window.DocTabs = DocTabs;
window.FormattingBar = FormattingBar;
window.SideRail = SideRail;
window.LegacyAnnotationCard = LegacyAnnotationCard;
window.StatusBar = StatusBar;
window.ANNOS = ANNOS;
window.CHAT = CHAT;
window.AnnotationCard = AnnotationCard;
window.SelectionMiniToolbar = SelectionMiniToolbar;
window.SlashMenu = SlashMenu;