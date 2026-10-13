// @vitest-environment happy-dom

/**
 * Browser notification backend (#2168): the options each notification is
 * posted with, and what `clearAttention` undoes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebNotifier,
  postWebNotification,
  withTitleCount,
} from "../../src/client/notifications/web-notifier";

interface Posted {
  title: string;
  options: NotificationOptions & { renotify?: boolean };
  close: ReturnType<typeof vi.fn>;
  onclick: (() => void) | null;
}

let posted: Posted[];

function stubNotification(permission: NotificationPermission): void {
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => permission);
    onclick: (() => void) | null = null;
    close = vi.fn();
    constructor(title: string, options: NotificationOptions) {
      posted.push(this as unknown as Posted);
      Object.assign(this, { title, options });
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
}

beforeEach(() => {
  posted = [];
  document.title = "Tandem";
  stubNotification("granted");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createWebNotifier", () => {
  it("posts with the reply tag, renotify and silent", () => {
    createWebNotifier().notify({ title: "Claude replied", body: "hi" }, () => {});
    expect(posted).toHaveLength(1);
    expect(posted[0].title).toBe("Claude replied");
    expect(posted[0].options).toEqual({
      body: "hi",
      tag: "tandem-chat",
      renotify: true,
      silent: true,
    });
  });

  it("posts nothing without permission", () => {
    stubNotification("default");
    createWebNotifier().notify({ title: "Claude replied", body: "" }, () => {});
    expect(posted).toHaveLength(0);
  });

  it("a click focuses, closes the notification and runs onClick", () => {
    const onClick = vi.fn();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    createWebNotifier().notify({ title: "Claude replied", body: "" }, onClick);
    posted[0].onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(posted[0].close).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledOnce();
    focus.mockRestore();
  });

  it("attention shows the count; clearAttention strips it and closes the last notification", () => {
    const backend = createWebNotifier();
    backend.notify({ title: "first", body: "" }, () => {});
    backend.notify({ title: "second", body: "" }, () => {});
    backend.attention(2);
    expect(document.title).toBe("(2) Tandem");
    backend.clearAttention();
    expect(document.title).toBe("Tandem");
    expect(posted[1].close).toHaveBeenCalledOnce();
    // Only the LAST one is tracked; the first was already replaced by tag.
    expect(posted[0].close).not.toHaveBeenCalled();
    // A second clear has nothing left to close.
    backend.clearAttention();
    expect(posted[1].close).toHaveBeenCalledOnce();
  });

  it("clearAttention survives a close() that throws", () => {
    const backend = createWebNotifier();
    backend.notify({ title: "x", body: "" }, () => {});
    posted[0].close.mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => backend.clearAttention()).not.toThrow();
    expect(document.title).toBe("Tandem");
  });
});

describe("postWebNotification", () => {
  it("uses the caller's tag and returns the notification", () => {
    const n = postWebNotification(
      { title: "t", body: "b" },
      { tag: "tandem-chat-test", onClick: () => {} },
    );
    expect(n).not.toBeNull();
    expect(posted[0].options.tag).toBe("tandem-chat-test");
  });

  it("returns null when the constructor throws", () => {
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function Throwing() {
          throw new TypeError("Illegal constructor");
        },
        { permission: "granted" },
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(postWebNotification({ title: "t", body: "" }, { tag: "x", onClick: () => {} })).toBe(
      null,
    );
    warn.mockRestore();
  });
});

describe("withTitleCount", () => {
  it("caps at 9+ and rewrites only its own prefix", () => {
    expect(withTitleCount("(3) Tandem", 12)).toBe("(9+) Tandem");
    expect(withTitleCount("(9+) Tandem", 0)).toBe("Tandem");
  });
});
