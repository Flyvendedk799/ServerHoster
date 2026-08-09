import { describe, expect, it } from "vitest";
import { parsePairingInput } from "./pairing";

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

  it("rejects text that is obviously not a code, rather than guessing", () => {
    expect(parsePairingInput("")).toBeNull();
    expect(parsePairingInput("hi")).toBeNull();
    expect(parsePairingInput("a".repeat(40))).toBeNull();
    // A URL with no code in it is a URL, not a pairing.
    expect(parsePairingInput("https://example.com/")).toBeNull();
  });
});
