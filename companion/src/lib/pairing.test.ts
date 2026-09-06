import { afterEach, describe, expect, it } from "vitest";
import { parsePairingInput, servingMachineUrl } from "./pairing";

describe("parsePairingInput", () => {
  it("reads the raw QR payload the dashboard encodes", () => {
    const payload = JSON.stringify({
      v: 1,
      t: "serverhoster-pair",
      url: "https://box.example.com/",
      code: "ABCD-EFGH",
      name: "mac-mini",
      exp: 1
    });
    expect(parsePairingInput(payload)).toEqual({
      serverUrl: "https://box.example.com",
      code: "ABCD-EFGH",
      serverName: "mac-mini"
    });
  });

  it("refuses JSON that isn't a pairing payload", () => {
    expect(parsePairingInput(JSON.stringify({ t: "wifi", code: "X" }))).toBeNull();
    expect(parsePairingInput("{not json")).toBeNull();
  });

  it("reads a deep link, taking the parameters out of the hash", () => {
    const link = "https://companion.example/#/pair?s=https%3A%2F%2Fbox.example.com&c=ABCD-EFGH";
    expect(parsePairingInput(link)).toEqual({
      serverUrl: "https://box.example.com",
      code: "ABCD-EFGH",
      serverName: null
    });
  });

  it("falls back to the query string for links that don't use a hash route", () => {
    const link = "https://companion.example/pair?s=https://box.example.com&c=ABCD-EFGH";
    expect(parsePairingInput(link)?.code).toBe("ABCD-EFGH");
  });

  it("accepts a hand-typed code and normalizes it", () => {
    expect(parsePairingInput(" abcd-efgh ")).toEqual({
      serverUrl: null,
      code: "ABCDEFGH",
      serverName: null
    });
  });

  it("takes the link's own origin when the link carries no server address", () => {
    // The QR a control plane serving /m emits can leave `s` out; the machine
    // that answered the link IS the machine to pair with.
    const link = "http://192.168.1.20:8787/m/#/pair?c=ABCD2345";
    expect(parsePairingInput(link)).toEqual({
      serverUrl: "http://192.168.1.20:8787",
      code: "ABCD2345",
      serverName: null
    });
  });

  it("rejects text that is obviously not a code, rather than guessing", () => {
    expect(parsePairingInput("")).toBeNull();
    expect(parsePairingInput("hi")).toBeNull();
    expect(parsePairingInput("a".repeat(40))).toBeNull();
    // A URL with no code in it is a URL, not a pairing.
    expect(parsePairingInput("https://example.com/")).toBeNull();
  });
});

describe("servingMachineUrl", () => {
  afterEach(() => {
    document.head.querySelectorAll('meta[name="survhub-server"]').forEach((el) => el.remove());
  });

  function stamp(content: string): void {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "survhub-server");
    meta.setAttribute("content", content);
    document.head.appendChild(meta);
  }

  it("is null on a host that did not stamp one — a static host is not a control plane", () => {
    expect(servingMachineUrl()).toBeNull();
  });

  it("reads the machine that served this bundle and trims its trailing slash", () => {
    stamp("http://192.168.1.20:8787/");
    expect(servingMachineUrl()).toBe("http://192.168.1.20:8787");
  });

  it("ignores anything that is not an http(s) origin", () => {
    stamp("javascript:alert(1)");
    expect(servingMachineUrl()).toBeNull();
  });
});
