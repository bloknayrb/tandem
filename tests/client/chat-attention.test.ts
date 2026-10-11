import { describe, expect, it, vi } from "vitest";
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
  let clock = 0;
  const seen = new Set(opts.seen ?? []);
  const timers: Array<() => void> = [];
  const backend = {
    notify: vi.fn<NotifierBackend["notify"]>(),
    attention: vi.fn<NotifierBackend["attention"]>(),
    clearAttention: vi.fn<NotifierBackend["clearAttention"]>(),
  };
  const playChime = vi.fn();
  const openChat = vi.fn();
  const attention = createChatAttention({
    getSettings: () => ({ ...DEFAULTS, ...opts.settings }),
    isActive: () => active,
    isSeen: (id) => seen.has(id),
    documentName: (id) => (id === "doc-1" ? "report.md" : null),
    backend,
    playChime,
    openChat,
    now: () => clock,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {},
  });
  const flush = () => {
    for (const fn of timers.splice(0)) fn();
  };
  return {
    attention,
    backend,
    playChime,
    openChat,
    flush,
    seen,
    setActive: (v: boolean) => {
      active = v;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createChatAttention (#2168)", () => {
  it("focused window: sound only", () => {
    const t = setup({ active: true });
    t.attention.push([reply("a")]);
    t.flush();
    expect(t.playChime).toHaveBeenCalledWith("chime", 60);
    expect(t.backend.notify).not.toHaveBeenCalled();
    expect(t.backend.attention).not.toHaveBeenCalled();
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

  it("a click opens chat on the reply's document", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.backend.notify.mock.calls[0][1]();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
    expect(t.backend.clearAttention).toHaveBeenCalled();
  });

  it("a desktop click event opens chat on the last announced document", () => {
    const t = setup();
    t.attention.push([reply("a", { documentId: "doc-1" })]);
    t.flush();
    t.attention.notificationActivated();
    expect(t.openChat).toHaveBeenCalledWith("doc-1");
  });

  it("posts at most one OS notification per 30 s while away, carrying held replies forward", () => {
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
    // The flash / title count still tracks every reply.
    expect(t.backend.attention).toHaveBeenLastCalledWith(3);
    expect(t.playChime).toHaveBeenCalledTimes(3);
    t.advance(30_000);
    t.attention.push([reply("d")]);
    t.flush();
    expect(t.backend.notify).toHaveBeenCalledTimes(2);
    expect(t.backend.notify.mock.calls[1][0].title).toBe("Claude sent 3 replies");
  });

  it("a fresh absence notifies immediately, whatever the last notification's age", () => {
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
});

describe("withTitleCount", () => {
  it("adds, replaces and removes only its own prefix", () => {
    expect(withTitleCount("Tandem", 1)).toBe("(1) Tandem");
    expect(withTitleCount("(1) Tandem", 12)).toBe("(9+) Tandem");
    expect(withTitleCount("(9+) ⚠ Tandem", 0)).toBe("⚠ Tandem");
  });
});
