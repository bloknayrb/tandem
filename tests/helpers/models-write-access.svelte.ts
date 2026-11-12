import { afterEach, beforeEach } from "vitest";

import {
  _resetModelsWriteAccessForTests,
  _setPageOriginForTests,
} from "../../src/client/hooks/useModelsWriteAccess.svelte";

/** The page the npm install's own server serves: Tandem's own window (#2404). */
export const OWN_PAGE_ORIGIN = "http://127.0.0.1:3479";

/**
 * Make each test in the file run as Tandem's own window, with the refusal
 * latch cleared. happy-dom's default page origin is the string "null", which
 * the Models tab rightly treats as a page that cannot change these settings —
 * so a suite about the ordinary tab has to say which page it is.
 * A test of the blocked state calls `_setPageOriginForTests` itself.
 */
export function asTandemOwnWindow(): void {
  beforeEach(() => {
    _resetModelsWriteAccessForTests();
    _setPageOriginForTests(OWN_PAGE_ORIGIN);
  });
  afterEach(() => {
    _resetModelsWriteAccessForTests();
  });
}
