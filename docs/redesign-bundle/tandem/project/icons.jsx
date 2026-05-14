/* Tiny inline SVG icons for the redesign — stroke-based, 16px */
const Icon = ({ name, size = 16, stroke = 1.6, ...props }) => {
  const s = size;
  const sw = stroke;
  const common = { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: sw, strokeLinecap: 'round', strokeLinejoin: 'round', ...props };
  const paths = {
    bold: <><path d="M4 3h5a2.5 2.5 0 0 1 0 5H4z"/><path d="M4 8h6a2.5 2.5 0 0 1 0 5H4z"/></>,
    italic: <><path d="M10 3H6"/><path d="M11 13H7"/><path d="M9 3l-2 10"/></>,
    strike: <><path d="M3 8h10"/><path d="M5 4.5C5 3.7 6.3 3 8 3c1.5 0 3 .6 3 2"/><path d="M11 11.5c0 1-1.3 1.5-3 1.5-1.7 0-3-.5-3-1.7"/></>,
    h1: <><path d="M3 3v10"/><path d="M9 3v10"/><path d="M3 8h6"/><path d="M12 6l1.5-.7V13"/></>,
    h2: <><path d="M3 3v10"/><path d="M9 3v10"/><path d="M3 8h6"/><path d="M11.5 7c0-1 .8-1.5 1.7-1.5s1.7.5 1.7 1.5c0 2-3.4 2-3.4 6h3.4"/></>,
    bullet: <><circle cx="3" cy="4.5" r="0.7"/><circle cx="3" cy="8" r="0.7"/><circle cx="3" cy="11.5" r="0.7"/><path d="M6 4.5h7"/><path d="M6 8h7"/><path d="M6 11.5h7"/></>,
    ol: <><path d="M2 3.5h1V6"/><path d="M2 6h2"/><path d="M2 9.5c0-.5.5-1 1-1s1 .5 1 1c0 1-2 1.3-2 2.5h2"/><path d="M6 4.5h7"/><path d="M6 8h7"/><path d="M6 11.5h7"/></>,
    quote: <><path d="M3 6c0-1.5 1-2.5 2-2.5"/><path d="M3 6v3h3V6z"/><path d="M9 6c0-1.5 1-2.5 2-2.5"/><path d="M9 6v3h3V6z"/></>,
    code: <><path d="M5 4l-3 4 3 4"/><path d="M11 4l3 4-3 4"/></>,
    link: <><path d="M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5L8 4.5"/><path d="M9 7a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5L8 11.5"/></>,
    highlight: <><path d="M3 13h10"/><path d="M5 11l3 1 5-5-2-2-5 5z"/><path d="M9 4l2 2"/></>,
    comment: <><path d="M2.5 3h11v8h-7l-3 2.5V11H2.5z"/></>,
    flag: <><path d="M3 13V3"/><path d="M3 3h8l-1.5 2.5L11 8H3"/></>,
    sparkle: <><path d="M8 2v4"/><path d="M8 10v4"/><path d="M2 8h4"/><path d="M10 8h4"/><path d="M4 4l1.5 1.5"/><path d="M10.5 10.5L12 12"/><path d="M12 4l-1.5 1.5"/><path d="M5.5 10.5L4 12"/></>,
    undo: <><path d="M3 7h7a3 3 0 0 1 0 6H6"/><path d="M5 4L2 7l3 3"/></>,
    redo: <><path d="M13 7H6a3 3 0 0 0 0 6h4"/><path d="M11 4l3 3-3 3"/></>,
    settings: <><path d="M6.5 1.5h3l.5 2 1.5.87 2-.67 1.5 2.6-1.5 1.5v1.73l1.5 1.5-1.5 2.6-2-.67-1.5.87-.5 2h-3l-.5-2-1.5-.87-2 .67-1.5-2.6 1.5-1.5V8.27l-1.5-1.5 1.5-2.6 2 .67 1.5-.87.5-2z" strokeLinejoin="round"/><circle cx="8" cy="8" r="2.2"/></>,
    search: <><circle cx="7" cy="7" r="4"/><path d="M10 10l3 3"/></>,
    plus: <><path d="M8 3v10M3 8h10"/></>,
    x: <><path d="M4 4l8 8M12 4l-8 8"/></>,
    chevR: <><path d="M6 3l4 5-4 5"/></>,
    chevD: <><path d="M3 6l5 4 5-4"/></>,
    chevUp: <><path d="M3 10l5-4 5 4"/></>,
    chevDown: <><path d="M3 6l5 4 5-4"/></>,
    menu: <><path d="M2 4h12M2 8h12M2 12h12"/></>,
    check: <><path d="M3 8l3 3 7-7"/></>,
    reply: <><path d="M5 4L2 7l3 3"/><path d="M2 7h7a4 4 0 0 1 4 4v2"/></>,
    more: <><circle cx="3" cy="8" r="0.8"/><circle cx="8" cy="8" r="0.8"/><circle cx="13" cy="8" r="0.8"/></>,
    file: <><path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/></>,
    panelR: <><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/></>,
    panelL: <><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/></>,
    panelOff: <><rect x="2" y="3" width="12" height="10" rx="1.5"/></>,
    sun: <><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1"/></>,
    moon: <><path d="M13 9.5A5 5 0 1 1 6.5 3a4 4 0 0 0 6.5 6.5z"/></>,
    docMd: <><path d="M3 4h10v8H3z"/><path d="M5 9V7l1 1.2L7 7v2"/><path d="M9 7v2"/><path d="M9 9l1.5-1.5L12 9"/></>,
    docW: <><path d="M3 4h10v8H3z"/><path d="M5 7l1 3 1-2 1 2 1-3"/></>,
    lock: <><rect x="3" y="7" width="10" height="6" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></>,
    info: <><circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/></>,
    bug: <><circle cx="8" cy="8" r="3"/><path d="M5 8H2M14 8h-3M8 5V3M8 11v2M5.5 5.5L4 4M10.5 5.5L12 4M5.5 10.5L4 12M10.5 10.5L12 12"/></>,
    ext: <><path d="M9 3h4v4"/><path d="M13 3l-6 6"/><path d="M11 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/></>,
    help: <><circle cx="8" cy="8" r="6"/><path d="M6.2 6c.3-1 1.1-1.5 2-1.5 1.1 0 1.9.8 1.9 1.7 0 1.6-1.9 1.6-1.9 3"/><circle cx="8.1" cy="11.5" r="0.5" fill="currentColor"/></>,
    wifi: <><path d="M2 6.5a9 9 0 0 1 12 0"/><path d="M4 9a6 6 0 0 1 8 0"/><path d="M6 11.5a3 3 0 0 1 4 0"/><circle cx="8" cy="13.5" r="0.6" fill="currentColor"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
};

window.Icon = Icon;

// Detect platform once. In production, prefer navigator.userAgentData.platform.
// Returns 'mac' | 'win' | 'linux'. Forced to 'win' so design mocks render
// Windows-style chrome (matches the developer's target OS).
window.detectPlatform = function detectPlatform() {
  return 'win';
};

// Format a canonical Mac shortcut string for the given platform.
// Canonical tokens: ⌘ (Cmd), ⇧ (Shift), ⌥ (Option/Alt), ⌃ (Ctrl).
// Mac → returns the symbols as-is. Win/Linux → "Ctrl+Shift+R" style.
// Split a canonical shortcut string into individual key chips.
// "⌘⇧A" → ["⌘", "⇧", "A"]; "Ctrl+Shift+R" → ["Ctrl", "Shift", "R"]; "⌥↑↓" → ["⌥", "↑↓"]
// Used by <ShortcutTooltip> to render each modifier as its own kbd-chip.
window.splitShortcut = function splitShortcut(spec, platform) {
  if (!spec) return [];
  const formatted = window.formatShortcut(spec, platform);
  // Plus-separated (Win/Linux): split on '+'
  if (formatted.includes('+')) {
    return formatted.split('+').map(s => s.trim()).filter(Boolean);
  }
  // Mac glyph-prefixed: peel modifier symbols off the front, then the rest is one key.
  const mods = [];
  let rest = formatted;
  while (rest.length && '⌘⇧⌥⌃'.includes(rest[0])) {
    mods.push(rest[0]);
    rest = rest.slice(1);
  }
  if (rest.length) mods.push(rest);
  return mods;
};

// <ShortcutTooltip label keys placement> — wraps a child element and attaches
// a styled tooltip that surfaces on hover/focus. `keys` can be a canonical
// shortcut string ("⌘⇧A") OR an array of pre-split chips. `placement` is one
// of 'bottom' (default), 'top', 'left'. The host component should remove its
// own `title` attribute on the wrapped child to avoid the native tooltip
// stacking on top.
window.ShortcutTooltip = function ShortcutTooltip({ label, keys, placement = 'bottom', platform, children }) {
  const chips = Array.isArray(keys) ? keys : window.splitShortcut(keys, platform);
  // Build an accessible aria-label so screen readers still announce the shortcut.
  const ariaLabel = chips.length ? `${label} (${chips.join(' ')})` : label;
  return (
    <span className="tt-anchor" aria-label={ariaLabel}>
      {children}
      <span className={'tt tt-' + placement} role="tooltip">
        {label && <span className="tt-label">{label}</span>}
        {chips.length > 0 && (
          <span className="tt-keys">
            {chips.map((k, i) => (
              <React.Fragment key={i}>
                {i > 0 && /^[A-Za-z+]/.test(chips[0]) && chips[0].length > 1 && (
                  <span className="tt-key tt-key-plus">+</span>
                )}
                <span className="tt-key">{k}</span>
              </React.Fragment>
            ))}
          </span>
        )}
      </span>
    </span>
  );
};

window.formatShortcut = function formatShortcut(spec, platform) {
  if (!spec) return spec;
  const plat = platform || window.detectPlatform();
  if (plat === 'mac') return spec;
  // Split on whitespace to keep multi-chord strings ("⌘Z / ⌘⇧Z") readable.
  return spec.split(/(\s+|\/)/).map(part => {
    if (!/[⌘⇧⌥⌃]/.test(part)) return part;
    // Tokenize the modifier glyphs out of the front, then append the trailing literal key.
    const mods = [];
    let rest = part;
    while (rest.length && '⌘⇧⌥⌃'.includes(rest[0])) {
      const ch = rest[0];
      if (ch === '⌘') mods.push('Ctrl');
      else if (ch === '⇧') mods.push('Shift');
      else if (ch === '⌥') mods.push('Alt');
      else if (ch === '⌃') mods.push('Ctrl');
      rest = rest.slice(1);
    }
    // Dedupe (⌘+⌃ both → Ctrl) preserving order.
    const seen = new Set();
    const dedup = mods.filter(m => (seen.has(m) ? false : (seen.add(m), true)));
    return [...dedup, rest].filter(Boolean).join('+');
  }).join('');
};
