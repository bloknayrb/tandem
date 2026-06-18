/**
 * Deterministically generate the ~50-page envelope fixture for the #1123 spike.
 * Writes fixtures/envelope-50page.md.
 *
 * Seeds known target spans at controlled depths so the envelope scenarios can
 * measure anchor accuracy as a function of depth + windowed-reading correctness
 * (get_outline -> read_section), not just speed. Includes a repeated phrase
 * across distant sections (occurrence_index at scale), near-duplicate
 * distractors, and a cross-section contradiction.
 *
 * Deterministic (index-based content, no RNG) so the fixture is reproducible.
 *
 * Run: npx tsx probe/local-model-spike/generate-envelope.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "fixtures", "envelope-50page.md");

const TOPICS = [
  "Market Overview", "Revenue Analysis", "Cost Structure", "Headcount Plan", "Product Roadmap",
  "Engineering Velocity", "Customer Segments", "Churn Drivers", "Pricing Strategy", "Vendor Contracts",
  "Infrastructure Spend", "Security Posture", "Compliance Status", "Regional Performance", "Partnerships",
  "Marketing Funnel", "Support Operations", "Quality Metrics", "Release Cadence", "Technical Debt",
  "Data Governance", "Hiring Pipeline", "Retention Programs", "Capital Allocation", "Risk Register",
  "Scenario Planning", "Competitive Landscape", "Supply Chain", "Logistics", "Inventory Controls",
  "Forecast Accuracy", "Cash Position", "Debt Schedule", "Tax Considerations", "Audit Findings",
  "Board Priorities", "Strategic Bets", "Innovation Budget", "Research Pipeline", "Patent Portfolio",
  "Brand Health", "Community Metrics", "Accessibility Review", "Localization Plan", "Sustainability",
  "Workforce Planning", "Facilities", "Travel Policy", "Procurement", "Closing Remarks",
];

function filler(section: number, para: number): string {
  // Stable, varied-ish English filler keyed to (section, para) — no RNG.
  const subjects = ["The team", "Leadership", "This unit", "The committee", "Our analysis", "The working group", "Management", "The review"];
  const verbs = ["evaluated", "reported", "tracked", "projected", "reconciled", "summarized", "monitored", "assessed"];
  const objs = ["the relevant figures", "the quarterly trend", "the underlying drivers", "the variance", "the planned milestones", "the open risks", "the key dependencies", "the stated assumptions"];
  const tails = [
    "No material changes were noted this period.",
    "The results were consistent with prior guidance.",
    "Further detail is available in the appendix.",
    "The figures are subject to board approval.",
    "Outcomes will be revisited next cycle.",
    "Stakeholders were notified accordingly.",
  ];
  const s = subjects[(section + para) % subjects.length];
  const v = verbs[(section * 3 + para) % verbs.length];
  const o = objs[(section + para * 2) % objs.length];
  const t = tails[(section * 2 + para) % tails.length];
  const s2 = subjects[(section + para + 3) % subjects.length];
  const v2 = verbs[(section + para + 5) % verbs.length];
  const o2 = objs[(section * 2 + para + 1) % objs.length];
  return (
    `${s} ${v} ${o}. ${t} ${s2} also ${v2} ${o2} during the period, and the conclusions were documented for the record. ` +
    `This paragraph adds context for section ${section} (paragraph ${para}) so the document reaches the fifty-page envelope used to test windowed reading and deep anchoring. ` +
    `The narrative continues with supporting detail, cross-references to adjacent sections, and the usual caveats about preliminary figures, so that retrieval of a specific seeded fact requires reading the right section rather than scanning the opening pages.`
  );
}

const lines: string[] = [];
lines.push("# Annual Operating Review");
lines.push("");
lines.push("This document is the full annual operating review. It is intentionally long to exercise reading and anchoring at the fifty-page performance envelope.");
lines.push("");

// Seeded targets placed in TOPICALLY-ALIGNED sections (a reasoning model can
// navigate to them via the outline) at varied depth — a fair windowed-reading
// test, not a needle-in-haystack lottery. Index → TOPICS:
//   2 Cost Structure (early), 13 Regional Performance (mid), 30 Forecast Accuracy
//   (later), 34 Audit Findings (~p38), 49 Closing Remarks (end).
const SEED: Record<number, string[]> = {
  2: [
    "The total budget for the year is $1,200,000 according to the early plan.",
    "Material costs in this division were $73,400, which is flagged for review.",
  ],
  13: ["The quarterly variance is $5,000 in this region, which warrants a closer look."],
  30: ["The quarterly variance is $5,000 in this region, which warrants a closer look."],
  34: ["The final sign-off deadline is September 30, 2026, pending the audit."],
  49: ["Restating the figure from earlier, the total budget for the year is $1,500,000 in the revised plan."],
};

TOPICS.forEach((topic, i) => {
  // Natural headings (no number prefix) so read_section matching isn't an artifact.
  lines.push(`## ${topic}`);
  lines.push("");
  // ~6 paragraphs per section → ~50-55 pages overall.
  for (let p = 0; p < 6; p++) {
    if (p === 1 && SEED[i]) {
      for (const seeded of SEED[i]) lines.push(seeded);
    }
    lines.push(filler(i, p));
    lines.push("");
  }
});

const md = lines.join("\n");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md, "utf8");

const words = md.split(/\s+/).filter(Boolean).length;
console.log(`Wrote ${OUT}`);
console.log(`Sections: ${TOPICS.length}, words: ${words}, ~pages: ${Math.round(words / 500)}`);
