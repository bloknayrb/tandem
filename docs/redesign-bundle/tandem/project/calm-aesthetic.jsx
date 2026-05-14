/* calm-aesthetic.jsx — 5 directional mocks of a calmer, less bordered chrome.
   Each frame renders the editor + (some form of) rail/inspector to compare.
   Shared content so the directions are directly comparable. */

// ─────────────────────────────────────────────────────────────────────
// Shared body content (same words, same selection, same anchor across all)
// ─────────────────────────────────────────────────────────────────────
function CalmDoc({ marginNoteIds = [] }) {
  // marginNoteIds: array of element IDs the Margin direction needs anchors for
  return (
    <div className="ca-doc">
      <div className="ca-meta" style={{ marginBottom: 8 }}>progress-report.md · saved 2m ago · 1,840 words</div>
      <h1>Q2 build report</h1>
      <p className="ca-para" data-author="user">
        We shipped v0.11.0 on May 11 — three weeks behind the v2 design handoff and
        with three deliberate divergences from the spec.{' '}
        <span className="ca-anno" id={marginNoteIds[0]}>
          Engineering surfaced seven decisions that the handoff punted on
        </span>
        , and the team is asking for clearer rules of engagement before v0.12.0.
      </p>
      <h2>What landed</h2>
      <p className="ca-para" data-author="claude">
        The merged titlebar (PR #602) collapses brand, doc tabs, mode toggle and
        chrome into one 44px draggable strip{' '}
        <span className="ca-anno suggest" id={marginNoteIds[1]}>
          which feels tight on Windows once you add the system controls
        </span>
        . Solo→Tandem transition got a real heldInSolo banner. Scratchpads
        (Ctrl+N) now mark their ephemeral state in the tab.
      </p>
      <p className="ca-para" data-author="user">
        Character-level authorship shipped with a denser tint than the design
        called for — a side-by-side review with the original spec is in the
        rail.{' '}
        <span className="ca-anno flag" id={marginNoteIds[2]}>
          Two of the legacy highlight keys (red, purple) were remapped without
          a migration note
        </span>
        ; users with existing docs from v0.10 are seeing the wrong colors.
      </p>
      <h2>What's next</h2>
      <p className="ca-para" data-author="claude">
        v0.12.0 picks up Document Groups, diff hunk staging with focus-trapped
        keyboard handling, and the Chat empty state. The speculative artboards
        in section F lay these out — confidence is labeled on each.
      </p>
    </div>
  );
}

const SEG = ({ value, onChange, options }) => (
  <div className="ca-A-seg">
    {options.map(o => (
      <button key={o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange?.(o.value)}>{o.label}</button>
    ))}
  </div>
);

// ─────────────────────────────────────────────────────────────────────
// Direction A — One Paper
// ─────────────────────────────────────────────────────────────────────
function CalmA_OnePaper() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="ca-frame ca-A">
      {/* Titlebar */}
      <div className="ca-A-titlebar">
        <div className="ca-brand">
          <span className="ca-mark" />
          Tandem
        </div>
        <span className="ca-crumb">~/work/reports</span>
        <span className="ca-doc-name">progress-report.md</span>
        <span className="ca-crumb">●</span>
        <div className="grow" />
        <SEG value={mode} onChange={setMode} options={[
          { value: 'solo', label: 'Solo' }, { value: 'tandem', label: 'Tandem' }
        ]} />
        <button className="ca-A-icbtn" title="Toggle theme">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" /></svg>
        </button>
        <button className="ca-A-icbtn" title="Panel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></svg>
        </button>
      </div>
      {/* Tabs — flush with bar, separated by air not lines */}
      <div className="ca-A-tabs">
        <div className="ca-A-tab on"><span className="ext">md</span>progress-report</div>
        <div className="ca-A-tab"><span className="ext">md</span>v0.12 plan</div>
        <div className="ca-A-tab"><span className="ext">md</span>HANDOFF</div>
      </div>
      {/* Main */}
      <div className="ca-A-main">
        <div className="ca-A-editor">
          <CalmDoc />
        </div>
        <div className="ca-A-rail">
          <div className="ca-A-rail-head">
            <span className="on">Annotations <span className="count">4</span></span>
            <span>Chat <span className="count">2</span></span>
            <span>Outline</span>
          </div>
          <div className="ca-A-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· flag</span>
              <span className="t">2m</span>
            </div>
            <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
            <div className="body">We need a migration note in the changelog and an in-app toast for first-open after upgrade.</div>
          </div>
          <div className="ca-A-card suggest">
            <div className="head">
              <span className="dot c" /><span className="who c">Claude</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· suggest</span>
              <span className="t">8m</span>
            </div>
            <div className="snip">which feels tight on Windows once you add the…</div>
            <div className="body">Drop the mode toggle to a popover when window width &lt; 920px. I can prototype both variants.</div>
          </div>
          <div className="ca-A-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· comment</span>
              <span className="t">14m</span>
            </div>
            <div className="snip">Engineering surfaced seven decisions…</div>
            <div className="body">List them in the v3 handoff under section B; lock five by EOW.</div>
          </div>
        </div>
      </div>
      <div className="ca-A-status">
        <span>● connected</span>
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

// ─────────────────────────────────────────────────────────────────────
// Direction B — Sheet on desk
// ─────────────────────────────────────────────────────────────────────
function CalmB_Sheet() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="ca-frame ca-B">
      <div className="ca-B-bar">
        <div className="ca-B-side left">
          <button className="ca-A-icbtn" title="Sidebar">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></svg>
          </button>
          <button className="ca-A-icbtn" title="Search">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="7" cy="7" r="4.5" /><path d="M14 14l-3.5-3.5" /></svg>
          </button>
        </div>
        <div className="ca-B-pill">
          <span className="ca-brand"><span className="ca-mark" />Tandem</span>
          <span className="sep" />
          <span className="ca-crumb">work / reports /</span>
          <span className="ca-doc-name">progress-report.md</span>
          <SEG value={mode} onChange={setMode} options={[
            { value: 'solo', label: 'Solo' }, { value: 'tandem', label: 'Tandem' }
          ]} />
        </div>
        <div className="ca-B-side right">
          <button className="ca-A-icbtn" title="Theme">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" /></svg>
          </button>
          <button className="ca-A-icbtn" title="Share">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="4" cy="8" r="2" /><circle cx="12" cy="4" r="2" /><circle cx="12" cy="12" r="2" /><path d="M5.7 7L10.3 5M5.7 9L10.3 11" /></svg>
          </button>
        </div>
      </div>
      <div className="ca-B-stage">
        <div className="ca-B-sheet">
          <CalmDoc />
        </div>
        <div className="ca-B-insp">
          <div className="ca-B-insp-head" style={{ gap: 6 }}>
            <span className="ca-B-insp-tab on">Annotations <span style={{ color: 'var(--ca-ink-faint)' }}>4</span></span>
            <span className="ca-B-insp-tab">Chat 2</span>
            <span className="ca-B-insp-tab">Outline</span>
          </div>
          <div className="ca-B-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· flag</span>
              <span className="t">2m</span>
            </div>
            <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
            <div className="body" style={{ fontSize: 13 }}>Need a migration note in the changelog + first-open toast.</div>
          </div>
          <div className="ca-B-card suggest">
            <div className="head">
              <span className="dot c" /><span className="who c">Claude</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· suggest</span>
              <span className="t">8m</span>
            </div>
            <div className="snip">which feels tight on Windows once you add the…</div>
            <div className="body">Collapse mode toggle to popover &lt; 920px. I'll mock both.</div>
          </div>
          <div className="ca-B-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· comment</span>
              <span className="t">14m</span>
            </div>
            <div className="snip">Engineering surfaced seven decisions…</div>
            <div className="body">Lock five in v3 handoff by EOW.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Direction C — Margin notes (cards in editor margin, no rail)
// ─────────────────────────────────────────────────────────────────────
function CalmC_Margin() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="ca-frame ca-C">
      <div className="ca-C-bar">
        <div className="ca-brand"><span className="ca-mark" />Tandem</div>
        <div className="grow" />
        <span className="ca-crumb">work / reports /</span>
        <span className="ca-doc-name">progress-report.md</span>
        <span className="ca-crumb">●</span>
        <div style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <SEG value={mode} onChange={setMode} options={[
            { value: 'solo', label: 'Solo' }, { value: 'tandem', label: 'Tandem' }
          ]} />
          <button className="ca-A-icbtn" title="Theme">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" /></svg>
          </button>
        </div>
      </div>
      <div className="ca-C-stage">
        <div className="ca-C-canvas">
          <CalmDoc marginNoteIds={['mc-anno-0', 'mc-anno-1', 'mc-anno-2']} />
          <div className="ca-C-margin">
            <div className="ca-C-note">
              <div className="head">
                <span className="who u">You</span>
                <span className="kind">comment · 14m</span>
              </div>
              <div className="body">Lock five of these in the v3 handoff by EOW.</div>
              <div className="actions"><span className="primary">Reply</span><span>Resolve</span></div>
            </div>
            <div className="ca-C-note suggest" style={{ marginTop: 64 }}>
              <div className="head">
                <span className="who c">Claude</span>
                <span className="kind">suggest · 8m</span>
              </div>
              <div className="body">Collapse mode toggle to popover under 920px. I'll mock both.</div>
              <div className="actions"><span className="primary">Apply</span><span>Discuss</span><span>Dismiss</span></div>
            </div>
            <div className="ca-C-note flag" style={{ marginTop: 36 }}>
              <div className="head">
                <span className="who u">You</span>
                <span className="kind">flag · 2m</span>
              </div>
              <div className="body">Migration note in the changelog and an in-app toast for first-open after upgrade.</div>
              <div className="actions"><span className="primary">Reply</span><span>Resolve</span></div>
            </div>
          </div>
        </div>
        <div className="ca-C-status">
          <span>● connected</span>
          <span>tandem · Claude reading</span>
          <div className="right">
            <span>md · UTF-8</span>
            <span>1,840 words</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Direction D — Frosted overlays
// ─────────────────────────────────────────────────────────────────────
function CalmD_Frosted() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="ca-frame ca-D">
      <div className="ca-D-stage">
        <CalmDoc />
      </div>
      <div className="ca-D-titlebar">
        <div className="ca-brand"><span className="ca-mark" />Tandem</div>
        <div className="grow">
          progress-report.md <span className="ca-crumb">work / reports</span>
        </div>
        <SEG value={mode} onChange={setMode} options={[
          { value: 'solo', label: 'Solo' }, { value: 'tandem', label: 'Tandem' }
        ]} />
        <button className="ca-A-icbtn" title="Theme">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" /></svg>
        </button>
      </div>
      <div className="ca-D-insp ca-D-frost">
        <div className="ca-D-insp-head">
          <span className="on">Annotations · 4</span>
          <span>Chat · 2</span>
          <span>Outline</span>
        </div>
        <div className="ca-D-list">
          <div className="ca-D-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· flag</span>
              <span className="t">2m</span>
            </div>
            <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
            <div className="body">Migration note + first-open toast for upgraded docs.</div>
          </div>
          <div className="ca-D-card">
            <div className="head">
              <span className="dot c" /><span className="who c">Claude</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· suggest</span>
              <span className="t">8m</span>
            </div>
            <div className="snip">which feels tight on Windows once you add the…</div>
            <div className="body">Collapse mode toggle to popover under 920px.</div>
          </div>
          <div className="ca-D-card">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span style={{ color: 'var(--ca-ink-faint)' }}>· comment</span>
              <span className="t">14m</span>
            </div>
            <div className="snip">Engineering surfaced seven decisions…</div>
            <div className="body">Lock five in v3 handoff by EOW.</div>
          </div>
        </div>
      </div>
      <div className="ca-D-status frost">
        <span>● connected</span>
        <span>tandem · Claude reading</span>
        <div className="right">
          <span>md · UTF-8</span>
          <span>ln 14, col 38</span>
          <span>1,840 w</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Direction E — Tinted shells (docked rail, no borders, kind-tinted cards)
// ─────────────────────────────────────────────────────────────────────
function CalmE_Tinted() {
  const [mode, setMode] = React.useState('tandem');
  return (
    <div className="ca-frame ca-E">
      <div className="ca-A-titlebar">
        <div className="ca-brand">
          <span className="ca-mark" />
          Tandem
        </div>
        <span className="ca-crumb">~/work/reports</span>
        <span className="ca-doc-name">progress-report.md</span>
        <span className="ca-crumb">●</span>
        <div className="grow" />
        <SEG value={mode} onChange={setMode} options={[
          { value: 'solo', label: 'Solo' }, { value: 'tandem', label: 'Tandem' }
        ]} />
        <button className="ca-A-icbtn" title="Theme">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M14 8.5A6 6 0 1 1 7.5 2a4.5 4.5 0 0 0 6.5 6.5z" /></svg>
        </button>
      </div>
      <div className="ca-A-tabs">
        <div className="ca-A-tab on"><span className="ext">md</span>progress-report</div>
        <div className="ca-A-tab"><span className="ext">md</span>v0.12 plan</div>
        <div className="ca-A-tab"><span className="ext">md</span>HANDOFF</div>
      </div>
      <div className="ca-E-main">
        <div className="ca-E-editor">
          <CalmDoc />
        </div>
        <div className="ca-E-rail">
          <div className="ca-E-rail-head">
            <span className="on">Annotations · 4</span>
            <span>Chat · 2</span>
            <span>Outline</span>
          </div>
          <div className="ca-E-card flag">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span className="ca-E-pill">flag</span>
              <span className="t">2m</span>
            </div>
            <div className="snip">Two of the legacy highlight keys (red, purple)…</div>
            <div className="body">Need a migration note in the changelog and an in-app toast for first-open after upgrade.</div>
          </div>
          <div className="ca-E-card suggest">
            <div className="head">
              <span className="dot c" /><span className="who c">Claude</span>
              <span className="ca-E-pill">suggest</span>
              <span className="t">8m</span>
            </div>
            <div className="snip">which feels tight on Windows once you add the…</div>
            <div className="body">Collapse the mode toggle to a popover under 920px. I'll prototype both variants.</div>
          </div>
          <div className="ca-E-card comment">
            <div className="head">
              <span className="dot u" /><span className="who u">You</span>
              <span className="ca-E-pill">comment</span>
              <span className="t">14m</span>
            </div>
            <div className="snip">Engineering surfaced seven decisions…</div>
            <div className="body">List in v3 handoff section B; lock five by EOW.</div>
          </div>
          <div className="ca-E-card highlight">
            <div className="head">
              <span className="dot c" /><span className="who c">Claude</span>
              <span className="ca-E-pill">highlight</span>
              <span className="t">22m</span>
            </div>
            <div className="snip">three deliberate divergences from the spec</div>
            <div className="body">Reviewed against the v2 handoff; all three are intentional.</div>
          </div>
        </div>
      </div>
      <div className="ca-A-status">
        <span>● connected</span>
        <span>tandem · Claude idle</span>
        <div className="right">
          <span>md · UTF-8</span>
          <span>ln 14, col 38</span>
          <span>1,840 words</span>
        </div>
      </div>
    </div>
  );
}

// expose to global so the host file can pick them up
Object.assign(window, {
  CalmA_OnePaper,
  CalmB_Sheet,
  CalmC_Margin,
  CalmD_Frosted,
  CalmE_Tinted,
});
