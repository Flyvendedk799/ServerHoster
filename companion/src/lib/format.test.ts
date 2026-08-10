import { describe, expect, it } from "vitest";
import { formatBytes, formatUptime, hostOf, relativeTime, statusTone } from "./format";

describe("formatBytes", () => {
  it("keeps units short enough for a phone", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(16 * 1024 ** 3)).toBe("16 GB");
  });

  it("survives nonsense from a half-populated response", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatUptime", () => {
  it("drops precision as the duration grows", () => {
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3 * 3600 + 25 * 60)).toBe("3h 25m");
    expect(formatUptime(5 * 86400 + 2 * 3600)).toBe("5d 2h");
    expect(formatUptime(0)).toBe("—");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  it("describes the recent past the way a person would", () => {
    expect(relativeTime("2026-01-01T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-01-01T11:45:00Z", now)).toBe("15m ago");
    expect(relativeTime("2026-01-01T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2025-12-29T12:00:00Z", now)).toBe("3d ago");
  });

  it("handles missing and malformed timestamps", () => {
    expect(relativeTime(null, now)).toBe("—");
    expect(relativeTime("not a date", now)).toBe("—");
    // Clock skew between phone and server must not render "in -3 minutes".
    expect(relativeTime("2026-01-01T12:00:30Z", now)).toBe("just now");
  });
});

describe("statusTone", () => {
  it("collapses control-plane states into up / busy / down / bad", () => {
    expect(statusTone("running")).toBe("up");
    expect(statusTone("building")).toBe("busy");
    expect(statusTone("crashed")).toBe("bad");
    expect(statusTone("stopped")).toBe("down");
    expect(statusTone("something-new")).toBe("down");
  });
});

describe("hostOf", () => {
  it("shows the host, and degrades to the raw string", () => {
    expect(hostOf("https://box.example.com:8787/x")).toBe("box.example.com:8787");
    expect(hostOf("nonsense")).toBe("nonsense");
  });
});
