import { statusTone } from "../lib/format";

export function StatusPill({ status, small }: { status: string; small?: boolean }) {
  const tone = statusTone(status);
  return (
    <span className={`pill pill-${tone} ${small ? "pill-sm" : ""}`}>
      <i className={tone === "busy" ? "dot dot-pulse" : "dot"} aria-hidden="true" />
      {status}
    </span>
  );
}
