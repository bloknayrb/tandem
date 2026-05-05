/* Tandem editor — main app shell, all states */

const { useState, useEffect, useRef } = React;

// ---------- Window controls (custom titlebar) ----------
// Platform-aware traffic lights / min-max-close. The whole titlebar is
// draggable except interactive children (data-tauri-drag-region honored
// at runtime; in mocks the attribute is decorative).
function WinControls({ platform = (typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win') }) {
  if (platform === 'mac') {
    return (
      <div className="winctl mac" data-no-drag>
        <button className="wc close" aria-label="Close" title="Close"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 1l4 4M5 1l-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
        <button className="wc min" aria-label="Minimize" title="Minimize"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1 3h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg></button>
        <button className="wc max" aria-label="Zoom" title="Zoom"><svg width="6" height="6" viewBox="0 0 6 6"><path d="M1.5 1.5h3v3h-3z" fill="none" stroke="currentColor" strokeWidth="1.1"/></svg></button>
      </div>
    );
  }
  // Windows / Linux: trailing edge, square buttons
  return (
    <div className="winctl win" data-no-drag>
      <button className="wcw" aria-label="Minimize" title="Minimize"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" strokeWidth="1"/></svg></button>
      <button className="wcw" aria-label="Maximize" title="Maximize"><svg width="10" height="10" viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1"/></svg></button>
      <button className="wcw close" aria-label="Close" title="Close"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1"/></svg></button>
    </div>
  );
}

// ---------- Toolbar ----------
function TopToolbar({ docName = 'progress-report.md', dirty = true, mode = 'tandem', onMode, panelLayout = 'right', onPanelLayout, theme = 'light', onTheme, onTweaks, onShortcuts, claudeState = 'reading', platform = (typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win') }) {
  return (
    <div className={'toolbar titlebar plat-' + platform} data-tauri-drag-region>
      {platform === 'mac' && <WinControls platform="mac"/>}

      <div className="brand" data-no-drag>
        <span className="mark" aria-hidden="true">
          <img src="logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}/>
        </span>
        Tandem
      </div>

      <ShortcutTooltip label="Undo" keys="⌘Z" platform={platform}>
        <button className="tb-icon-btn" aria-label="Undo" data-no-drag><Icon name="undo"/></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Redo" keys="⌘⇧Z" platform={platform}>
        <button className="tb-icon-btn" aria-label="Redo" data-no-drag><Icon name="redo"/></button>
      </ShortcutTooltip>

      <div className="tb-divider" />

      <ShortcutTooltip label="Search" keys="⌘F" platform={platform}>
        <button className="tb-icon-btn" aria-label="Search" data-no-drag><Icon name="search"/></button>
      </ShortcutTooltip>

      <div style={{ flex: 1 }} />

      <div className="seg" role="tablist" aria-label="Mode" data-no-drag>
        <button className={mode === 'solo' ? 'on' : ''} onClick={() => onMode?.('solo')}>Solo</button>
        <button className={mode === 'tandem' ? 'on' : ''} onClick={() => onMode?.('tandem')}>Tandem</button>
      </div>

      <div className="claude-presence" title={`Claude: ${claudeState}`} data-no-drag>
        <span className={'claude-pulse' + (claudeState === 'idle' ? ' idle' : '')}/>
      </div>

      <div className="tb-divider" />

      <button className={'tb-icon-btn' + (panelLayout === 'left' ? ' active' : '')} title="Panel left" onClick={() => onPanelLayout?.('left')} data-no-drag><Icon name="panelL"/></button>
      <button className={'tb-icon-btn' + (panelLayout === 'right' ? ' active' : '')} title="Panel right" onClick={() => onPanelLayout?.('right')} data-no-drag><Icon name="panelR"/></button>
      <button className={'tb-icon-btn' + (panelLayout === 'hidden' ? ' active' : '')} title="Hide panel" onClick={() => onPanelLayout?.('hidden')} data-no-drag><Icon name="panelOff"/></button>

      <button className="tb-icon-btn" title="Toggle theme" onClick={() => onTheme?.(theme === 'light' ? 'dark' : 'light')} data-no-drag>
        <Icon name={theme === 'light' ? 'moon' : 'sun'}/>
      </button>
      <ShortcutTooltip label="Keyboard shortcuts" keys="⌘/" placement="left" platform={platform}>
        <button className="tb-icon-btn" aria-label="Keyboard shortcuts" onClick={onShortcuts} data-no-drag><Icon name="help"/></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Settings" keys="⌘," placement="left" platform={platform}>
        <button className="tb-icon-btn" aria-label="Settings" onClick={onTweaks} data-no-drag><Icon name="settings"/></button>
      </ShortcutTooltip>

      {platform !== 'mac' && <WinControls platform={platform}/>}
    </div>
  );
}

// ---------- Tabs ----------
function DocTabs({ docs, active, onSelect, recentOpen = false }) {
  return (
    <div className="tabs">
      {docs.map(d => (
        <div key={d.id} className={'tab' + (d.id === active ? ' active' : '')} onClick={() => onSelect?.(d.id)}>
          <span className="ext">{d.ext}</span>
          <span className="tab-name">{d.name}</span>
          {d.readOnly && <span className="ro-badge" title="Read-only · .docx — annotate without overwriting">RO</span>}
          {d.dirty && <span className="dirty" />}
          <span className="x"><Icon name="x" size={10} stroke={1.8}/></span>
        </div>
      ))}
      <div className="grow" />
      <div className="tab-add-wrap">
        <div className="tab-add" title="Open file"><Icon name="plus" size={12}/></div>
        {recentOpen && (
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
            <div className="recent-divider"/>
            <div className="recent-item action">
              <Icon name="plus" size={11}/>
              <span>Browse files…</span>
              <span className="recent-time">⌘O</span>
            </div>
            <div className="recent-item action">
              <Icon name="docMd" size={11}/>
              <span>New document</span>
              <span className="recent-time">⌘N</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Mini selection toolbar ----------
function SelectionMiniToolbar({ x, y, onPick, platform = (typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win') }) {
  return (
    <div className="mini-tb" style={{ left: x, top: y, transform: 'translate(-50%, -100%)', marginTop: -10 }}>
      <ShortcutTooltip label="Bold" keys="⌘B" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Bold"><Icon name="bold" size={14}/></button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Italic" keys="⌘I" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Italic"><Icon name="italic" size={14}/></button>
      </ShortcutTooltip>
      <button className="mini-btn" title="Strike"><Icon name="strike" size={14}/></button>
      <button className="mini-btn" title="Code"><Icon name="code" size={14}/></button>
      <ShortcutTooltip label="Link" keys="⌘K" placement="top" platform={platform}>
        <button className="mini-btn" aria-label="Link"><Icon name="link" size={14}/></button>
      </ShortcutTooltip>
      <div className="mini-divider" />
      <div className="mini-swatches" title="Highlight">
        <span className="mini-sw" style={{ background: 'rgba(234,179,8,0.45)' }}/>
        <span className="mini-sw" style={{ background: 'rgba(34,197,94,0.45)' }}/>
        <span className="mini-sw" style={{ background: 'rgba(96,165,250,0.45)' }}/>
        <span className="mini-sw" style={{ background: 'rgba(236,72,153,0.45)' }}/>
      </div>
      <div className="mini-divider" />
      <ShortcutTooltip label="Comment — choose Note or Send to Claude after typing" keys="⌘⇧M" placement="top" platform={platform}>
        <button className="mini-btn accent" aria-label="Comment" onClick={() => onPick?.('comment')}>
          <Icon name="comment" size={13}/> Comment
        </button>
      </ShortcutTooltip>
    </div>
  );
}

// ---------- Slash menu ----------
function SlashMenu({ x, y }) {
  const items = [
    { ic: 'H1', label: 'Heading 1', k: '#' },
    { ic: 'H2', label: 'Heading 2', k: '##' },
    { ic: '•', label: 'Bullet list', k: '-' },
    { ic: '1.', label: 'Numbered list', k: '1.' },
    { ic: '"', label: 'Quote', k: '>' },
    { ic: '< >', label: 'Code block', k: '```' },
  ];
  return (
    <div className="slash" style={{ left: x, top: y }}>
      {items.map((it, i) => (
        <div className={'slash-item' + (i === 0 ? ' sel' : '')} key={it.label}>
          <span className="ic">{it.ic}</span>
          <span>{it.label}</span>
          <span className="k">{it.k}</span>
        </div>
      ))}
    </div>
  );
}

// ---------- Editor body ----------
function EditorBody({ showMini = true, showCursor = true, showSlash = false, dimmed = false, connection = 'ok', docType = 'md' }) {
  const paged = docType === 'docx' || docType === 'doc';
  return (
    <div className={'editor-wrap' + (paged ? ' paged' : '')}>
      {connection === 'degraded' && (
        <div className="conn-banner" role="status">]
          <Icon name="wifi" size={13}/>
          <span><strong>Reconnecting…</strong> Claude is offline. Your edits are saved locally.</span>
          <button className="conn-retry">Retry now</button>
        </div>
      )}
      <div className="editor-scroll">
        <div className={'editor-doc' + (paged ? ' editor-doc--paged' : '')}>
          {paged ? (
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
                  <br/>— J. Patel, eng lead
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
            </>
          ) : (
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
                <br/>— J. Patel, eng lead
              </blockquote>

              <p className="para" data-tandem-author="user">
                Despite the slip, the rebuilt read layer is now reusable across <code>/billing</code>, <code>/usage</code>, and the upcoming admin console — work the original timeline would have spent on duplicated query code.
              </p>

              <h2>Outlook for Q3</h2>

              <p className="para" data-tandem-author="user">
                Dashboard cut-over is scheduled for <strong>August 12</strong>, with a two-week dark-launch period to validate query performance under production load.
              </p>
            </>
          )}
        </div>

        {showMini && <SelectionMiniToolbar x={420} y={300} />}
        {showSlash && <SlashMenu x={88} y={520} />}
      </div>
    </div>
  );
}

// ---------- Annotation card ----------
function AnnotationCard({ a, active }) {
  return (
    <div className={'acard' + (active ? ' active' : '') + (a.resolved ? ' resolved' : '')}>
      <div className="acard-head">
        <span className={'author-chip ' + a.author}>
          <span className={'author-dot ' + a.author}/>{a.author === 'user' ? 'You' : 'Claude'}
        </span>
        <span className={'acard-type ' + a.type}>{a.type}</span>
        <span className="acard-time">{a.time}</span>
      </div>
      {a.snippet && <div className="acard-snippet">"{a.snippet}"</div>}
      {a.diff ? (
        <div className="diff">
          <div className="diff-row del">{a.diff.del}</div>
          <div className="diff-row add">{a.diff.add}</div>
        </div>
      ) : a.body ? (
        <div className="acard-body">{a.body}</div>
      ) : null}
      <div className="acard-actions">
        {a.type === 'suggest' ? (
          <>
            <button className="btn-primary"><Icon name="check" size={11} stroke={2.4}/> Accept</button>
            <button className="btn-ghost btn-danger">Dismiss</button>
            <span className="btn-spacer"/>
            <button className="btn-ghost"><Icon name="reply" size={12}/> Reply</button>
          </>
        ) : a.type === 'question' ? (
          <>
            <button className="btn-primary">Answer</button>
            <button className="btn-ghost">Dismiss</button>
            <span className="btn-spacer"/>
            <button className="btn-ghost"><Icon name="more" size={12}/></button>
          </>
        ) : a.type === 'flag' ? (
          <>
            <button className="btn-primary">Resolve</button>
            <button className="btn-ghost">Dismiss</button>
            <span className="btn-spacer"/>
            <button className="btn-ghost"><Icon name="more" size={12}/></button>
          </>
        ) : (
          <>
            <button className="btn-ghost"><Icon name="reply" size={12}/> Reply</button>
            <span className="btn-spacer"/>
            <button className="btn-ghost"><Icon name="check" size={12}/> Resolve</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Side rail ----------
function SideRail({ mode = 'annotations', onMode, annotations, chat, heldCount = 0, readOnly = false, onShowAll, statusFilter = 'open' }) {
  const counts = {
    pending: annotations.filter(a => !a.resolved).length,
    resolved: annotations.filter(a => a.resolved).length,
  };
  return (
    <aside className="rail">
      <div className="rail-tabs">
        <div className={'rail-tab' + (mode === 'annotations' ? ' active' : '')} onClick={() => onMode?.('annotations')}>
          Annotations <span className="count">{counts.pending}</span>
        </div>
        <div className={'rail-tab' + (mode === 'chat' ? ' active' : '')} onClick={() => onMode?.('chat')}>
          Chat <span className="count">3</span>
        </div>
        <div className={'rail-tab' + (mode === 'outline' ? ' active' : '')} onClick={() => onMode?.('outline')}>
          Outline
        </div>
        <span className="rail-spacer"/>
        <span className="rail-act" title="More"><Icon name="more" size={14}/></span>
      </div>

      {readOnly && (
        <div className="rail-info">
          <Icon name="lock" size={12}/>
          <div>
            <strong>Read-only</strong> · .docx is reviewed, never overwritten.
            <a href="#" onClick={e => e.preventDefault()}>What changes?</a>
          </div>
        </div>
      )}

      {heldCount > 0 && (
        <div className="rail-banner held">
          <span className="held-dot"/>
          <span><strong>{heldCount}</strong> annotation{heldCount === 1 ? '' : 's'} held in Solo</span>
          <button className="held-cta" onClick={onShowAll}>Show all</button>
        </div>
      )}

      {mode === 'annotations' && (
        <div className="rail-body">
          <div className="filter-bar filter-bar--status" role="tablist" aria-label="Filter by status">
            <span className={'chip' + (statusFilter === 'open' ? ' on' : '')}>Open <span className="n">{counts.pending}</span></span>
            <span className={'chip' + (statusFilter === 'resolved' ? ' on' : '')}>Resolved <span className="n">{counts.resolved}</span></span>
            <span className={'chip' + (statusFilter === 'all' ? ' on' : '')}>All <span className="n">{counts.pending + counts.resolved}</span></span>
          </div>
          <div className="filter-bar filter-bar--facet" aria-label="Filter by author or type">
            <span className="chip"><span className="author-dot claude"/> Claude <span className="n">3</span></span>
            <span className="chip"><span className="author-dot user"/> You <span className="n">2</span></span>
            <span className="chip">Suggestions <span className="n">2</span></span>
            <span className="chip">Flags <span className="n">1</span></span>
            <span className="chip imported"><Icon name="docW" size={9}/> Imported <span className="n">2</span></span>
          </div>
          {annotations.map((a, i) => (
            <AnnotationCard key={a.id} a={a} active={i === 0} />
          ))}
          {readOnly && (
            <div className="float-card" style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Apply to .docx</div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                Export accepted annotations as Word tracked changes. The original file is never overwritten — a copy is saved alongside.
              </div>
              <button className="btn-primary" style={{ width: '100%' }}>
                <Icon name="check" size={11} stroke={2.4}/> Apply changes…
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'chat' && <ChatPanel chat={chat} />}

      {mode === 'outline' && <OutlinePanel />}
    </aside>
  );
}

// ---------- Outline ----------
function OutlinePanel() {
  const items = [
    { lvl: 1, text: 'Q2 Progress Review — Self-Service Dashboard', annos: 1 },
    { lvl: 2, text: 'What worked', active: true, annos: 2 },
    { lvl: 2, text: 'Where the dashboard stalled', annos: 1 },
    { lvl: 3, text: 'Read-layer rebuild', annos: 0 },
    { lvl: 2, text: 'Outlook for Q3', annos: 1 },
  ];
  const wc = { words: 318, paras: 7, read: 2 };
  return (
    <div className="rail-body outline-body">
      <div className="outline-meta mono">
        <span>{wc.words} words</span>
        <span className="dot-sep">·</span>
        <span>{wc.paras} ¶</span>
        <span className="dot-sep">·</span>
        <span>{wc.read} min read</span>
      </div>
      <div className="outline-list">
        {items.map((it, i) => (
          <div key={i} className={'outline-item lvl-' + it.lvl + (it.active ? ' active' : '')}>
            <span className="outline-tick"/>
            <span className="outline-text">{it.text}</span>
            {it.annos > 0 && <span className="outline-anno-dot" title={`${it.annos} annotation${it.annos === 1 ? '' : 's'}`}>{it.annos}</span>}
          </div>
        ))}
      </div>
      <div className="outline-foot mono faint">
        H1–H3 only · click to jump · ⌥↑↓ to reorder
      </div>
    </div>
  );
}

// ---------- Chat ----------
function ChatPanel({ chat }) {
  return (
    <>
      <div className="rail-body">
        <div className="chat-stream">
          {chat.map((m, i) => (
            <div key={i} className={'chat-msg ' + m.from}>
              <div className="who">
                <span className={'author-dot ' + m.from}/>
                <strong style={{ color: m.from === 'claude' ? 'var(--author-claude)' : 'var(--author-user)' }}>
                  {m.from === 'user' ? 'You' : 'Claude'}
                </strong>
                <span className="mono faint" style={{ fontSize: 10 }}>{m.time}</span>
              </div>
              {m.anchor && <div className="chat-anchor">"{m.anchor}"</div>}
              <div className="chat-bubble">{m.body}</div>
            </div>
          ))}
          <div className="chat-msg claude">
            <div className="who">
              <span className="author-dot claude"/>
              <strong style={{ color: 'var(--author-claude)' }}>Claude</strong>
              <span className="mono faint" style={{ fontSize: 10 }}>typing…</span>
            </div>
            <div className="chat-typing"><span/><span/><span/></div>
          </div>
        </div>
      </div>
      <div className="chat-input">
        <div style={{ flex: 1 }}>
          <div className="chat-attach">
            <Icon name="quote" size={11}/>
            "the dashboard timeline slipped due to…"
            <span className="x"><Icon name="x" size={10}/></span>
          </div>
          <textarea placeholder="Ask Claude about the selection, or type a message…" />
        </div>
        <ShortcutTooltip label="Send" keys="⌘↵" placement="top">
          <button className="btn-primary" style={{ height: 36, padding: '0 14px' }} aria-label="Send">Send</button>
        </ShortcutTooltip>
      </div>
    </>
  );
}

// ---------- Status bar ----------
function StatusBar({ claudeState = 'reading', dirty = true, heldCount = 0, mode = 'tandem', onShowHeld, paged = false, docName, crumb = '~/work/q2-review' }) {
  return (
    <div className="statusbar">
      <div className="left">
        {docName && (
          <>
            <span className="sb-doc">
              <Icon name={docName.endsWith('.docx') ? 'docW' : 'docMd'} size={12}/>
              <span className="sb-docname">{docName}</span>
              {dirty && <span className="sb-dirty" title="Unsaved changes"/>}
            </span>
            <span className="sb-crumb">{crumb}</span>
            <span className="faint">·</span>
          </>
        )}
        <span className="sb-dot green"/>
        <span>Connected</span>
        <span className="faint">·</span>
        <span>2 docs</span>
        <span className="faint">·</span>
        <span>{dirty ? 'unsaved' : 'saved 12s ago'}</span>
        {paged && (
          <>
            <span className="faint">·</span>
            <span>Page <strong>1</strong> of 2</span>
            <span className="faint">·</span>
            <span>Letter · 1″</span>
          </>
        )}
        {heldCount > 0 && (
          <button className="sb-held" onClick={onShowHeld} title="Click to show held annotations (switches to Tandem)">
            <span className="held-dot"/>
            <span><strong>{heldCount}</strong> held</span>
          </button>
        )}
      </div>
      <div className="center">
        <span className="faint">you</span>
        <span className="sb-name"><input defaultValue="bryan" /></span>
      </div>
      <div className="right">
        <span className="faint">claude</span>
        <span className={'claude-pulse' + (claudeState === 'idle' ? ' idle' : '')}/>
        <span style={{ color: 'var(--author-claude)' }}>{mode === 'solo' ? 'paused (Solo)' : claudeState}</span>
      </div>
    </div>
  );
}

// ---------- Sample data ----------
// Sample data — note: real model has 3 types only (comment/flag/highlight).
// `suggest` and `question` here are visual variants the renderer derives via
// `suggestedText` and `directedAt` discriminator fields. Kept as `type` strings
// here only because this mock's renderer keys off them; engineering should map
// suggest→{type:'comment',suggestedText}, question→{type:'comment',directedAt:'claude'}.
const ANNOS = [
  {
    id: 'a1', author: 'claude', type: 'suggest', time: '2m',
    snippet: 'simplify onboarding',
    diff: { del: 'simplify onboarding', add: 'streamline first-run setup' },
  },
  {
    id: 'a2', author: 'claude', type: 'question', time: '4m',
    snippet: 'in line with projections',
    body: 'Do you have the actual % drop, or should I quote the Q1 OKR target here?',
  },
  {
    id: 'a3', author: 'user', type: 'flag', time: '8m',
    snippet: 'slipped',
    body: 'Need to soften — exec audience reads "slipped" as missed deadline. Suggest "extended scope"?',
  },
  {
    id: 'a4', author: 'user', type: 'comment', time: '11m',
    snippet: 'During the build, the data team flagged…',
    body: 'Add the original RFC link here once Sami sends it over.',
  },
  {
    id: 'a5', author: 'claude', type: 'highlight', time: '1h',
    snippet: 'reusable across /billing, /usage…',
    body: 'Worth a callout box — this is the strongest framing of the slip as a net positive.',
  },
];

const CHAT = [
  { from: 'user', time: '2:14 PM', anchor: 'simplify onboarding', body: 'Can you suggest a more specific phrasing here? "Simplify" feels generic.' },
  { from: 'claude', time: '2:14 PM', body: 'I dropped a suggestion in the panel — "streamline first-run setup" reads more concrete and matches the metric you cite (34→71% completion).' },
  { from: 'user', time: '2:18 PM', body: 'Good. Also: anywhere this report sounds defensive about the slip?' },
];

// ---------- Composite ----------
function ShortcutsModal({ onClose, platform = (typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win') }) {
  const fmt = (s) => window.formatShortcut(s, platform);
  const groups = [
    { title: 'Editing', items: [
      [fmt('⌘B'), 'Bold'], [fmt('⌘I'), 'Italic'], [fmt('⌘K'), 'Link'],
      [fmt('⌘Z') + ' / ' + fmt('⌘⇧Z'), 'Undo / Redo'], ['/', 'Open block menu'],
    ]},
    { title: 'Create annotations', items: [
      [fmt('⏎'), 'Note to self'], [fmt('⌘⏎'), 'Send to Claude'],
      [fmt('⌘⇧H'), 'Highlight'],
    ]},
    { title: 'Triage annotations', items: [
      ['Tab', 'Next annotation'], [fmt('⇧Tab'), 'Previous annotation'],
      ['Y', 'Accept'], ['N', 'Dismiss'], ['Z', 'Undo last action'],
    ]},
    { title: 'App', items: [
      [fmt('⌘F'), 'Find in document'], [fmt('⌘/'), 'This menu'],
      [fmt('⌘,'), 'Settings'], [fmt('⌘⇧S'), 'Toggle Solo / Tandem'],
    ]},
  ];
  return (
    <div className="shortcuts-overlay" onClick={onClose}>
      <div className="shortcuts-modal" role="dialog" aria-label="Keyboard shortcuts" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h3>Keyboard shortcuts</h3>
          <button className="tb-icon-btn" onClick={onClose} title="Close (Esc)"><Icon name="x" size={12}/></button>
        </div>
        <div className="shortcuts-grid">
          {groups.map(g => (
            <section className="shortcuts-group" key={g.title}>
              <h4>{g.title}</h4>
              <ul>
                {g.items.map(([k, label]) => (
                  <li key={k}><span className="kbd">{k}</span><span>{label}</span></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="shortcuts-foot">
          <span className="faint">Most shortcuts work everywhere.</span>
          <a className="link" href="#">Full reference →</a>
        </div>
      </div>
    </div>
  );
}

function TandemApp({ tw, connection = 'ok', initialShortcutsOpen = false }) {
  const [mode, setMode] = useState('tandem');
  const [panelLayout, setPanelLayout] = useState(tw.panelLayout || 'right');
  const [theme, setTheme] = useState(tw.theme || 'light');
  const [railMode, setRailMode] = useState('annotations');
  const [shortcutsOpen, setShortcutsOpen] = useState(initialShortcutsOpen);
  const platform = tw.platform || (window.detectPlatform ? window.detectPlatform() : 'win');

  useEffect(() => { setPanelLayout(tw.panelLayout || 'right'); }, [tw.panelLayout]);
  useEffect(() => { setTheme(tw.theme || 'light'); }, [tw.theme]);

  return (
    <div className="app" data-theme={theme} data-density={tw.density || 'cozy'} style={{
      '--accent': tw.accent || undefined,
      '--editor-font': tw.editorFont === 'sans' ? 'var(--font-sans)' : tw.editorFont === 'mono' ? 'var(--font-mono)' : 'var(--font-serif)',
      '--editor-size': (tw.editorSize || 17) + 'px',
      '--rail-w': (tw.railWidth || 360) + 'px',
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
        onShortcuts={() => setShortcutsOpen(v => !v)}
        platform={platform}
      />
      <DocTabs
        docs={[
          { id: 'd1', name: 'q2-dashboard-review.md', ext: 'M', dirty: true },
          { id: 'd2', name: 'rfc-007-readlayer.md', ext: 'M' },
          { id: 'd3', name: 'partner-update.docx', ext: 'W' },
        ]}
        active="d1"
      />

      <div className="main" data-rail={panelLayout}>
        <EditorBody showMini={tw.showMini ?? true} showCursor={true} connection={connection} />
        {panelLayout !== 'hidden' && (
          <SideRail
            mode={railMode}
            onMode={setRailMode}
            annotations={ANNOS}
            chat={CHAT}
          />
        )}
      </div>

      <StatusBar claudeState="annotating" docName="q2-dashboard-review.md" dirty={true} />
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} platform={platform} />}
    </div>
  );
}

window.TandemApp = TandemApp;
window.EditorBody = EditorBody;
window.TopToolbar = TopToolbar;
window.DocTabs = DocTabs;
window.SideRail = SideRail;
window.StatusBar = StatusBar;
window.ANNOS = ANNOS;
window.CHAT = CHAT;
window.AnnotationCard = AnnotationCard;
window.SelectionMiniToolbar = SelectionMiniToolbar;
window.SlashMenu = SlashMenu;
