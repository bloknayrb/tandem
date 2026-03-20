# Overlay API Specification

## Overview

Overlays are named, typed, color-coded analytical layers applied on top of document content without modifying the document itself.

## Built-in Overlay Types

1. **Document Quality** (`document-quality`) -- Per-paragraph quality scoring
2. **Source Citations** (`source-citations`) -- Per-sentence citation tracking
3. **Compliance Check** (`compliance-check`) -- Per-section regulatory compliance
4. **Reading Level** (`reading-level`) -- Per-paragraph Flesch-Kincaid heat map

## API Tools

- `overlay_create(definition)` -- Create a new overlay layer
- `overlay_update(overlayId, changes)` -- Update entries
- `overlay_toggle(overlayId, visible?)` -- Show/hide
- `overlay_remove(overlayId)` -- Delete permanently
- `overlay_query(filter?)` -- Read state
- `overlay_export(overlayId, format)` -- Export findings

## Anchoring

Overlays use node-relative anchors (AnchoredRange) instead of character offsets. Each range references a stable block node ID plus a character offset within that node. This means editing one paragraph only invalidates ranges anchored to that paragraph.

See src/shared/types.ts for full TypeScript interfaces.
