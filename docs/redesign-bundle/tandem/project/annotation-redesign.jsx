/* Annotation Redesign — audience-not-type model
   Companion JSX file. Loaded after app.jsx; uses some shared icons.
   All exported components prefixed `AR` to avoid collisions. */

const { useState: arUseState } = React;

/* ------------------------------------------------------------------ */
/* Selection popup — the key design moment                              */
/* ------------------------------------------------------------------ */
function ARSelectionPopup({ x = 64, y = 60, value = "", placeholder = "“Note to self” — or message Claude…", color = null, hint = null, focused = false, hideArrow = false }) {
  return (
    <div className="ar-pop" style={{ left: x, top: y }}>
      <textarea
        className="ar-pop-textarea"
        placeholder={placeholder}
        defaultValue={value}
        autoFocus={focused}
      />
      <div className="ar-pop-actions">
        <div className="ar-pop-swatches" title="Highlight">
          <span className={"ar-sw yellow" + (color === "yellow" ? " on" : "")}/>
          <span className={"ar-sw green" + (color === "green" ? " on" : "")}/>
          <span className={"ar-sw blue" + (color === "blue" ? " on" : "")}/>
          <span className={"ar-sw pink" + (color === "pink" ? " on" : "")}/>
        </div>
        <div className="ar-pop-spacer"/>
        <button className="ar-btn ar-btn-note">
          Note to self <span className="ar-kbd">⏎</span>
        </button>
        <button className="ar-btn ar-btn-comment">
          Send to Claude <span className="ar-kbd">⌘⏎</span>
        </button>
      </div>
      {hideArrow ? null : <div className="ar-pop-arrow"/>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cards — five variants                                                */
/* ------------------------------------------------------------------ */
function ARHighlightCard({ snippet, color = "yellow", time }) {
  return (
    <div className="ar-card kind-hl">
      <div className={"ar-hl-chip " + color}/>
      <div className="ar-snip">"{snippet}"</div>
      <span className="ar-time">{time}</span>
    </div>
  );
}

function ARNoteCard({ body, snippet, time, selected = false, selectable = false, active = false }) {
  return (
    <div className={"ar-card kind-note" + (active ? " active" : "") + (selectable ? " selectable" : "")}>
      <div className="ar-card-head">
        {selectable ? (
          <span className={"ar-check" + (selected ? " on" : "")}>
            {selected ? <Icon name="check" size={9} stroke={2.6}/> : null}
          </span>
        ) : null}
        <span className="ar-author user">
          <span className="ar-author-dot"/> Note to self
        </span>
        <span className="ar-time">{time}</span>
      </div>
      {snippet ? <div className="ar-card-snip">"{snippet}"</div> : null}
      <div className="ar-card-body">{body}</div>
      <div className="ar-actions">
        <button className="ar-act">Edit</button>
        <button className="ar-act">Remove</button>
        <span className="ar-act-spacer"/>
        <button className="ar-act ar-act-convert">
          <span className="ar-icn"><Icon name="reply" size={11}/></span> Send to Claude
        </button>
      </div>
    </div>
  );
}

function ARUserCommentCard({ body, snippet, time, active = false, awaiting = false }) {
  return (
    <div className={"ar-card kind-uc" + (active ? " active" : "")}>
      <div className="ar-card-head">
        <span className="ar-author user outbound">
          <span className="ar-author-dot"/> You → Claude
        </span>
        <span className="ar-kind-chip uc">comment</span>
        <span className="ar-time">{awaiting ? "sent · awaiting" : time}</span>
      </div>
      {snippet ? <div className="ar-card-snip">"{snippet}"</div> : null}
      <div className="ar-card-body">{body}</div>
      <div className="ar-actions">
        <button className="ar-act">Edit</button>
        <span className="ar-act-spacer"/>
        <button className="ar-act">Remove</button>
      </div>
    </div>
  );
}

function ARClaudeCommentCard({ body, snippet, time, active = false }) {
  return (
    <div className={"ar-card kind-cc" + (active ? " active" : "")}>
      <div className="ar-card-head">
        <span className="ar-author claude">
          <span className="ar-author-dot"/> Claude
        </span>
        <span className="ar-kind-chip cc">comment</span>
        <span className="ar-time">{time}</span>
      </div>
      {snippet ? <div className="ar-card-snip">"{snippet}"</div> : null}
      <div className="ar-card-body">{body}</div>
      <div className="ar-actions">
        <button className="ar-act ar-act-primary">Reply</button>
        <button className="ar-act">Dismiss</button>
        <span className="ar-act-spacer"/>
        <span className="ar-kbd-pill"><span className="ar-k">Y</span><span>accept</span><span className="ar-k">N</span><span>dismiss</span></span>
      </div>
    </div>
  );
}

function ARSuggestionCard({ del, add, body, time, active = true }) {
  return (
    <div className={"ar-card kind-sg" + (active ? " active" : "")}>
      <div className="ar-card-head">
        <span className="ar-author claude">
          <span className="ar-author-dot"/> Claude
        </span>
        <span className="ar-kind-chip sg">suggestion</span>
        <span className="ar-time">{time}</span>
      </div>
      <div className="ar-diff">
        <div className="ar-diff-row del">{del}</div>
        <div className="ar-diff-row add">{add}</div>
      </div>
      {body ? <div className="ar-card-body">{body}</div> : null}
      <div className="ar-actions">
        <button className="ar-act ar-act-accept">
          <span className="ar-icn"><Icon name="check" size={11} stroke={2.6}/></span> Accept
        </button>
        <button className="ar-act">Dismiss</button>
        <button className="ar-act">Reply</button>
        <span className="ar-act-spacer"/>
        <span className="ar-kbd-pill"><span className="ar-k">Y</span><span>/</span><span className="ar-k">N</span></span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Filter row — 5 filters                                                */
/* ------------------------------------------------------------------ */
function ARFilters({ active = "all", counts = {}, showResolved = false }) {
  const items = [
    { id: "all",    label: "All",         n: counts.all ?? 12 },
    { id: "hl",     label: "Highlights",  n: counts.hl ?? 4 },
    { id: "notes",  label: "Notes",       n: counts.notes ?? 3 },
    { id: "comm",   label: "Comments",    n: counts.comm ?? 4 },
    { id: "sugg",   label: "Suggestions", n: counts.sugg ?? 1 },
  ];
  if (showResolved) items.push({ id: "resolved", label: "Resolved", n: counts.resolved ?? 0 });
  return (
    <div className="ar-filters">
      {items.map(it => (
        <span key={it.id} className={"ar-filter" + (active === it.id ? " on" : "")}>
          {it.label} <span className="ar-n">{it.n}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor close-up — shows decorations at body-text scale                */
/* ------------------------------------------------------------------ */
function ARDecorationsCloseup() {
  return (
    <div className="ar-canvas">
      <div className="ar-eyebrow">03 — Editor decorations</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 36, alignItems: "start" }}>
        <div className="ar-doc-frame">
          <p>The original spec assumed the existing reporting API could power most widgets. <span className="ar-note">flag this for Sami — RFC link goes here</span> During the build, the data team flagged that aggregation queries would not scale past ~1,000 concurrent users without a redesigned read layer.</p>
          <p>We paused dashboard work for six weeks while the API was rebuilt against a denormalized warehouse. <span className="ar-comment-user">make this less defensive — it reads like an apology</span> The rebuilt read layer is now reusable across <span className="ar-suggest">/billing, /usage, and the upcoming admin console</span> — work the original timeline would have spent on duplicated query code.</p>
          <p>Despite the slip, <span className="ar-hl-yellow">the rebuilt read layer is now reusable</span> across the surfaces that previously each owned their own query path. <span className="ar-comment-claude">Worth a callout — this is the strongest framing of the slip as a net positive.</span></p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <ARLegendRow swatch={<span className="ar-swatch-line" style={{ borderBottom: "1.5px dotted var(--ink-faint)" }}/>}
            label="Note to self"
            sub="Quietest. Personal — Claude doesn't act on it unless promoted."/>
          <ARLegendRow swatch={<span className="ar-swatch-line" style={{ borderBottom: "1.5px dashed var(--author-user)" }}/>}
            label="Your comment"
            sub="Outbound. Claude is notified."
            color="var(--author-user)"/>
          <ARLegendRow swatch={<span className="ar-swatch-line" style={{ borderBottom: "1.5px dashed var(--author-claude)" }}/>}
            label="Claude's comment"
            sub="Inbound. Reply, accept, or dismiss."
            color="var(--author-claude)"/>
          <ARLegendRow swatch={<span className="ar-swatch-line" style={{ borderBottom: "2px wavy var(--suggestion)", textDecoration: "underline wavy var(--suggestion)" }}/>}
            label="Suggestion"
            sub="Loudest. Tracked change — accept replaces the text."
            color="var(--suggestion)"/>
          <ARLegendRow swatch={<span className="ar-swatch-block" style={{ background: "var(--hl-yellow)" }}/>}
            label="Highlight"
            sub="Color carries severity. No text content."/>
        </div>
      </div>
    </div>
  );
}

function ARLegendRow({ swatch, label, sub, color }) {
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      <div style={{ width: 56, height: 18, position: "relative", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {React.cloneElement(swatch, { style: { ...(swatch.props.style || {}), display: "inline-block", width: 48, height: 14, borderRadius: 2 } })}
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 13, color: color || "var(--ink)", marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.45 }}>{sub}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Selection-popup close-up artboard                                      */
/* ------------------------------------------------------------------ */
function ARPopupCloseup() {
  return (
    <div className="ar-canvas" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 36 }}>
      <div>
        <div className="ar-eyebrow">01 — Selection popup</div>
        <div className="ar-callout" style={{ marginBottom: 20 }}>
          The audience choice <strong>is</strong> the design. Two buttons, equal weight visually, opposite intent. The textarea reads <em>either</em> way — we don't ask the user to commit before they type.
        </div>
        <div style={{
          background: "white",
          border: "1px solid var(--hair)",
          borderRadius: 10,
          padding: "32px 40px",
          fontFamily: "var(--font-serif)",
          fontSize: 16, lineHeight: 1.65,
          color: "var(--ink)",
          position: "relative",
          paddingTop: 220,
        }}>
          <p style={{ margin: 0 }}>The team completed the first two milestones ahead of schedule, but the dashboard timeline <span style={{ background: "oklch(0.85 0.10 245 / 0.35)", borderRadius: 2 }}>slipped due to an unexpected API redesign</span> in May.</p>
          <ARSelectionPopup x={140} y={28} value="make this less defensive — it reads like an apology" />
        </div>
      </div>
      <div>
        <div className="ar-eyebrow">01a — Empty state</div>
        <div className="ar-callout" style={{ marginBottom: 20 }}>
          The popup opens empty. Highlight colors below let the user mark text without typing — a one-click path that bypasses the audience question entirely.
        </div>
        <div style={{
          background: "white",
          border: "1px solid var(--hair)",
          borderRadius: 10,
          padding: "32px 40px",
          fontFamily: "var(--font-serif)",
          fontSize: 16, lineHeight: 1.65,
          color: "var(--ink)",
          position: "relative",
          paddingTop: 220,
        }}>
          <p style={{ margin: 0 }}>Onboarding completion climbed from <span style={{ background: "oklch(0.85 0.10 245 / 0.35)", borderRadius: 2 }}>34% to 71%</span> after we cut the welcome flow from nine screens to four.</p>
          <ARSelectionPopup x={140} y={28} value="" />
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.5 }}>
          Tap a color swatch → highlight applied, popup dismisses, no text required.
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar artboard — full rail, redesigned                              */
/* ------------------------------------------------------------------ */
function ARSidebarFrame({ tw }) {
  return (
    <div className="ar-canvas" style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 36, alignItems: "start" }}>
      <div>
        <div className="ar-eyebrow">02 — Sidebar in steady state</div>
        <div className="ar-callout">
          Card edge color signals audience and authorship at a glance. <strong>Slate</strong> = note (yours, private). <strong>Cobalt</strong> = your comment (sent to Claude). <strong>Coral</strong> = Claude's comment. <strong>Violet</strong> = Claude's suggestion. Resolved cards collapse into a footer section so the active rail stays scannable.
        </div>
        <div style={{ marginTop: 24, fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.55, maxWidth: 560 }}>
          The <em>Send to Claude</em> action on a note is the shipping mechanism — see the diagram below for the before/after of that conversion.
        </div>
        <div style={{ marginTop: 28 }}>
          <ARChainExample/>
        </div>
      </div>
      <div style={{ background: "var(--surface-muted)", border: "1px solid var(--hair)", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <ARFilters active="all" counts={{ all: 5, hl: 1, notes: 1, comm: 2, sugg: 1, resolved: 3 }} showResolved={true}/>
        <ARSuggestionCard
          del="simplify onboarding"
          add="streamline first-run setup"
          body="More concrete — matches the metric you cite (34→71%)."
          time="2m" active={true}/>
        <ARClaudeCommentCard
          snippet="in line with projections"
          body="Do you have the actual % drop, or should I quote the Q1 OKR target here?"
          time="4m"/>
        <ARUserCommentCard
          snippet="During the build, the data team flagged…"
          body="@claude rephrase as net positive — the read-layer rebuild unblocks /billing, /usage, admin console."
          time="6m"/>
        <ARNoteCard
          snippet="slipped"
          body='exec audience reads as missed deadline — try “extended scope”?'
          time="8m"/>
        <ARHighlightCard snippet="reusable across /billing, /usage" color="yellow" time="11m"/>
        <ARResolvedSection count={3}/>
      </div>
    </div>
  );
}

function ARResolvedSection({ count = 3 }) {
  return (
    <>
      <div className="ar-resolved-head collapsed">
        <span className="ar-chev">▾</span>
        Resolved
        <span className="ar-resolved-count">{count}</span>
      </div>
    </>
  );
}

function ARChainExample() {
  return (
    <div style={{ background: "var(--surface)", border: "1px dashed var(--hair-strong)", borderRadius: 8, padding: "18px 20px 22px", maxWidth: 560 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span className="ar-eyebrow" style={{ margin: 0 }}>Diagram — how a note becomes a comment</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 16, alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 6 }}>Before — private to you</div>
          <ARNoteCard
            snippet="slipped"
            body='exec audience reads as missed deadline — try “extended scope”?'
            time="just now"/>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, color: "var(--author-user)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M5 12h14m-5-5l5 5-5 5"/></svg>
          <span style={{ fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase" }}>Send</span>
        </div>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--author-user)", marginBottom: 6 }}>After — sent to Claude</div>
          <ARUserCommentCard
            snippet="slipped"
            body='Rephrase to read as a scope change rather than a missed deadline. Keep the May timing.'
            time="just now"
            awaiting={true}/>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Word import — batch convert flow                                       */
/* ------------------------------------------------------------------ */
function ARImportFrame() {
  return (
    <div className="ar-canvas">
      <div className="ar-eyebrow">04 — Word import → batch convert</div>
      <div className="ar-callout" style={{ marginBottom: 24 }}>
        When a <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, background: "var(--surface-sunk)", padding: "1px 5px", borderRadius: 3 }}>.docx</code> arrives with comments, every comment lands as a <strong>note</strong> — not a message to Claude. The user triages first, then promotes selected ones in a single action. Prevents an import from flooding Claude's queue.
        </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 36, alignItems: "start" }}>
        <div className="ar-doc-frame" style={{ minHeight: 360 }}>
          <p>The team completed the first two milestones ahead of schedule, but the dashboard timeline <span className="ar-note">missed deadline?</span> slipped due to an unexpected API redesign in May.</p>
          <p>Onboarding completion climbed from <span className="ar-note">verify w/ analytics</span> 34% to 71% after we cut the welcome flow from nine screens to four.</p>
          <p>Support volume fell <span className="ar-note">qualify the categories</span> in line with projections, with the largest decreases in <span className="ar-note">cite source</span> account-setup and password-reset categories.</p>
        </div>
        <div style={{ background: "var(--surface-muted)", border: "1px solid var(--hair)", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="ar-bulk">
            <Icon name="docW" size={14}/>
            <span><strong>2</strong> of 4 imported notes selected</span>
            <span className="ar-bulk-spacer"/>
            <button className="ar-bulk-clear">Clear</button>
            <button className="ar-bulk-act">Send to Claude</button>
          </div>
          <ARFilters active="notes" counts={{ all: 4, hl: 0, notes: 4, comm: 0, sugg: 0 }}/>
          <ARNoteCard snippet="missed deadline?" body="From: J. Patel, board-update-may.docx" time="—" selectable={true} selected={true}/>
          <ARNoteCard snippet="verify w/ analytics" body="From: J. Patel" time="—" selectable={true}/>
          <ARNoteCard snippet="qualify the categories" body="From: J. Patel" time="—" selectable={true} selected={true}/>
          <ARNoteCard snippet="cite source" body="From: J. Patel" time="—" selectable={true}/>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tutorial artboard — sample/welcome.md states                          */
/* ------------------------------------------------------------------ */
function ARTutorialFrame() {
  return (
    <div className="ar-canvas">
      <div className="ar-eyebrow">05 — Tutorial annotations on welcome.md</div>
      <div className="ar-callout" style={{ marginBottom: 24 }}>
        First-run document seeds three annotations — one of each meaningful kind — so the user sees the full vocabulary before authoring their own.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 36, alignItems: "start" }}>
        <div className="ar-doc-frame">
          <h2 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 600, margin: "0 0 18px", letterSpacing: "-0.01em" }}>Welcome to Tandem</h2>
          <p>Tandem is a Markdown editor where Claude reads alongside you. <span className="ar-note">try editing this line — see how the gutter colors change</span> Every paragraph carries a thread on the left showing who last touched it.</p>
          <p>Select any text and the popup gives you two ways to annotate. <span className="ar-comment-user">@claude what should I write here?</span> Notes stay between you and the document. Comments reach Claude.</p>
          <p>Claude can also propose tracked changes. <span className="ar-suggest">Open this dropdown to see how an accept replaces text in place.</span></p>
        </div>
        <div style={{ background: "var(--surface-muted)", border: "1px solid var(--hair)", borderRadius: 8, padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
          <ARFilters active="all" counts={{ all: 3, hl: 0, notes: 1, comm: 1, sugg: 1 }}/>
          <div className="ar-card kind-note">
            <div className="ar-card-head">
              <span className="ar-author user"><span className="ar-author-dot"/> Note to self</span>
              <span className="ar-tutorial-tag">tutorial</span>
              <span className="ar-time">step 1</span>
            </div>
            <div className="ar-card-snip">"try editing this line…"</div>
            <div className="ar-card-body">A note is yours alone. Try the <strong>Send to Claude</strong> button — it ships this thought to him.</div>
            <div className="ar-actions">
              <button className="ar-act">Skip</button>
              <span className="ar-act-spacer"/>
              <button className="ar-act ar-act-convert">
                <span className="ar-icn"><Icon name="reply" size={11}/></span> Send to Claude
              </button>
            </div>
          </div>
          <div className="ar-card kind-uc">
            <div className="ar-card-head">
              <span className="ar-author user outbound"><span className="ar-author-dot"/> You → Claude</span>
              <span className="ar-tutorial-tag">tutorial</span>
              <span className="ar-time">step 2</span>
            </div>
            <div className="ar-card-snip">"@claude what should I write here?"</div>
            <div className="ar-card-body">When you write a comment, Claude is notified. Claude's reply will land as a card here.</div>
            <div className="ar-actions">
              <button className="ar-act ar-act-primary">Send to Claude</button>
            </div>
          </div>
          <ARSuggestionCard
            del="Open this dropdown to see how an accept replaces text in place."
            add="Press Y on this card — the document text changes to match."
            body="Suggestions are the most consequential card. Y accepts, N dismisses, Z undoes."
            time="step 3"/>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card states close-up                                                   */
/* ------------------------------------------------------------------ */
function ARCardStatesFrame() {
  return (
    <div className="ar-canvas">
      <div className="ar-eyebrow">06 — Card states</div>
      <div className="ar-callout" style={{ marginBottom: 24 }}>
        Five canonical cards plus selection + resolved states. The convert button is the only colored CTA on a note — making the share gesture deliberate without being heavy.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 18, maxWidth: 880 }}>
        <ARStateBlock label="Highlight — yellow"><ARHighlightCard snippet="reusable across /billing, /usage" color="yellow" time="2m"/></ARStateBlock>
        <ARStateBlock label="Highlight — pink"><ARHighlightCard snippet="missed Q3 ship date" color="pink" time="11m"/></ARStateBlock>
        <ARStateBlock label="Note — default"><ARNoteCard snippet="slipped" body='exec audience reads this as missed — try “extended scope”' time="4m"/></ARStateBlock>
        <ARStateBlock label="Note — in batch select"><ARNoteCard snippet="verify w/ analytics" body="From: J. Patel" time="—" selectable={true} selected={true}/></ARStateBlock>
        <ARStateBlock label="User comment — active"><ARUserCommentCard snippet="During the build, the data team…" body="rephrase as net positive — read-layer rebuild unblocks /billing, /usage" time="6m" active={true}/></ARStateBlock>
        <ARStateBlock label="Claude comment"><ARClaudeCommentCard snippet="in line with projections" body="Do you have the actual % drop, or should I quote the Q1 OKR target here?" time="4m"/></ARStateBlock>
        <ARStateBlock label="Claude suggestion — active"><ARSuggestionCard del="simplify onboarding" add="streamline first-run setup" body="More concrete — matches the 34→71% metric." time="2m" active={true}/></ARStateBlock>
        <ARStateBlock label="Suggestion — accepted"><div className="ar-card kind-sg resolved" style={{ borderLeftColor: "var(--success)" }}>
          <div className="ar-card-head">
            <span className="ar-author claude"><span className="ar-author-dot"/> Claude</span>
            <span className="ar-kind-chip" style={{ background: "var(--success-soft)", color: "var(--success)", border: "1px solid oklch(0.85 0.06 150)" }}>accepted</span>
            <span className="ar-time">11m</span>
          </div>
          <div className="ar-diff">
            <div className="ar-diff-row del">simplify onboarding</div>
            <div className="ar-diff-row add">streamline first-run setup</div>
          </div>
          <div className="ar-actions">
            <button className="ar-act">Undo</button>
            <span className="ar-act-spacer"/>
          </div>
        </div></ARStateBlock>
      </div>
    </div>
  );
}

function ARStateBlock({ label, children }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

window.ARSelectionPopup = ARSelectionPopup;
window.ARHighlightCard = ARHighlightCard;
window.ARNoteCard = ARNoteCard;
window.ARUserCommentCard = ARUserCommentCard;
window.ARClaudeCommentCard = ARClaudeCommentCard;
window.ARSuggestionCard = ARSuggestionCard;
window.ARFilters = ARFilters;
window.ARDecorationsCloseup = ARDecorationsCloseup;
window.ARPopupCloseup = ARPopupCloseup;
window.ARSidebarFrame = ARSidebarFrame;
window.ARImportFrame = ARImportFrame;
window.ARTutorialFrame = ARTutorialFrame;
window.ARCardStatesFrame = ARCardStatesFrame;
