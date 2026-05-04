import fs from "fs";
import path from "path";

const FORBIDDEN = ["fonts.googleapis.com", "fonts.gstatic.com"];
const TARGETS = [path.join("dist", "index.html"), "index.html"].filter((candidate) =>
  fs.existsSync(candidate),
);

if (TARGETS.length === 0) {
  throw new Error("No HTML files found to inspect for remote font references.");
}

const offenders = [];

for (const target of TARGETS) {
  const html = fs.readFileSync(target, "utf8");
  for (const token of FORBIDDEN) {
    if (html.includes(token)) {
      offenders.push(`${target} -> ${token}`);
    }
  }
}

if (offenders.length > 0) {
  throw new Error(
    `Remote font references are not allowed in shipped HTML:\n${offenders
      .map((line) => `- ${line}`)
      .join("\n")}`,
  );
}

console.log(`Font asset check passed for ${TARGETS.join(", ")}`);
