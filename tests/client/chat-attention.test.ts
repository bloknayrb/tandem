import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNotificationText,
  type ChatAttentionSettings,
  createChatAttention,
  type NotifierBackend,
  previewText,
} from "../../src/client/notifications/chat-attention";
import { withTitleCount } from "../../src/client/notifications/web-notifier";
import type { ChatMessage } from "../../src/shared/types";

function reply(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, author: "claude", text: `text ${id}`, timestamp: 1, read: true, ...extra };
}

const DEFAULTS: ChatAttentionSettings = {
  chatNotifications: true,
  chatNotificationContent: "document",
  chatAttentionFlash: true,
  chatSound: "chime",
  chatSoundVolume: 60,
};

function setup(
  opts: { active?: boolean; seen?: string[]; settings?: Partial<ChatAttentionSettings> } = {},
) {
  let active = opts.active ?? false;
  const seen = new Set(opts.seen ?? []);
  const backend = {
    notify: vi.fn<NotifierBackend["notify"]>(),
    attention: vi.fn<NotifierBackend["attention"]>(),
    clearAttention: vi.fn<NotifierBackend["clearAttention"]>(),
  };
  const playChime = vi.fn();
  const openChat = vi.fn();
  // Real default timers and clock (`Date.now`), both faked by vitest.
  const attention = createChatAttention({
    getSettings: () => ({ ...DEFAULTS, ...opts.settings }),
    isActive: () => active,
    isSeen: (id) => seen.has(id),
    documentName: (id) => (id === "doc-1" ? "report.md" : null),
    backend,
    playChime,
    openChat,
  });
  return {
    attention,
    backend,
    playChime,
    openChat,
    seen,
    /** Run out the 750 ms coalescing window. */
    flush: () => vi.advanceTimersByTime(COALESCE_MS),
    advance: (ms: number) => vi.advanceTimersByTime(ms),
    setActive: (v: boolean) => {
      active = v;
    },
  };
}

const COALESCE_MS = 750;
const INTERVAL_MS = 30_000;

describe("createChatAttention (#2168)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("focused window: sound only", () => {
    const t = setup({ active: true });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledWith("chime", 60);
    expect(t.backend.notify).not.toHaveBeenCalled();
    expect(t.backend.attention).not.toHaveBeenCalled();
  });

  it("focused window chimes once per coalesced batch, with no rate limit", () => {
    const t = setup({ active: true });
    t.attention.push([reply("a")]);
    t.attention.push([reply("b")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(1);
    t.attention.push([reply("c")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(2);
  });

  it("focused window keeps its chime even though it acknowledged the reply itself", () => {
    const t = setup({ active: true, seen: ["a"] });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(1);
  });

  it("unfocused window: notification, flash and sound", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(1);
    expect(t.backend.notify).toHaveBeenCalledWith(
      { title: "Claude replied in report.md", body: "" },
      expect.any(Function),
    );
    expect(t.backend.attention).toHaveBeenCalledWith(1);
  });

  it("waits out the coalescing window before announcing", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.advance(COALESCE_MS - 1);
    expect(t.playChime).not.toHaveBeenCalled();
    expect(t.backend.notify).not.toHaveBeenCalled();
    t.advance(1);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst into one announcement", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.attention.push([reply("b"), reply("c")]);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    expect(t.backend.notify.mock.calls[0][0].title).toBe("Claude sent 3 replies");
    expect(t.playChime).toHaveBeenCalledTimes(1);
  });

  it("unfocused window drops replies another window already acknowledged", () => {
    const t = setup({ seen: ["a"] });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.playChime).not.toHaveBeenCalled();
    expect(t.backend.notify).not.toHaveBeenCalled();
    expect(t.backend.attention).not.toHaveBeenCalled();
  });

  it("an acknowledgement arriving inside the coalescing window still counts", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.advance(100);
    t.seen.add("a");
    t.flush();
    expect(t.backend.notify).not.toHaveBeenCalled();
    expect(t.backend.attention).not.toHaveBeenCalled();
  });

  it("honours each setting being off", () => {
    const t = setup({
      settings: { chatNotifications: false, chatAttentionFlash: false, chatSound: "none" },
    });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.backend.notify).not.toHaveBeenCalled();
    expect(t.backend.attention).not.toHaveBeenCalled();
    expect(t.playChime).toHaveBeenCalledWith("none", 60);
  });

  it("accumulates the attention count until the window is activated", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b")]);
    t.flush();
    expect(t.backend.attention).toHaveBeenLastCalledWith(2);
    t.attention.windowActivated();
    expect(t.backend.clearAttention).toHaveBeenCalledTimes(1);
    t.attention.windowActivated();
    expect(t.backend.clearAttention).toHaveBeenCalledTimes(1);
  });

  it("a burst inside the interval: one announcement now, a trailing one when it ends", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.advance(1_000);
    t.attention.push([reply("b")]);
    t.flush();
    t.advance(1_000);
    t.attention.push([reply("c")]);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    expect(t.playChime).toHaveBeenCalledTimes(1);
    // The flash / title count still tracks every reply.
    expect(t.backend.attention).toHaveBeenLastCalledWith(3);
    // The trailing announcement is due INTERVAL_MS after the first one.
    t.advance(INTERVAL_MS - 2 * (1_000 + COALESCE_MS) - 1);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    t.advance(1);
    expect(t.backend.notify).toHaveBeenCalledTimes(2);
    expect(t.backend.notify.mock.calls[1][0].title).toBe("Claude sent 2 replies");
    expect(t.playChime).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the trailing announcement skips replies read elsewhere meanwhile", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b"), reply("c", { documentId: "doc-1" })]);
    t.flush();
    t.seen.add("b");
    t.advance(INTERVAL_MS);
    expect(t.backend.notify).toHaveBeenCalledTimes(2);
    expect(t.backend.notify.mock.calls[1][0].title).toBe("Claude replied in report.md");
  });

  it("the trailing announcement is silent when every held reply was read elsewhere", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b")]);
    t.flush();
    t.seen.add("b");
    t.advance(INTERVAL_MS);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    expect(t.playChime).toHaveBeenCalledTimes(1);
    // The count stays until this window is focused.
    expect(t.backend.clearAttention).not.toHaveBeenCalled();
  });

  it("the trailing announcement is dropped if the window is active when it fires", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b")]);
    t.flush();
    t.setActive(true);
    t.advance(INTERVAL_MS);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    expect(t.playChime).toHaveBeenCalledTimes(1);
    // The dropped reply does not ride along in the next announcement.
    t.setActive(false);
    t.attention.push([reply("c")]);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(2);
    expect(t.backend.notify.mock.calls[1][0].title).toBe("Claude replied");
  });

  it("windowActivated cancels the trailing announcement", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b")]);
    t.flush();
    t.attention.windowActivated();
    expect(vi.getTimerCount()).toBe(0);
    t.advance(INTERVAL_MS);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
  });

  it("destroy cancels the coalescing and trailing timers", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.push([reply("b")]);
    t.flush();
    t.attention.push([reply("c")]);
    t.attention.destroy();
    expect(vi.getTimerCount()).toBe(0);
    t.advance(INTERVAL_MS);
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
    expect(t.playChime).toHaveBeenCalledTimes(1);
  });

  it("with notifications off the away chime is still rate-limited, and plays on the trailing announcement", () => {
    const t = setup({ settings: { chatNotifications: false } });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(1);
    t.advance(1_000);
    t.attention.push([reply("b")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledTimes(1);
    t.advance(INTERVAL_MS);
    expect(t.playChime).toHaveBeenCalledTimes(2);
    expect(t.backend.notify).not.toHaveBeenCalled();
  });

  it("a fresh absence announces immediately, whatever the last announcement's age", () => {
    const t = setup();
    t.attention.push([reply("a")]);
    t.flush();
    t.attention.windowActivated();
    t.advance(1_000);
    t.attention.push([reply("b")]);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(2);
    expect(t.backend.notify.mock.calls[1][0].title).toBe("Claude replied");
  });

  it("reads focus at flush time, not push time", () => {
    const t = setup({ active: true });
    t.attention.push([reply("a")]);
    t.setActive(false);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(1);
  });

  it("a click opens chat on the reply's document", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.backend.notify.mock.calls[0][1]();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
    expect(t.backend.clearAttention).toHaveBeenCalled();
  });

  it("a click opens the document the notification named, not a later held reply's", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.attention.push([reply("b", { documentId: "doc-2" })]);
    t.flush();
    t.backend.notify.mock.calls[0][1]();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
  });

  it("a desktop click event opens chat on the last announced document", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.attention.notificationActivated();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
  });

  it("a desktop click arriving just after the window was focused keeps the document", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    // Rust focuses the window before emitting the click event.
    t.attention.windowActivated();
    t.advance(1_000);
    t.attention.notificationActivated();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
  });

  it("a stale click, long after the window was focused with nothing pending, just opens chat", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.attention.windowActivated();
    t.advance(6_000);
    t.attention.notificationActivated();
    expect(t.openChat).toHaveBeenCalledWith(undefined);
  });
});

describe("buildNotificationText", () => {
  const name = (id: string) => (id === "doc-1" ? "report.md" : null);

  it("generic never names the document", () => {
    expect(buildNotificationText([reply("a", { documentId: "doc-1" })], "generic", name)).toEqual({
      title: "Claude replied",
      body: "",
    });
  });

  it("preview adds the start of the reply", () => {
    expect(
      buildNotificationText(
        [reply("a", { documentId: "doc-1", text: "**Done.** See [the doc](x)." })],
        "preview",
        name,
      ),
    ).toEqual({ title: "Claude replied in report.md", body: "Done. See the doc." });
  });

  it("a batch spanning documents names none", () => {
    expect(
      buildNotificationText(
        [reply("a", { documentId: "doc-1" }), reply("b", { documentId: "doc-2" })],
        "document",
        name,
      ).title,
    ).toBe("Claude sent 2 replies");
  });
});

describe("previewText", () => {
  it("collapses whitespace and caps at 140 characters", () => {
    const out = previewText(`a\n\n${"x".repeat(300)}`);
    expect(Array.from(out)).toHaveLength(140);
    expect(out.startsWith("a x")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("drops fenced code", () => {
    expect(previewText("Here:\n```ts\nconst x = 1;\n```\nDone")).toBe("Here: Done");
  });

  it("drops a fence a streamed reply has not closed yet", () => {
    expect(previewText("Here:\n```ts\nconst x")).toBe("Here:");
  });

  it("keeps link and image text", () => {
    expect(previewText("See [the doc](https://x/a_b) and ![a chart](c.png)")).toBe(
      "See the doc and a chart",
    );
  });

  it.each(["my_config_file.md", "x > 3", "a * b * c", "snake_case_name"])(
    "leaves %j alone",
    (text) => {
      expect(previewText(text)).toBe(text);
    },
  );

  it("strips leading heading, quote and bullet markers per line", () => {
    expect(previewText("# T\n> q")).toBe("T q");
    expect(previewText("> - item\n  * two")).toBe("item two");
  });

  it("keeps inline code contents verbatim", () => {
    expect(previewText("Run `npm *test*` now")).toBe("Run npm *test* now");
  });

  it("strips paired emphasis", () => {
    expect(previewText("_e_ *i* ~~s~~")).toBe("e i s");
    expect(previewText("**a** and **b**")).toBe("a and b");
    expect(previewText("__strong__ words")).toBe("strong words");
  });
});

describe("withTitleCount", () => {
  it("adds, replaces and removes only its own prefix", () => {
    expect(withTitleCount("Tandem", 1)).toBe("(1) Tandem");
    expect(withTitleCount("(1) Tandem", 12)).toBe("(9+) Tandem");
    expect(withTitleCount("(9+) ⚠ Tandem", 0)).toBe("⚠ Tandem");
  });
});
