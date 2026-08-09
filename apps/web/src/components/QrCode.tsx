import { useMemo } from "react";
import qrcode from "qrcode-generator";

// The bundled default encoder is SJIS-only, which mangles any non-ASCII byte
// in the payload (a machine named "Tobias’ Mac mini" is not hypothetical).
qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

type Props = {
  value: string;
  /** Rendered size in CSS pixels. The SVG scales; module count sets sharpness. */
  size?: number;
  /** Quiet-zone width in modules. The spec says 4; less and some scanners fail. */
  margin?: number;
  className?: string;
  title?: string;
};

/**
 * A QR code as inline SVG.
 *
 * SVG rather than canvas so the code stays crisp when the operator zooms in to
 * let a phone focus, and so it prints. Error correction is fixed at M: the code
 * is read off a bright screen from 30cm, not off a scuffed parcel, and a lower
 * level keeps the module count (and therefore the camera's job) small.
 */
export function QrCode({ value, size = 240, margin = 4, className, title }: Props) {
  const path = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const segments: string[] = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) segments.push(`M${col + margin} ${row + margin}h1v1h-1z`);
      }
    }
    return { d: segments.join(""), extent: count + margin * 2 };
  }, [value, margin]);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${path.extent} ${path.extent}`}
      role="img"
      aria-label={title ?? "Pairing QR code"}
      shapeRendering="crispEdges"
    >
      {/* Always white behind the modules: a dark-theme card would otherwise
          invert the code and no scanner would read it. */}
      <rect width={path.extent} height={path.extent} fill="#ffffff" />
      <path d={path.d} fill="#000000" />
    </svg>
  );
}
