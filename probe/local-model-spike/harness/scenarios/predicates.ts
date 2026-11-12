/**
 * Pattern builders for scenario predicates.
 *
 * A predicate is data (a label and a regular-expression source, always matched
 * case-insensitively), so the scenario set can be hashed and printed. The
 * builders exist because a model writes a date or a number many ways, and
 * because a distractor must not be "found" inside a longer token: `4.1` is not
 * in `14.1`, `March 3` is not in `March 31`, `60` is not in `1,600`.
 */

export interface Pattern {
  /** What this stands for, in words, for the reader. */
  label: string;
  /** RegExp source, matched with the `i` flag. */
  source: string;
}

/** Not preceded by a digit, or by a digit followed by a separator (`1,` `1.`). */
const NUM_START = "(?<![\\d])(?<![\\d][.,])";
/** Not followed by a digit, or by a separator and a digit. */
const NUM_END = "(?![\\d])(?![.,][\\d])";

function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matches(text: string, pattern: Pattern): boolean {
  return new RegExp(pattern.source, "i").test(text);
}

/** A literal word or phrase; inner spaces match any whitespace or a hyphen. */
export function phrase(text: string, label = text): Pattern {
  const body = text
    .trim()
    .split(/[\s-]+/)
    .map(esc)
    .join("[\\s-]+");
  return { label, source: `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` };
}

/** A whole word (no letters or digits either side). */
export function word(text: string, label = text): Pattern {
  return { label, source: `(?<![A-Za-z0-9])${esc(text)}(?![A-Za-z0-9])` };
}

/**
 * A plain number such as `17` or `42,500` or `0.8`. Thousands separators are
 * optional in the reply; pass `words` for spelled-out forms ("seventeen").
 */
export function number(value: string, words: string[] = []): Pattern {
  const [whole, frac] = value.replace(/,/g, "").split(".");
  let body = "";
  for (let i = 0; i < whole.length; i++) {
    const fromEnd = whole.length - i;
    if (i > 0 && fromEnd % 3 === 0) body += "[,\\s]?";
    body += whole[i];
  }
  if (frac !== undefined) body += `\\.${frac}`;
  // `$42,500.00` is still 42,500.
  else body += "(?:\\.0+)?";
  const alts = [`${NUM_START}${body}${NUM_END}`, ...words.map((w) => word(w).source)];
  return { label: value, source: alts.join("|") };
}

/** `48%`, `48 percent`, `48 per cent`. */
export function percent(value: string): Pattern {
  return {
    label: `${value}%`,
    source: `${NUM_START}${esc(value)}\\s*(?:%|percent|per\\s+cent)`,
  };
}

/** `$4.82M`, `4.82 million`, `4,820,000`. `value` is in millions. */
export function millions(value: string): Pattern {
  const expanded = String(Math.round(Number(value) * 1_000_000));
  return {
    label: `${value} million`,
    source: `${NUM_START}${esc(value)}\\s*(?:m(?![A-Za-z])|mm(?![A-Za-z])|mn(?![A-Za-z])|million)|${number(expanded).source}`,
  };
}

const MONTHS = [
  ["January", "Jan"],
  ["February", "Feb"],
  ["March", "Mar"],
  ["April", "Apr"],
  ["May", "May"],
  ["June", "Jun"],
  ["July", "Jul"],
  ["August", "Aug"],
  ["September", "Sept?"],
  ["October", "Oct"],
  ["November", "Nov"],
  ["December", "Dec"],
] as const;

/**
 * A calendar date, however it is usually written: `October 14, 2026`,
 * `Oct 14`, `14 October`, `14th of October`, `2026-10-14`, `10/14/2026`,
 * `14/10/26`. The year is optional in the month-name forms.
 */
export function date(year: number, month: number, day: number): Pattern {
  const [full, abbr] = MONTHS[month - 1];
  const name = `(?:${full}|${abbr}\\.?)`;
  const d = `0?${day}(?:st|nd|rd|th)?`;
  const mm = `0?${month}`;
  const yy = `(?:${year}|${String(year).slice(2)})`;
  // A year, when one is written, must be the right one.
  const noOtherYear = `(?!,?\\s+(?!${year})\\d{4})`;
  const alts = [
    `(?<![A-Za-z])${name}\\s+${d}${NUM_END}${noOtherYear}`,
    `${NUM_START}${d}\\s+(?:of\\s+)?${name}(?![A-Za-z])${noOtherYear}`,
    `${NUM_START}${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${NUM_END}`,
    `${NUM_START}${mm}/0?${day}(?:/${yy})?${NUM_END}(?!/)`,
    `${NUM_START}0?${day}/${mm}(?:/${yy})?${NUM_END}(?!/)`,
  ];
  return { label: `${full} ${day}, ${year}`, source: alts.join("|") };
}

/** A raw pattern, for the cases the builders do not cover. */
export function raw(label: string, source: string): Pattern {
  return { label, source };
}

/**
 * "The document does not say", in the ways a reply usually puts it. Used by the
 * unanswerable group. Deliberately broad: a reply that only hedges ("I'm not
 * sure") still has to avoid the planted values, and the reader decides the rest.
 */
export const NOT_STATED: Pattern = {
  label: "says the document does not state it",
  source: [
    // does not / doesn't / do not / don't / did not / never … say, see, find, …
    "(?:does\\s+not|doesn['’]?t|do\\s+not|don['’]?t|did\\s+not|didn['’]?t|never)\\s+(?:\\w+\\s+){0,3}?(?:say|state|mention|specify|include|give|provide|contain|list|name|indicate|address|cover|tell|disclose|identify|record|appear|see|find|know|have|set|show|report|note|count|put|offer|reveal|explain)",
    // is not / isn't / was not / has not been / hasn't been … stated, confirmed, …
    "(?:is|are|was|were|has|have|had)\\s*(?:n['’]?t|\\s+not)\\s+(?:\\w+\\s+){0,3}?(?:stated|mentioned|specified|given|provided|included|listed|named|indicated|addressed|covered|disclosed|identified|recorded|available|present|confirmed|approved|decided|determined|announced|set|counted|kept|known|reported|shown|part\\s+of|in\\s+(?:the|this)\\s+(?:document|text|report|summary|excerpt|plan|handbook|study|review|lease))",
    "(?<![A-Za-z])not\\s+(?:\\w+\\s+){0,2}?(?:stated|mentioned|specified|given|provided|included|listed|named|indicated|disclosed|identified|recorded|confirmed|approved|decided|known|reported|part\\s+of)",
    // there is no … / has no … / no mention of …
    "(?:there\\s+(?:is|are|was|were)|(?:has|have|had|gives|contains|includes|provides|offers|makes))\\s+no(?![A-Za-z])",
    "(?<![A-Za-z])no\\s+(?:\\w+\\s+){0,3}?(?:mention|information|indication|reference|record|detail|details|figure|date|number|answer|section|count|data|word)(?![A-Za-z])",
    "(?:can\\s*not|cannot|can['’]?t|could\\s+not|couldn['’]?t|unable\\s+to)\\s+(?:\\w+\\s+){0,2}?(?:find|determine|tell|locate|see|answer|confirm|say|work\\s+out)",
    "(?:nothing|nowhere)\\s+(?:\\w+\\s+){0,4}?(?:about|on|regarding|says|states|mentions|in\\s+(?:the|this)\\s+(?:document|text|report|summary|excerpt))",
    "(?:unclear|not\\s+clear|unknown)(?![A-Za-z])",
    "(?:leaves|left)\\s+(?:\\w+\\s+){0,3}?(?:out|unstated|unspecified|open)",
    "(?:only|just)\\s+(?:says|states|mentions|gives|covers|tells|lists|reports)",
  ].join("|"),
};
