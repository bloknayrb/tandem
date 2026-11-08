// A stand-in server that exits at once and never answers /health: the probe
// must report it could not evaluate (exit 3), never a pass. Booted through the
// probe's `--entry` test seam.
process.exit(1);
