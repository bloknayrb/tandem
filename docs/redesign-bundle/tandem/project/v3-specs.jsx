/* v3-specs.jsx — B3, B5, D1–D5, E1: decisions, detail specs, hazard responses */

const { useState: specUse } = React;

// ── B3: solo-held-banner — 3 transition states ───────────────────────────────
function B3SoloHeldSpec({ tw = {} }) {
  const theme = tw.theme || 'light';
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const claudeC = '#D97757';

  function HeldBanner({ count = 3, variant = 'active', priorSession = false }) {
    const isPrior = priorSession;
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', margin: '10px 14px 0',
        background: variant === 'review' ? 'oklch(0.96 0.03 150)' : `color-mix(in oklch, ${claudeC} 10%, transparent)`,
        border: `1px solid ${variant === 'review' ? 'oklch(0.82 0.08 150)' : `color-mix(in oklch, ${claudeC} 25%, transparent)`}`,
        borderRadius: 8, fontSize: 12, color: ink,
      }}>
        {variant !== 'review' && (
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: claudeC, flexShrink: 0, animation: variant === 'active' ? 'held-pulse 2s ease-in-out infinite' : 'none' }} />
        )}
        {variant === 'review' && (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="oklch(0.48 0.14 150)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2l-8 8-3-3"/>
          </svg>
        )}
        <div style={{ flex: 1 }}>
          {variant === 'active' && (
            <><strong>{count} Claude {count === 1 ? 'annotation' : 'annotations'} held</strong>{isPrior ? ' from a prior Solo session' : ' while in Solo mode'}</>
          )}
          {variant === 'review' && (
            <><strong>Review held annotations</strong> — {count} queued from Solo mode ready to surface</>
          )}
          {variant === 'dismiss' && (
            <><strong>{count} held annotations</strong> will surface when you return to Tandem</>
          )}
        </div>
        {variant === 'active' && (
          <button style={{
            background: claudeC, color: 'white', border: 'none',
            borderRadius: 5, padding: '4px 10px',
            fontFamily: 'Inter Tight, sans-serif', fontWeight: 500, fontSize: 11,
            cursor: 'pointer',
          }}>Show all</button>
        )}
        {variant === 'review' && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{ height: 24, padding: '0 8px', border: `1px solid oklch(0.82 0.08 150)`, background: 'transparent', borderRadius: 4, fontSize: 11, color: muted, cursor: 'pointer', fontFamily: 'Inter Tight, sans-serif' }}>Dismiss all</button>
            <button style={{ height: 24, padding: '0 10px', background: 'oklch(0.55 0.14 150)', border: 'none', borderRadius: 4, fontSize: 11, color: 'white', cursor: 'pointer', fontFamily: 'Inter Tight, sans-serif' }}>Surface now</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: claudeC, marginBottom: 4 }}>B3 — heldInSolo · solo-held-banner</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Solo mode — held annotation states</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        {/* State 1 */}
        <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px 6px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>
            State 1 — Solo active, new held
          </div>
          <HeldBanner count={3} variant="active" />
          <div style={{ padding: '10px 14px', fontSize: 12, color: muted, lineHeight: 1.5 }}>
            User is in Solo. Claude generated annotations <em>during</em> this session. Banner is persistent; "Show all" flips to Tandem and surfaces held items.
          </div>
        </div>

        {/* State 2 */}
        <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px 6px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>
            State 2 — prior session held (<strong style={{ color: ink }}>B3 open Q</strong>)
          </div>
          <HeldBanner count={5} variant="active" priorSession={true} />
          <div style={{ padding: '10px 14px', fontSize: 12, color: muted, lineHeight: 1.5 }}>
            User opens a doc in Solo with <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>heldInSolo: true</code> annotations from a <em>prior</em> session. <strong style={{ color: ink }}>Decision: yes, banner appears</strong> — held state survived doc close; banner re-fires with "from a prior Solo session" copy.
          </div>
        </div>

        {/* State 3 */}
        <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ padding: '10px 14px 6px', fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>
            State 3 — Solo → Tandem transition
          </div>
          <HeldBanner count={3} variant="review" />
          <div style={{ padding: '10px 14px', fontSize: 12, color: muted, lineHeight: 1.5 }}>
            User flips back to Tandem. Held annotations do <strong style={{ color: ink }}>not unhide instantly</strong> — a review surface appears first. "Surface now" unhides all; "Dismiss all" clears the queue. Prevents annotation flood on switch.
          </div>
        </div>
      </div>

      {/* ──────────────────────────────────────────────────────────────
           State 3 expanded — the actual review surface in the rail
           Previously this was specced in prose only. Drawn here.
           ────────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: '356px 1fr', gap: 20,
        background: 'white', border: `1px solid ${hair}`, borderRadius: 10, overflow: 'hidden',
      }}>
        {/* Left: the rail at scale */}
        <div style={{ background: 'oklch(0.985 0.004 80)', borderRight: `1px solid ${hair}`, display: 'flex', flexDirection: 'column', minHeight: 420 }}>
          {/* Rail header — tabs */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '0 12px', height: 36, gap: 16, borderBottom: `1px solid ${hair}` }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: ink, borderBottom: `2px solid ${claudeC}`, padding: '10px 0', marginBottom: -1 }}>Annotations <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: muted, marginLeft: 2 }}>4</span></span>
            <span style={{ fontSize: 12, color: muted }}>Chat</span>
            <span style={{ fontSize: 12, color: muted }}>Outline</span>
          </div>

          {/* Review header */}
          <div style={{
            padding: '12px 14px 10px',
            background: 'oklch(0.96 0.03 150)',
            borderBottom: `1px solid oklch(0.82 0.08 150)`,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="oklch(0.42 0.14 150)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2l-8 8-3-3"/>
              </svg>
              <strong style={{ fontSize: 12.5, color: ink }}>Review held annotations</strong>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'oklch(0.40 0.14 150)', background: 'white', border: '1px solid oklch(0.82 0.08 150)', padding: '1px 6px', borderRadius: 99 }}>3 queued</span>
            </div>
            <p style={{ margin: 0, fontSize: 11.5, color: muted, lineHeight: 1.45 }}>
              Claude wrote these while you were in Solo. Choose what to bring back.
            </p>
          </div>

          {/* Per-item review cards */}
          <div style={{ flex: 1, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { kind: 'suggestion', label: 'Suggestion', time: '14m', snip: 'slipped due to an unexpected API redesign', body: 'Tighten this — "slipped due to" sounds reactive. Try "extended in scope when…"' },
              { kind: 'comment',    label: 'Comment',    time: '11m', snip: 'two-week implementation window with no regression risk', body: 'Worth adding a one-line caveat about the cache invalidation work in §3.' },
              { kind: 'note',       label: 'Note',       time: '7m',  snip: 'eventual consistency (write → warehouse lag ~800ms)', body: 'Confirmed with infra: 800ms is p95, not p99. Update before sending.' },
            ].map((item, i) => (
              <div key={i} style={{
                background: 'white', border: `1px solid ${hair}`, borderRadius: 6,
                padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: claudeC, flexShrink: 0 }} />
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: ink }}>Claude</span>
                  <span style={{
                    fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                    padding: '0 5px', borderRadius: 3,
                    background: item.kind === 'suggestion' ? 'oklch(0.95 0.03 305)' : item.kind === 'comment' ? 'oklch(0.95 0.03 245)' : 'oklch(0.96 0.005 80)',
                    color: item.kind === 'suggestion' ? 'oklch(0.42 0.18 305)' : item.kind === 'comment' ? 'oklch(0.42 0.16 245)' : muted,
                    border: `1px solid ${item.kind === 'suggestion' ? 'oklch(0.85 0.06 305)' : item.kind === 'comment' ? 'oklch(0.85 0.06 245)' : hair}`,
                  }}>{item.label}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: 'oklch(0.62 0.006 280)' }}>{item.time}</span>
                </div>
                <div style={{
                  fontFamily: 'Source Serif 4, serif', fontSize: 11.5, color: muted,
                  fontStyle: 'italic',
                  borderLeft: `2px solid ${hair}`, paddingLeft: 7,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>"{item.snip}"</div>
                <div style={{ fontSize: 11.5, color: ink, lineHeight: 1.4 }}>{item.body}</div>
                {/* Per-item actions */}
                <div style={{ display: 'flex', gap: 5, marginTop: 2 }}>
                  <button style={{
                    height: 22, padding: '0 9px',
                    background: 'oklch(0.55 0.14 150)', color: 'white', border: 'none',
                    borderRadius: 4, fontFamily: 'Inter Tight, sans-serif', fontSize: 10.5, fontWeight: 500, cursor: 'pointer',
                  }}>Surface</button>
                  <button style={{
                    height: 22, padding: '0 9px',
                    background: 'transparent', color: muted, border: `1px solid ${hair}`,
                    borderRadius: 4, fontFamily: 'Inter Tight, sans-serif', fontSize: 10.5, cursor: 'pointer',
                  }}>Dismiss</button>
                  <span style={{ flex: 1 }} />
                  <button style={{
                    height: 22, padding: '0 7px',
                    background: 'transparent', color: muted, border: 'none',
                    fontFamily: 'Inter Tight, sans-serif', fontSize: 10.5, cursor: 'pointer',
                  }}>Reveal in editor</button>
                </div>
              </div>
            ))}
          </div>

          {/* Sticky bulk-action bar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 10px', borderTop: `1px solid ${hair}`, background: 'oklch(0.975 0.005 80)',
          }}>
            <button style={{
              flex: 1, height: 26, border: `1px solid ${hair}`, background: 'white',
              borderRadius: 4, color: muted, fontFamily: 'Inter Tight, sans-serif', fontSize: 11, cursor: 'pointer',
            }}>Dismiss all</button>
            <button style={{
              flex: 1, height: 26, border: 'none', background: 'oklch(0.55 0.14 150)',
              borderRadius: 4, color: 'white', fontFamily: 'Inter Tight, sans-serif', fontSize: 11, fontWeight: 600, cursor: 'pointer',
            }}>Surface all</button>
          </div>
        </div>

        {/* Right: spec notes for the review surface */}
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'oklch(0.42 0.14 150)', marginBottom: 4 }}>State 3 expanded — review surface</div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: ink, letterSpacing: '-0.01em' }}>What the rail looks like during Solo → Tandem</h3>
            <p style={{ margin: '6px 0 0', fontSize: 12.5, color: muted, lineHeight: 1.5 }}>
              Replaces the normal annotation list <em>only</em> while there are <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>heldInSolo: true</code> items pending. Once cleared (per-item or via bulk action), the rail returns to its normal annotation view.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[
              ['Per-item Surface / Dismiss', 'User can triage individually — "Surface" promotes one annotation to the live list, "Dismiss" drops it. Cheaper than reading every body up front.'],
              ['Reveal in editor', 'Ghost link scrolls the editor to the anchored range without surfacing the annotation card. Lets the user check context before deciding.'],
              ['Sticky bulk actions', '"Surface all" is the affirmative default (filled accent button). "Dismiss all" is ghost — destructive actions never default-styled.'],
              ['No undo for Dismiss all', 'Dismissed annotations are gone — server clears the heldInSolo flag and the annotation if it was never user-surfaced. Confirm dialog only if queue >5.'],
              ['testid', <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }} key="t">held-review-surface</code>],
              ['Rail tab badge', 'Annotations tab keeps its existing count badge — the 4 in the mock is the live count. Held items are not counted until surfaced.'],
            ].map(([title, body]) => (
              <div key={title} style={{ padding: '10px 12px', background: 'oklch(0.975 0.005 80)', border: `1px solid ${hair}`, borderRadius: 6 }}>
                <div style={{ fontWeight: 600, fontSize: 11.5, color: ink, marginBottom: 3 }}>{title}</div>
                <div style={{ fontSize: 11, color: muted, lineHeight: 1.45 }}>{body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, fontSize: 12, color: muted }}>
        <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, lineHeight: 1.5 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Does heldInSolo survive session?</strong>
          Yes — field is server-persisted (v0.11.0). Clearing on doc close would silently drop Claude's work; surviving is the safer default. Clear only on explicit "Dismiss all."
        </div>
        <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, lineHeight: 1.5 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Instant unhide vs. review?</strong>
          Review surface (State 3). Instant unhide on a doc with 20+ held annotations is jarring. Review gives user agency and prevents annotation-flood UX surprise.
        </div>
        <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, lineHeight: 1.5 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Filter chips in Solo rail?</strong>
          Chips behave normally — they filter the held queue too. If Solo rail is visible, filter state applies to held items; "Highlights" chip would show only held highlights.
        </div>
      </div>
    </div>
  );
}

// ── B5: Diff view irreversibility ────────────────────────────────────────────
function B5DiffIrrevSpec({ tw = {} }) {
  const theme = tw.theme || 'light';
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const warn = 'oklch(0.62 0.16 65)';

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: warn, marginBottom: 4 }}>B5 — diff view irreversibility</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Communicating the undo boundary</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>The diff staging surface is the undo boundary. Once Apply is confirmed, the transaction lands as a single editor op. The current artboard doesn't visually communicate this. Two options:</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Option A: Bottom bar warning */}
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Option A — warning in bottom bar (recommended)</div>
          <div style={{
            background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden',
          }}>
            {/* Mock diff hunk */}
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${hair}` }}>
              <div style={{ fontSize: 12, fontFamily: 'JetBrains Mono, monospace', color: muted, marginBottom: 6 }}>Hunk 2 of 3 · Suggestion · Claude · 4m</div>
              <div style={{ background: 'var(--error-soft, oklch(0.96 0.03 25))', color: 'var(--error, oklch(0.55 0.18 25))', padding: '4px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13, textDecoration: 'line-through', marginBottom: 4 }}>slipped due to an unexpected API redesign</div>
              <div style={{ background: 'var(--success-soft, oklch(0.96 0.03 150))', color: 'var(--success, oklch(0.55 0.14 150))', padding: '4px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13 }}>extended in scope when an unplanned API redesign landed</div>
            </div>
            {/* Bottom bar with warning */}
            <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, background: 'oklch(0.975 0.005 80)' }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke={warn} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2L1.5 14h13L8 2z"/><path d="M8 7v3"/><circle cx="8" cy="12.5" r="0.5" fill={warn}/>
              </svg>
              <span style={{ fontSize: 11.5, color: muted, flex: 1 }}>
                Apply creates a <strong style={{ color: ink }}>single undo step</strong> — individual hunks cannot be undone separately after confirmation.
              </span>
              <button className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
              <button style={{
                height: 28, padding: '0 14px',
                background: ink, color: 'white', border: 'none', borderRadius: 5,
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                fontFamily: 'Inter Tight, sans-serif',
              }}>Apply 2 of 3</button>
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: muted }}>Warning is inline — no modal friction. User sees the boundary before clicking. Recommended.</p>
        </div>

        {/* Option B: Staging border */}
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Option B — staging indicator (dashed border)</div>
          <div style={{
            background: 'white',
            border: `2px dashed oklch(0.78 0.10 65)`,
            borderRadius: 8, overflow: 'hidden',
          }}>
            <div style={{ padding: '6px 10px', background: 'oklch(0.96 0.04 75)', borderBottom: `1px solid oklch(0.88 0.08 65)`, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'oklch(0.40 0.14 65)' }}>
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="2" y="3" width="10" height="8" rx="1"/><path d="M5 3V2h4v1"/></svg>
              Staging area · changes are not applied
            </div>
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${hair}` }}>
              <div style={{ background: 'var(--error-soft, oklch(0.96 0.03 25))', color: 'var(--error, oklch(0.55 0.18 25))', padding: '4px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13, textDecoration: 'line-through', marginBottom: 4 }}>slipped due to an unexpected API redesign</div>
              <div style={{ background: 'var(--success-soft, oklch(0.96 0.03 150))', color: 'var(--success, oklch(0.55 0.14 150))', padding: '4px 8px', borderRadius: 3, fontFamily: 'Source Serif 4, serif', fontSize: 13 }}>extended in scope when an unplanned API redesign landed</div>
            </div>
            <div style={{ padding: '10px 14px', display: 'flex', gap: 8, justifyContent: 'flex-end', background: 'oklch(0.975 0.005 80)' }}>
              <button className="btn-ghost" style={{ fontSize: 12 }}>Cancel</button>
              <button style={{ height: 28, padding: '0 14px', background: ink, color: 'white', border: 'none', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'Inter Tight, sans-serif' }}>Apply 2 of 3</button>
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: muted }}>Dashed amber border frames the whole surface as "staging." More visual noise; less precise. Secondary option.</p>
        </div>
      </div>

      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Decision: Option A.</strong> The inline warning text is unambiguous without blocking flow. The dashed staging border adds visual noise across the whole surface for a constraint that only matters at the moment of confirmation.
      </div>
    </div>
  );
}

// ── D1: Imported annotation attribution chip ─────────────────────────────────
function D1ImportChipSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const wordBlue = '#2A78A4';

  function ImportCard({ showAuthor = true, showFile = true, hoverMode = false }) {
    return (
      <div className="ar-card kind-note" style={{ maxWidth: 320 }}>
        <div className="ar-card-head">
          <span className="ar-author user"><span className="ar-author-dot" /> Note to self</span>
          {/* Imported chip */}
          <span className="chip imported" style={{ marginLeft: 4 }}>
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="1" y="1" width="10" height="8" rx="1"/><path d="M3.5 1v2h5V1"/>
            </svg>
            Imported
          </span>
          <span className="ar-time">May 8</span>
        </div>

        {/* Author attribution — below the head row */}
        {showAuthor && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 0 2px',
            fontSize: 11, color: muted,
          }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: 'oklch(0.62 0.006 280)' }}>From</span>
            <strong style={{ color: ink, fontSize: 11.5 }}>Sarah Chen</strong>
            {showFile && (
              <>
                <span style={{ color: 'var(--hair-strong)' }}>·</span>
                <span style={{
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5,
                  color: `color-mix(in oklch, ${wordBlue} 60%, oklch(0.48 0.008 280))`,
                  background: `color-mix(in oklch, ${wordBlue} 8%, transparent)`,
                  border: `1px solid color-mix(in oklch, ${wordBlue} 20%, transparent)`,
                  padding: '1px 5px', borderRadius: 3,
                }}>PRD-v2.docx</span>
              </>
            )}
          </div>
        )}

        <div className="ar-card-snip">"the dashboard timeline slipped due to an unexpected API redesign"</div>
        <div className="ar-card-body">The timeline in section 3 doesn't match what we agreed in the Q1 kickoff — can we reconcile before the board memo?</div>
        <div className="ar-actions">
          <button className="ar-act">Edit</button>
          <button className="ar-act">Remove</button>
          <span className="ar-act-spacer" />
          <button className="ar-act ar-act-convert">
            <Icon name="reply" size={11} /> Send to Claude
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: wordBlue, marginBottom: 4 }}>D1 — imported annotation attribution</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>author: "import" — how to show provenance</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>Full attribution (recommended)</div>
          <ImportCard showAuthor={true} showFile={true} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.45 }}>Author name + file provenance always visible. Use when importSource.author exists.</p>
        </div>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>Author only (no file)</div>
          <ImportCard showAuthor={true} showFile={false} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.45 }}>When importSource.file is absent. Use for programmatic imports where file provenance is unavailable.</p>
        </div>
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 8 }}>No attribution (legacy)</div>
          <ImportCard showAuthor={false} showFile={false} />
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.45 }}>When importSource is absent entirely. The "Imported" chip is sufficient fallback.</p>
        </div>
      </div>
      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Chip is not interactive</strong> (no filter-by-source-author). The batch-promote flow in ar-import is the discovery surface for imported annotations — filtering by source author inside the chip adds complexity without a proven use case. Revisit if users request it.
      </div>
    </div>
  );
}

// ── D2: Legacy highlight key fallback ────────────────────────────────────────
function D2LegacyHlSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';

  const colors = [
    { key: 'yellow', hex: 'rgba(234,179,8,0.22)', label: 'Yellow', shipped: true },
    { key: 'green',  hex: 'rgba(34,197,94,0.22)', label: 'Green', shipped: true },
    { key: 'blue',   hex: 'rgba(59,130,246,0.22)', label: 'Blue', shipped: true },
    { key: 'pink',   hex: 'rgba(236,72,153,0.22)', label: 'Pink', shipped: true },
    { key: 'red',    hex: 'rgba(220,38,38,0.22)', label: 'Red (legacy → pink)', shipped: false, mapsTo: 'pink', mapHex: 'rgba(236,72,153,0.22)' },
    { key: 'purple', hex: 'rgba(147,51,234,0.22)', label: 'Purple (legacy → blue)', shipped: false, mapsTo: 'blue', mapHex: 'rgba(59,130,246,0.22)' },
  ];

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.16 275)', marginBottom: 4 }}>D2 — legacy highlight palette fallback</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>red → pink · purple → blue (shipped in v0.11.0)</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
        {colors.map(c => (
          <div key={c.key} style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, padding: '12px', textAlign: 'center' }}>
            <div style={{ width: '100%', height: 28, borderRadius: 4, background: c.hex, marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {!c.shipped && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={muted} strokeWidth="1.5"><path d="M1 1l10 10M11 1L1 11"/></svg>
              )}
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: ink, fontWeight: 600, marginBottom: 2 }}>{c.key}</div>
            <div style={{ fontSize: 11, color: c.shipped ? 'oklch(0.52 0.14 150)' : muted }}>
              {c.shipped ? '✓ in picker' : 'removed'}
            </div>
            {c.mapsTo && (
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <span style={{ fontSize: 10, color: muted }}>→</span>
                <div style={{ width: 14, height: 14, borderRadius: 3, background: c.mapHex, border: `1px solid ${hair}` }} />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, color: muted }}>{c.mapsTo}</span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, fontSize: 12, color: muted }}>
        <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, lineHeight: 1.5 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Inbound legacy keys</strong>
          Annotations stored with <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>color: "red"</code> or <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>color: "purple"</code> are normalized on read by <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>sanitize.ts</code> (shipped). They render as pink/blue immediately — no migration script needed. The legacy keys are never written again.
        </div>
        <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, lineHeight: 1.5 }}>
          <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Unknown keys (future-proofing)</strong>
          Any key not in {'{yellow, green, blue, pink}'} falls back to <strong style={{ color: ink }}>yellow</strong> at render time. The picker hard-cuts to 4 colors — no legacy keys are selectable. Unknown keys that arrive from external imports are rendered in yellow without error.
        </div>
      </div>
    </div>
  );
}

// ── D3: Mini-toolbar collision transitions ────────────────────────────────────
function D3CollisionSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';
  const accent = 'oklch(0.52 0.16 275)';

  function SequenceFrame({ label, showMini, showPalette, dimMini, note }) {
    return (
      <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '7px 12px', borderBottom: `1px solid ${hair}`, fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.05em', textTransform: 'uppercase', color: muted }}>{label}</div>
        <div style={{ padding: '20px 16px', position: 'relative', minHeight: 120, background: 'oklch(0.985 0.004 80)' }}>
          {/* Fake selected text */}
          <p style={{ fontFamily: 'Source Serif 4, serif', fontSize: 14, color: ink, margin: 0, lineHeight: 1.6 }}>
            The dashboard timeline{' '}
            <span style={{ background: 'oklch(0.85 0.10 245 / 0.35)', borderRadius: 2, padding: '1px 0' }}>
              slipped due to an unexpected
            </span>
            {' '}API redesign.
          </p>

          {/* Mini toolbar */}
          {showMini && (
            <div style={{
              position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)',
              display: 'inline-flex', alignItems: 'center', gap: 1,
              background: 'white', border: `1px solid ${hair}`, borderRadius: 6,
              padding: '3px', boxShadow: '0 2px 8px rgba(20,20,30,0.10)',
              opacity: dimMini ? 0 : 1,
              transition: 'opacity 140ms ease',
              pointerEvents: dimMini ? 'none' : 'auto',
            }}>
              {['B','I'].map(l => <button key={l} style={{ width: 26, height: 26, border: 'none', background: 'transparent', borderRadius: 3, fontWeight: l==='B'?700:400, fontStyle: l==='I'?'italic':'normal', fontSize: 13, color: ink, cursor: 'pointer' }}>{l}</button>)}
              <div style={{ width: 1, height: 14, background: hair, margin: '0 2px' }}/>
              {['rgba(234,179,8,0.5)','rgba(34,197,94,0.5)','rgba(96,165,250,0.5)','rgba(236,72,153,0.5)'].map((c,i) => <span key={i} style={{ width: 13, height: 13, borderRadius: 3, background: c, border: `1px solid ${hair}`, margin: '0 1px' }}/>)}
            </div>
          )}

          {/* Command palette */}
          {showPalette && (
            <div style={{
              position: 'absolute', top: 6, left: '50%', transform: 'translateX(-50%)',
              width: 260, background: 'white', border: `1px solid ${hair}`, borderRadius: 8,
              boxShadow: '0 8px 24px rgba(20,20,30,0.14)', padding: '6px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', background: 'oklch(0.97 0.005 80)', borderRadius: 5, marginBottom: 4 }}>
                <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke={muted} strokeWidth="1.5" strokeLinecap="round"><circle cx="6" cy="6" r="4"/><path d="M10 10l3 3"/></svg>
                <span style={{ fontSize: 12, color: muted }}>Search commands…</span>
              </div>
              {['Apply suggestion', 'Toggle authorship', 'Open outline'].map(item => (
                <div key={item} style={{ padding: '5px 8px', borderRadius: 4, fontSize: 12, color: ink }}>{item}</div>
              ))}
            </div>
          )}
        </div>
        {note && <div style={{ padding: '7px 12px', borderTop: `1px solid ${hair}`, fontSize: 11, color: muted, lineHeight: 1.4 }}>{note}</div>}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: accent, marginBottom: 4 }}>D3 — mini-toolbar collision transitions</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Opening palette over an active selection</h2>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <SequenceFrame label="① Selection active — toolbar visible" showMini={true} showPalette={false} dimMini={false} note="Text selected. Mini-toolbar appears above. Opacity 1." />
        <SequenceFrame label="② Palette opens (⌘K) — toolbar fades" showMini={true} showPalette={true} dimMini={true} note="⌘K fires. Mini-toolbar fades to opacity 0 in 140ms. Palette slides in simultaneously. Selection highlight stays." />
        <SequenceFrame label="③ Palette active — toolbar gone" showMini={false} showPalette={true} dimMini={false} note="Mini-toolbar fully hidden (display:none after transition). Palette has full focus. Esc restores mini-toolbar." />
      </div>
      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Transition spec:</strong> 140ms opacity fade (ease). Find bar: instant hide (no fade, find takes keyboard focus). Slash menu: instant hide. Re-appearance: on palette/find close, selection is re-checked; mini-toolbar re-enters if selection still active (140ms fade-in). Never snap-replace — always crossfade or sequential.
      </div>
    </div>
  );
}

// ── D4: Toast notifications ──────────────────────────────────────────────────
function D4ToastSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';

  const toasts = [
    { severity: 'info',    bg: 'var(--surface, white)',               border: hair,                      icon: 'ℹ', label: 'Info',    copy: 'Authorship data loaded from cache.',                       dur: '3s',  dismiss: false },
    { severity: 'success', bg: 'oklch(0.97 0.03 150)',                border: 'oklch(0.84 0.07 150)',     icon: '✓', label: 'Success', copy: 'Annotation promoted to Claude.',                           dur: '4s',  dismiss: false },
    { severity: 'warning', bg: 'oklch(0.97 0.04 75)',                 border: 'oklch(0.84 0.08 65)',      icon: '⚠', label: 'Warning', copy: 'Store is read-only. Annotations buffered in memory.',       dur: '6s',  dismiss: true  },
    { severity: 'error',   bg: 'oklch(0.97 0.03 25)',                 border: 'oklch(0.84 0.08 25)',      icon: '✕', label: 'Error',   copy: 'Failed to save — disk full. Check storage and retry.',     dur: '∞',   dismiss: true  },
  ];
  const iconCol = { info: muted, success: 'oklch(0.48 0.14 150)', warning: 'oklch(0.45 0.14 65)', error: 'oklch(0.48 0.16 25)' };

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.16 275)', marginBottom: 4 }}>D4 — toast notification system</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>4 severities · position · stacking · timing</h2>
      </div>

      {/* Position diagram */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {toasts.map(t => (
            <div key={t.severity} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 12px', borderRadius: 8,
              background: t.bg, border: `1px solid ${t.border}`,
              boxShadow: '0 2px 8px rgba(20,20,30,0.06)',
            }}>
              <span style={{ fontSize: 13, color: iconCol[t.severity], flexShrink: 0, fontWeight: 700 }}>{t.icon}</span>
              <span style={{ flex: 1, fontSize: 13, color: ink }}>{t.copy}</span>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: muted, background: 'var(--surface-sunk, oklch(0.96 0.006 80))', border: `1px solid ${hair}`, padding: '1px 6px', borderRadius: 3, whiteSpace: 'nowrap' }}>
                {t.dur === '∞' ? 'persistent' : `auto-dismiss ${t.dur}`}
              </span>
              {t.dismiss && <button style={{ border: 'none', background: 'transparent', color: muted, cursor: 'pointer', fontSize: 16, padding: 0 }}>×</button>}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Position mock */}
          <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden', position: 'relative', height: 140 }}>
            <div style={{ padding: '8px 10px', borderBottom: `1px solid ${hair}`, fontFamily: 'JetBrains Mono, monospace', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>Position: top-right</div>
            <div style={{ position: 'absolute', top: 36, right: 10, display: 'flex', flexDirection: 'column', gap: 4, width: 160 }}>
              {/* Stacked newest on top */}
              <div style={{ background: 'oklch(0.97 0.03 25)', border: '1px solid oklch(0.84 0.08 25)', borderRadius: 5, padding: '5px 8px', fontSize: 10, color: ink }}>✕ Error toast (newest)</div>
              <div style={{ background: 'oklch(0.97 0.04 75)', border: '1px solid oklch(0.84 0.08 65)', borderRadius: 5, padding: '5px 8px', fontSize: 10, color: ink }}>⚠ Warning toast</div>
            </div>
          </div>
          <div style={{ padding: '12px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 11.5, color: muted, lineHeight: 1.5 }}>
            <strong style={{ color: ink, display: 'block', marginBottom: 4 }}>Stacking: newest on top.</strong>
            Max 4 visible. Overflow collapses into "+N more" with a count badge. testid: <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10 }}>toast-container</code>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── D5: Read-only info bar ────────────────────────────────────────────────────
function D5ROInfoBarSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.16 275)', marginBottom: 4 }}>D5 — read-only info bar</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Decision: keep both badge + info bar</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>The RO tab badge and the rail info bar serve different contexts. Badge = glanceable; info bar = actionable.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Tab badge */}
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Tab badge — glanceable, always visible</div>
          <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${hair}`, height: 30, padding: '0 12px', gap: 2, background: 'oklch(0.975 0.005 80)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderBottom: '2px solid oklch(0.52 0.16 275)', marginBottom: -1 }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, padding: '1px 4px', background: 'oklch(0.94 0.04 245)', color: 'oklch(0.42 0.16 245)', borderRadius: 3, letterSpacing: '0.04em' }}>DOCX</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: ink }}>q2-board-memo.docx</span>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, padding: '1px 5px', background: 'oklch(0.96 0.03 65)', color: 'oklch(0.45 0.14 65)', border: '1px solid oklch(0.88 0.08 65)', borderRadius: 3 }}>RO</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', color: muted, fontSize: 12 }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, padding: '1px 4px', background: 'oklch(0.96 0.005 80)', border: `1px solid ${hair}`, borderRadius: 3, color: muted }}>MD</span>
                rfc-007.md
              </div>
            </div>
            <div style={{ padding: '12px', fontFamily: 'Source Serif 4, serif', fontSize: 14, color: ink, lineHeight: 1.6 }}>
              Q2 Progress Review — Self-Service Dashboard…
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.4 }}>
            Badge appears on the tab when document is read-only. Uses warning token (amber). Always visible regardless of rail state.
          </p>
        </div>

        {/* Rail info bar */}
        <div>
          <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted, marginBottom: 10 }}>Rail info bar — actionable, context-rich</div>
          <div className="rail-info" style={{ margin: '0 0 8px' }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="8" cy="8" r="6"/><path d="M8 5v4"/><circle cx="8" cy="12" r="0.5" fill="currentColor"/>
            </svg>
            <div>
              <strong>Read-only · .docx</strong>
              <p style={{ margin: '2px 0 0', fontSize: 11 }}>Original file is never overwritten. Annotations are tracked. Apply Changes exports a copy with Word tracked-changes.</p>
              <a href="#" onClick={e => e.preventDefault()}>Apply Changes → Export copy…</a>
            </div>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: muted, lineHeight: 1.4 }}>
            Lives at top of rail body. Carries format-specific context (DOCX: "Apply Changes exports a copy"; Changelog: "Read-only · temporary"; scratchpad: handled by its own notice bar).
          </p>
        </div>
      </div>

      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Decision: keep both.</strong> They serve different user needs: badge = "is this file editable?" at-a-glance before opening the rail; info bar = "what does read-only mean for this file type?" when the user is in the rail. Dropping the info bar would leave users without the "Apply Changes → Export" affordance in the expected location.
      </div>
    </div>
  );
}

// ── E1: WCAG AA token audit ──────────────────────────────────────────────────
function E1WCAGSpec() {
  const ink = 'oklch(0.22 0.012 280)';
  const muted = 'oklch(0.48 0.008 280)';
  const hair = 'oklch(0.92 0.005 280)';

  const tokens = [
    { name: '--tandem-suggestion',       fill: 'oklch(0.52 0.18 305)', label: 'Suggestion fill',       bg: 'white',                       ratio: '3.1:1', pass: false, note: 'Fails AA for text. Use for fill/border only.' },
    { name: '--tandem-suggestion-fg',    fill: 'oklch(0.35 0.22 305)', label: 'Suggestion fg-strong',  bg: 'oklch(0.96 0.03 305)',        ratio: '4.8:1', pass: true,  note: 'Pass. For text on suggestion-soft bg.' },
    { name: '--tandem-success',          fill: 'oklch(0.55 0.14 150)', label: 'Success',                bg: 'white',                       ratio: '4.6:1', pass: true,  note: 'Pass.' },
    { name: '--tandem-warning',          fill: 'oklch(0.62 0.16 65)',  label: 'Warning',                bg: 'white',                       ratio: '3.4:1', pass: false, note: 'Fails AA. Use warning-fg-strong for text.' },
    { name: '--tandem-warning-fg',       fill: 'oklch(0.42 0.18 65)',  label: 'Warning fg-strong',     bg: 'oklch(0.96 0.04 75)',         ratio: '5.1:1', pass: true,  note: 'Pass.' },
    { name: '--tandem-error',            fill: 'oklch(0.55 0.18 25)',  label: 'Error',                  bg: 'white',                       ratio: '4.5:1', pass: true,  note: 'Pass (borderline — verify in dark mode).' },
    { name: '--tandem-info',             fill: 'oklch(0.52 0.16 245)', label: 'Info (author-user)',     bg: 'white',                       ratio: '4.6:1', pass: true,  note: 'Pass.' },
    { name: '--tandem-author-claude',    fill: '#D97757',              label: 'Author Claude',          bg: 'white',                       ratio: '3.2:1', pass: false, note: 'Fails AA. Use for decoration, not body text.' },
  ];

  return (
    <div style={{ width: '100%', height: '100%', background: 'oklch(0.96 0.008 80)', padding: 36, fontFamily: 'Inter Tight, sans-serif', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'oklch(0.52 0.18 25)', marginBottom: 4 }}>E1 — WCAG AA token audit · light theme</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: ink, letterSpacing: '-0.02em' }}>Status token split: fill vs. fg-strong</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: muted }}>The <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>suggestion</code> and <code style={{ fontFamily: 'JetBrains Mono, monospace' }}>warning</code> tokens fail WCAG AA for text on white. Split into fill/border token + separate fg-strong token for text.</p>
      </div>

      <div style={{ background: 'white', border: `1px solid ${hair}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '28px 200px 1fr 70px 60px 1fr', gap: '0 12px', padding: '8px 12px', borderBottom: `1px solid ${hair}`, fontFamily: 'JetBrains Mono, monospace', fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: muted }}>
          <span></span><span>Token</span><span>Label</span><span>Ratio</span><span>AA</span><span>Note</span>
        </div>
        {tokens.map(t => (
          <div key={t.name} style={{ display: 'grid', gridTemplateColumns: '28px 200px 1fr 70px 60px 1fr', gap: '0 12px', padding: '8px 12px', borderBottom: `1px solid ${hair}`, fontSize: 12, alignItems: 'center' }}>
            <span style={{ width: 16, height: 16, borderRadius: 3, background: t.fill, border: `1px solid ${hair}`, display: 'inline-block' }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: ink }}>{t.name}</span>
            <span style={{ color: muted }}>{t.label}</span>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5, color: t.pass ? 'oklch(0.45 0.14 150)' : 'oklch(0.48 0.16 25)', fontWeight: 600 }}>{t.ratio}</span>
            <span style={{ fontWeight: 700, color: t.pass ? 'oklch(0.45 0.14 150)' : 'oklch(0.48 0.16 25)' }}>{t.pass ? '✓' : '✗'}</span>
            <span style={{ color: muted, lineHeight: 1.4, fontSize: 11 }}>{t.note}</span>
          </div>
        ))}
      </div>

      <div style={{ padding: '12px 14px', background: 'white', border: `1px solid ${hair}`, borderRadius: 8, fontSize: 12, color: muted, lineHeight: 1.5 }}>
        <strong style={{ color: ink }}>Action for styles.css:</strong> Add <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>--tandem-suggestion-fg-strong: oklch(0.35 0.22 305)</code> and <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>--tandem-warning-fg-strong: oklch(0.42 0.18 65)</code>. Rename bare token uses in annotation cards that render text to the <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10.5 }}>-fg-strong</code> variant. Dark mode requires separate audit (higher luminance threshold).
      </div>
    </div>
  );
}

Object.assign(window, {
  B3SoloHeldSpec,
  B5DiffIrrevSpec,
  D1ImportChipSpec,
  D2LegacyHlSpec,
  D3CollisionSpec,
  D4ToastSpec,
  D5ROInfoBarSpec,
  E1WCAGSpec,
});
