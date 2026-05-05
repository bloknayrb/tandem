/* Settings dialog — full redesign */

const { useState: useSettingsState } = React;

function SegSm({ value, options, onChange }) {
  return (
    <div className="seg-sm">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange?.(o.value)} disabled={o.disabled}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LayoutSwatch({ kind, active, onPick }) {
  // Mini diagram of the layout
  const diagrams = {
    'tabbed-right': (
      <svg viewBox="0 0 60 36" width="60" height="36">
        <rect x="1" y="1" width="58" height="34" rx="2" fill="var(--surface-sunk)" stroke="var(--hair)"/>
        <rect x="1" y="1" width="58" height="5" fill="var(--hair)"/>
        <rect x="40" y="6" width="19" height="29" fill="var(--surface)" stroke="var(--hair)"/>
        <rect x="42" y="9" width="6" height="2" fill={active ? 'var(--accent)' : 'var(--ink-faint)'}/>
        <rect x="50" y="9" width="6" height="2" fill="var(--ink-faint)"/>
        <rect x="6" y="11" width="28" height="1.5" fill="var(--ink-muted)"/>
        <rect x="6" y="15" width="22" height="1.5" fill="var(--ink-muted)"/>
        <rect x="6" y="19" width="26" height="1.5" fill="var(--ink-muted)"/>
      </svg>
    ),
    'tabbed-left': (
      <svg viewBox="0 0 60 36" width="60" height="36">
        <rect x="1" y="1" width="58" height="34" rx="2" fill="var(--surface-sunk)" stroke="var(--hair)"/>
        <rect x="1" y="1" width="58" height="5" fill="var(--hair)"/>
        <rect x="1" y="6" width="19" height="29" fill="var(--surface)" stroke="var(--hair)"/>
        <rect x="3" y="9" width="6" height="2" fill={active ? 'var(--accent)' : 'var(--ink-faint)'}/>
        <rect x="11" y="9" width="6" height="2" fill="var(--ink-faint)"/>
        <rect x="26" y="11" width="28" height="1.5" fill="var(--ink-muted)"/>
        <rect x="26" y="15" width="22" height="1.5" fill="var(--ink-muted)"/>
        <rect x="26" y="19" width="26" height="1.5" fill="var(--ink-muted)"/>
      </svg>
    ),
    'three': (
      <svg viewBox="0 0 60 36" width="60" height="36">
        <rect x="1" y="1" width="58" height="34" rx="2" fill="var(--surface-sunk)" stroke="var(--hair)"/>
        <rect x="1" y="1" width="58" height="5" fill="var(--hair)"/>
        <rect x="1" y="6" width="14" height="29" fill="var(--surface)" stroke="var(--hair)"/>
        <rect x="45" y="6" width="14" height="29" fill="var(--surface)" stroke="var(--hair)"/>
        <rect x="20" y="11" width="20" height="1.5" fill="var(--ink-muted)"/>
        <rect x="20" y="15" width="14" height="1.5" fill="var(--ink-muted)"/>
        <rect x="20" y="19" width="18" height="1.5" fill="var(--ink-muted)"/>
        <rect x="3" y="9" width="10" height="1.2" fill={active ? 'var(--author-claude)' : 'var(--ink-faint)'}/>
        <rect x="47" y="9" width="10" height="1.2" fill={active ? 'var(--accent)' : 'var(--ink-faint)'}/>
      </svg>
    ),
  };
  return (
    <div className={'layout-card' + (active ? ' active' : '')} onClick={onPick}>
      {diagrams[kind]}
    </div>
  );
}

function ThemeSwatch({ kind, active, onPick }) {
  return (
    <div className={'theme-card' + (active ? ' active' : '')} onClick={onPick} data-theme={kind === 'system' ? undefined : kind}>
      <div className="theme-prev" data-mode={kind}>
        <div className="bar"/>
        <div className="row r1"/>
        <div className="row r2"/>
        <div className="row r3"/>
      </div>
      <div className="label">{kind === 'system' ? 'System' : kind === 'light' ? 'Light' : 'Dark'}</div>
    </div>
  );
}

function SettingsDialog({ embedded = false, platform = (typeof window !== 'undefined' && window.detectPlatform ? window.detectPlatform() : 'win') }) {
  const fmt = (s) => window.formatShortcut(s, platform);
  const [theme, setTheme] = useSettingsState('light');
  const [layout, setLayout] = useSettingsState('tabbed-right');
  const [primaryTab, setPrimaryTab] = useSettingsState('annotations');
  const [textSize, setTextSize] = useSettingsState('m');
  const [reduceMotion, setReduceMotion] = useSettingsState(false);
  const [showAuthorship, setShowAuthorship] = useSettingsState(true);
  const [editorWidth, setEditorWidth] = useSettingsState(60);
  const [dwell, setDwell] = useSettingsState(1000);
  const [accentHue, setAccentHue] = useSettingsState(275);
  const [section, setSection] = useSettingsState('appearance');
  const [name, setName] = useSettingsState('Bryan');
  const [editorFont, setEditorFont] = useSettingsState('serif');

  const sections = [
    { id: 'appearance', label: 'Appearance', icon: 'sun' },
    { id: 'editor', label: 'Editor', icon: 'docMd' },
    { id: 'accessibility', label: 'Accessibility', icon: 'check' },
    { id: 'collab', label: 'Collaboration', icon: 'comment' },
    { id: 'cowork', label: 'Claude Code', icon: 'sparkle' },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'code' },
  ];

  return (
    <div className={'settings-dialog' + (embedded ? ' embedded' : '')} role="dialog" aria-label="Settings">
      <aside className="settings-nav">
        <div className="settings-nav-head">
          <span className="brand-mini">
            <span className="mark" aria-hidden="true" style={{ width: 14, height: 14, display: 'inline-block' }}>
              <img src="logo.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}/>
            </span>
            <span style={{ fontWeight: 700, letterSpacing: '-0.02em' }}>Tandem</span>
          </span>
          <span className="settings-version">v0.8.0</span>
        </div>
        {sections.map(s => (
          <div key={s.id} className={'settings-nav-item' + (section === s.id ? ' active' : '')} onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size={14}/>
            <span>{s.label}</span>
            {section === s.id && <Icon name="chevR" size={11}/>}
          </div>
        ))}
        <div className="settings-nav-foot">
          <div className={'settings-nav-sub' + (section === 'about' ? ' active' : '')} onClick={() => setSection('about')}>
            <Icon name="info" size={12}/>
            <span>About Tandem</span>
          </div>
          <a className="settings-nav-sub" href="#" onClick={e => e.preventDefault()}>
            <Icon name="ext" size={12}/>
            <span>Changelog</span>
          </a>
          <a className="settings-nav-sub" href="#" onClick={e => e.preventDefault()}>
            <Icon name="bug" size={12}/>
            <span>Report a bug</span>
          </a>
          <div className="settings-nav-status">
            <span className="sb-dot green"/> MCP connected
          </div>
        </div>
      </aside>

      <main className="settings-pane">
        <header className="settings-pane-head">
          <h2>{sections.find(s => s.id === section)?.label}</h2>
          <button className="tb-icon-btn" aria-label="Close"><Icon name="x" size={12}/></button>
        </header>

        {section === 'appearance' && (
          <div className="settings-body">
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Theme</div>
                <div className="d">Follows the system by default. Dark mode is hand-tuned, not inverted.</div>
              </div>
              <div className="settings-row-control">
                <div className="swatch-row">
                  <ThemeSwatch kind="light" active={theme === 'light'} onPick={() => setTheme('light')}/>
                  <ThemeSwatch kind="dark" active={theme === 'dark'} onPick={() => setTheme('dark')}/>
                  <ThemeSwatch kind="system" active={theme === 'system'} onPick={() => setTheme('system')}/>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Accent</div>
                <div className="d">Used for active states, focus rings, and the brand mark.</div>
              </div>
              <div className="settings-row-control">
                <div className="hue-row">
                  {[275, 245, 215, 165, 135, 65, 30, 5, 320].map(h => (
                    <button
                      key={h}
                      className={'hue-sw' + (accentHue === h ? ' on' : '')}
                      onClick={() => setAccentHue(h)}
                      style={{ background: `oklch(0.55 0.16 ${h})` }}
                      aria-label={`Hue ${h}`}
                    />
                  ))}
                  <span className="hue-val mono">{accentHue}°</span>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Panel layout</div>
                <div className="d">Where Annotations and Chat live. Three-panel keeps both visible at once.</div>
              </div>
              <div className="settings-row-control">
                <div className="swatch-row" style={{ gap: 8 }}>
                  <LayoutSwatch kind="tabbed-right" active={layout === 'tabbed-right'} onPick={() => setLayout('tabbed-right')}/>
                  <LayoutSwatch kind="tabbed-left" active={layout === 'tabbed-left'} onPick={() => setLayout('tabbed-left')}/>
                  <LayoutSwatch kind="three" active={layout === 'three'} onPick={() => setLayout('three')}/>
                </div>
              </div>
            </div>

            {layout.startsWith('tabbed') && (
              <div className="settings-row">
                <div className="settings-row-label">
                  <div className="t">Primary tab</div>
                  <div className="d">Which panel opens first when you launch Tandem.</div>
                </div>
                <div className="settings-row-control">
                  <SegSm value={primaryTab} options={[
                    { value: 'annotations', label: 'Annotations' },
                    { value: 'chat', label: 'Chat' },
                  ]} onChange={setPrimaryTab}/>
                </div>
              </div>
            )}
          </div>
        )}

        {section === 'editor' && (
          <div className="settings-body">
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Editor font</div>
                <div className="d">The typeface for document body text. Chrome stays sans-serif.</div>
              </div>
              <div className="settings-row-control">
                <SegSm value={editorFont} options={[
                  { value: 'serif', label: 'Serif' },
                  { value: 'sans', label: 'Sans' },
                  { value: 'mono', label: 'Mono' },
                ]} onChange={setEditorFont}/>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Text size</div>
              </div>
              <div className="settings-row-control">
                <SegSm value={textSize} options={[
                  { value: 's', label: 'Small · 14px' },
                  { value: 'm', label: 'Medium · 16px' },
                  { value: 'l', label: 'Large · 18px' },
                ]} onChange={setTextSize}/>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Editor width</div>
                <div className="d">How wide the document column gets. {editorWidth}% of available space.</div>
              </div>
              <div className="settings-row-control">
                <div className="slider-row">
                  <input type="range" min="40" max="100" value={editorWidth} onChange={e => setEditorWidth(+e.target.value)}/>
                  <span className="tnum" style={{ minWidth: 36, textAlign: 'right', fontSize: 12, color: 'var(--ink-muted)' }}>{editorWidth}%</span>
                </div>
                <div className="width-preview">
                  <div className="wp-shell">
                    <div className="wp-col" style={{ width: editorWidth + '%' }}>
                      <span/><span/><span style={{ width: '60%' }}/>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Selection toolbar</div>
                <div className="d">Floating mini-toolbar appears over selected text. Recommended.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" defaultChecked/><span/></label>
              </div>
            </div>
          </div>
        )}

        {section === 'accessibility' && (
          <div className="settings-body">
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Author indicators</div>
                <div className="d">Show character-level authorship coloring — every run inherits its writer's color, with the gutter summarizing the dominant author per paragraph.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" checked={showAuthorship} onChange={e => setShowAuthorship(e.target.checked)}/><span/></label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Reduce motion</div>
                <div className="d">Disables cursor blink, gutter pulse, and toast slide animations.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" checked={reduceMotion} onChange={e => setReduceMotion(e.target.checked)}/><span/></label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">High contrast</div>
                <div className="d">Honors system Forced Colors when active.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" /><span/></label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Annotation patterns</div>
                <div className="d">Use shapes alongside color so annotation types are distinguishable without color.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" defaultChecked/><span/></label>
              </div>
            </div>
          </div>
        )}

        {section === 'collab' && (
          <div className="settings-body">
            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Display name</div>
                <div className="d">Shown on cursors, comments, and annotation cards.</div>
              </div>
              <div className="settings-row-control">
                <input type="text" className="text-input" value={name} onChange={e => setName(e.target.value)}/>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Selection sensitivity</div>
                <div className="d">How long Claude waits after you stop selecting before reacting. {(dwell/1000).toFixed(2)}s. Default 1000ms (per <code>SELECTION_DWELL_DEFAULT_MS</code>) — lower values cause Claude to react to nearly every accidental selection.</div>
              </div>
              <div className="settings-row-control">
                <div className="slider-row">
                  <input type="range" min="100" max="2500" value={dwell} step="50" onChange={e => setDwell(+e.target.value)}/>
                  <span className="tnum" style={{ minWidth: 56, textAlign: 'right', fontSize: 12, color: 'var(--ink-muted)' }}>{dwell} ms</span>
                </div>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Default mode</div>
                <div className="d">Solo mutes Claude entirely; Tandem keeps the live connection.</div>
              </div>
              <div className="settings-row-control">
                <SegSm value="tandem" options={[
                  { value: 'solo', label: 'Solo' },
                  { value: 'tandem', label: 'Tandem' },
                ]} onChange={() => {}}/>
              </div>
            </div>
          </div>
        )}

        {section === 'cowork' && (
          <div className="settings-body">
            <div className="cowork-status">
              <div className="cowork-status-row">
                <span className="sb-dot green"/>
                <span style={{ fontWeight: 600 }}>Connected to Claude Code</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--ink-muted)', marginLeft: 'auto' }}>~/work</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--ink-muted)', marginTop: 6 }}>
                Tandem MCP tools registered · <span className="setting-dyn">31 tools available</span> · <span className="setting-dyn">token rotated 3 days ago</span>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Auto-install MCP config</div>
                <div className="d">Detect Claude Code on launch and offer to register Tandem tools.</div>
              </div>
              <div className="settings-row-control">
                <label className="toggle"><input type="checkbox" defaultChecked/><span/></label>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Bind mode</div>
                <div className="d">Which MCP transport Claude Code should use to reach this session.</div>
              </div>
              <div className="settings-row-control">
                <SegSm value="stdio" options={[
                  { value: 'stdio', label: 'stdio' },
                  { value: 'http', label: 'HTTP' },
                ]} onChange={() => {}}/>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-label">
                <div className="t">Rotate token</div>
                <div className="d">Generate a fresh MCP auth token. Existing sessions stay valid until they reconnect. <strong>Tauri desktop:</strong> requires the HTTP bridge (not yet available) — run <code>tandem rotate-token</code> from the CLI instead.</div>
              </div>
              <div className="settings-row-control">
                <button className="btn-ghost" style={{ border: '1px solid var(--hair)' }} disabled title="Unavailable in Tauri desktop — use CLI">Rotate now</button>
                <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>desktop · disabled</div>
              </div>
            </div>
          </div>
        )}

        {section === 'shortcuts' && (
          <div className="settings-body">
            <div className="kbd-grid">
              {[
                ['Toggle Review Mode', fmt('⌘⇧R')],
                ['Ask Claude about selection', fmt('⌘⇧A')],
                ['Comment on selection', fmt('⌘⇧M')],
                ['Flag selection', fmt('⌘⇧F')],
                ['Search in document', fmt('⌘F')],
                ['Open file', fmt('⌘O')],
                ['Save', fmt('⌘S')],
                ['Cycle tabs', fmt('⌃Tab')],
                ['Toggle Solo / Tandem', fmt('⌘⇧S')],
                ['Settings', fmt('⌘,')],
                ['Accept (in review)', 'Y'],
                ['Dismiss (in review)', 'N'],
                ['Next annotation', 'Tab'],
              ].map(([k, v]) => (
                <div key={k} className="kbd-row">
                  <span>{k}</span>
                  <span className="kbd-keys mono">{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {section === 'about' && (
          <div className="settings-body">
            <div className="about-hero">
              <div className="about-mark">
                <span style={{
                  width: 22, height: 22, borderRadius: 5,
                  background: 'linear-gradient(135deg, var(--author-user) 50%, var(--author-claude) 50%)',
                  display: 'inline-block',
                }}/>
              </div>
              <div>
                <div className="about-name">Tandem</div>
                <div className="about-tag">A document in conversation with the writer beside you.</div>
              </div>
            </div>

            <div className="about-grid">
              <div className="about-row">
                <span className="about-k">Version</span>
                <span className="about-v mono">0.8.0 <span className="faint">(build 2026.04.18-a3f1)</span></span>
              </div>
              <div className="about-row">
                <span className="about-k">Channel</span>
                <span className="about-v">Stable · no beta channel exists yet</span>
              </div>
              <div className="about-row">
                <span className="about-k">Engine</span>
                <span className="about-v mono setting-dyn">claude-sonnet-4.5 · MCP 0.7.2</span>
              </div>
              <div className="about-row">
                <span className="about-k">Storage</span>
                <span className="about-v mono setting-dyn">~/Library/Application Support/tandem/sessions/ · 12.4 MB</span>
              </div>
            </div>

            <div className="about-note mono faint">
              Values marked <span className="setting-dyn-pill">dynamic</span> are read live from the running server / OS — never hardcode in production.
            </div>

            <div className="about-actions">
              <button className="btn-ghost" style={{ border: '1px solid var(--hair)' }}>
                <Icon name="ext" size={11}/> Changelog
              </button>
              <button className="btn-ghost" style={{ border: '1px solid var(--hair)' }}>
                <Icon name="bug" size={11}/> Report a bug
              </button>
              <button className="btn-ghost" style={{ border: '1px solid var(--hair)' }}>
                <Icon name="docMd" size={11}/> Open log folder
              </button>
              <span className="btn-spacer"/>
              <button className="btn-ghost">Check for updates</button>
            </div>

            <div className="about-cred mono faint">
              Made by Bryan. Built with care in Source Serif 4 + Inter Tight.
            </div>
          </div>
        )}

        <footer className="settings-pane-foot">
          <span className="mono faint" style={{ fontSize: 10 }}>changes apply immediately · {fmt('⌘,')} to reopen</span>
          <span className="btn-spacer"/>
          <button className="btn-ghost">Reset section</button>
          <button className="btn-primary">Done</button>
        </footer>
      </main>
    </div>
  );
}

window.SettingsDialog = SettingsDialog;
