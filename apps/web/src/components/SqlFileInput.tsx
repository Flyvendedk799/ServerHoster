import { useRef, useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { toast } from "../lib/toast";

type Props = {
  onLoaded: (sql: string, filename: string) => void;
  /** Max file size in MB. SQL textareas are not designed for huge dumps; use the Restore flow for those. */
  maxMb?: number;
};

const ACCEPTED_EXT = [".sql", ".txt"];

export function SqlFileInput({ onLoaded, maxMb = 5 }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  function readFile(file: File): void {
    const isAccepted = ACCEPTED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext));
    if (!isAccepted) {
      toast.error(`Unsupported file. Use ${ACCEPTED_EXT.join(", ")}.`);
      return;
    }
    if (file.size > maxMb * 1024 * 1024) {
      toast.error(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Limit ${maxMb}MB. Use Restore for binary dumps.`
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onLoaded(String(reader.result ?? ""), file.name);
    reader.onerror = () => toast.error("Could not read file");
    reader.readAsText(file);
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) readFile(file);
  }

  return (
    <div
      className={`sql-file-input ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <FileUp size={14} />
      <span>
        Drop a <code>.sql</code> file or click to browse
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT.join(",")}
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) readFile(file);
          e.target.value = "";
        }}
      />
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .sql-file-input {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.45rem 0.7rem;
          border: 1px dashed var(--border-subtle);
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          font-size: 0.74rem;
          cursor: pointer;
          background: var(--bg-sunken);
          margin-bottom: 0.4rem;
          user-select: none;
        }
        .sql-file-input:hover, .sql-file-input.drag-over {
          border-color: var(--accent);
          color: var(--text-primary);
        }
      `
        }}
      />
    </div>
  );
}
