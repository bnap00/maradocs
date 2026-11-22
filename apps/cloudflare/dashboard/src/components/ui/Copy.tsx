import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "../../lib/clipboard";
import { Tooltip } from "./Tooltip";
import { useToast } from "./Toast";

function useCopy(text: string, onCopied?: () => void) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  async function copy() {
    const ok = await copyText(text);
    if (!ok) {
      toast.error("Couldn't copy to the clipboard");
      return;
    }
    setCopied(true);
    onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }
  return { copied, copy };
}

/** Icon-only copy button. */
export function CopyButton({
  text,
  label = "Copy",
  size = "sm",
  variant = "ghost",
  onCopied,
}: {
  text: string;
  /** Accessible name; make it unique per row ("Copy link to Weekly status"). */
  label?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "secondary";
  onCopied?: () => void;
}) {
  const { copied, copy } = useCopy(text, onCopied);
  return (
    <Tooltip content={copied ? "Copied" : label}>
      <button
        type="button"
        className={`btn btn-${variant} btn-icon ${size === "sm" ? "btn-sm" : ""} copy-btn ${copied ? "is-copied" : ""}`}
        onClick={copy}
        aria-label={copied ? "Copied" : label}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </Tooltip>
  );
}

/** Copy button with a text label ("Copy link"). */
export function CopyTextButton({ text, children }: { text: string; children: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button type="button" className="btn btn-secondary" onClick={copy}>
      {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      <span className="btn-label">{copied ? "Copied" : children}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}

/** Read-only value (URL, key) with a copy button. */
export function CopyField({
  value,
  label,
  copyLabel,
  mono = true,
  id,
  onCopied,
}: {
  value: string;
  /** Accessible name of the field ("Latest URL"). */
  label: string;
  /** Accessible name of the copy button; defaults to "Copy <label>". */
  copyLabel?: string;
  mono?: boolean;
  id?: string;
  onCopied?: () => void;
}) {
  return (
    <div className="copy-field">
      <input
        id={id}
        className={`copy-field-input ${mono ? "mono" : ""}`}
        value={value}
        readOnly
        aria-label={id ? undefined : label}
        onFocus={(e) => e.currentTarget.select()}
        onCopy={onCopied}
        spellCheck={false}
      />
      <CopyButton text={value} label={copyLabel ?? `Copy ${label}`} onCopied={onCopied} />
    </div>
  );
}

/**
 * Multi-line command / snippet block with a copy button. Commands keep each
 * line intact and scroll sideways; pass `wrap` for prose (e.g. an agent prompt).
 */
export function CodeBlock({
  code,
  label = "Copy",
  language,
  wrap = false,
}: {
  code: string;
  label?: string;
  language?: string;
  wrap?: boolean;
}) {
  return (
    <div className={`code-block ${wrap ? "code-block-wrap" : ""}`}>
      {language && <span className="code-lang">{language}</span>}
      <pre tabIndex={0}>
        <code>{code}</code>
      </pre>
      <div className="code-copy">
        <CopyButton text={code} label={label} />
      </div>
    </div>
  );
}
