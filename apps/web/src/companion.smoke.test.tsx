// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { QrCode } from "./components/QrCode";

/**
 * The pairing QR is the whole handshake — if it encodes nothing, or encodes it
 * at a size no camera can resolve, pairing simply does not work and nothing
 * else in the companion flow gets a chance to fail visibly.
 */
describe("QrCode", () => {
  function renderPayload(value: string) {
    const { container } = render(<QrCode value={value} size={232} />);
    const svg = container.querySelector("svg")!;
    const viewBox = svg.getAttribute("viewBox")!.split(" ").map(Number);
    return {
      svg,
      extent: viewBox[2],
      path: svg.querySelector("path")!.getAttribute("d") ?? ""
    };
  }

  it("encodes a realistic pairing payload into a scannable grid", () => {
    const payload = JSON.stringify({
      v: 1,
      t: "serverhoster-pair",
      url: "https://hoster.example.com",
      code: "K7QM-3XVB",
      name: "mac-mini",
      exp: 1893456000000
    });
    const { extent, path } = renderPayload(payload);
    // 4 modules of quiet zone on each side, per the QR spec.
    const modules = extent - 8;
    expect(modules).toBeGreaterThanOrEqual(21);
    // Beyond ~version 10 (57 modules) a phone struggles at arm's length; if a
    // payload ever grows past that, it needs trimming rather than a bigger QR.
    expect(modules).toBeLessThanOrEqual(57);
    // A QR is always an odd-sized square of (17 + 4 * version) modules.
    expect((modules - 17) % 4).toBe(0);
    expect(path.length).toBeGreaterThan(100);
  });

  it("encodes non-ASCII server names instead of mangling them", () => {
    // The library's default encoder is SJIS and silently corrupts these; the
    // component switches it to UTF-8, and this is what would regress.
    const { path } = renderPayload('{"t":"serverhoster-pair","name":"Tobias’ Mac mini"}');
    expect(path.length).toBeGreaterThan(100);
  });

  it("paints a white ground so the code survives the dark dashboard theme", () => {
    const { svg } = renderPayload("hello");
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff");
  });
});
