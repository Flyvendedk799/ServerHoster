import { type ReactNode } from "react";

type StatusType = "running" | "stopped" | "crashed" | "building" | "provisioning" | "secure" | "error" | "none";

type Props = {
  status: StatusType | string;
  label?: string;
  dotOnly?: boolean;
  className?: string;
};

export function StatusBadge({ status, label, dotOnly, className }: Props) {
  const s = status.toLowerCase() as StatusType;
  
  const getColors = (val: StatusType) => {
    switch (val) {
      case "running":
      case "secure":
        return { bg: "var(--success-soft)", border: "var(--success)", text: "var(--success)", glow: "var(--success-glow)" };
      case "stopped":
      case "crashed":
      case "error":
        return { bg: "var(--danger-soft)", border: "var(--danger)", text: "var(--danger)", glow: "var(--danger-glow)" };
      case "building":
      case "provisioning":
        return { bg: "var(--warning-soft)", border: "var(--warning)", text: "var(--warning)", glow: "var(--warning-glow)" };
      default:
        return { bg: "var(--bg-elevated)", border: "var(--border-strong)", text: "var(--text-muted)", glow: "none" };
    }
  };

  const colors = getColors(s);

  if (dotOnly) {
    return (
      <span
        title={label || status}
        className={className}
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: colors.border,
          boxShadow: colors.glow,
          display: "inline-block",
          flexShrink: 0
        }}
      />
    );
  }

  return (
    <span
      className={`chip ${className || ""}`}
      style={{
        background: colors.bg,
        borderColor: colors.border,
        color: colors.text,
        boxShadow: colors.glow ? `inset 0 0 4px ${colors.glow}` : "none",
        padding: "0.2rem 0.6rem",
        fontSize: "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        textTransform: "uppercase"
      }}
    >
      {label || status}
    </span>
  );
}
