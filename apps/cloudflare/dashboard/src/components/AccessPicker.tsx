import { type ReactNode, useId } from "react";
import { CornerDownRight } from "lucide-react";
import { ACCESS_MODES, type AccessMode } from "../types";
import { ACCESS_META, PRIVATE_ACCESS_SUMMARY } from "./ui/Badge";
import { Button, PasswordInput } from "./ui";

export type AccessChoice = AccessMode | "inherit";

interface AccessPickerProps {
  value: AccessChoice;
  onChange: (v: AccessChoice) => void;
  /** Offer an "Inherit" option showing the parent's mode. */
  inheritFrom?: AccessMode;
  /** Name of the repository being inherited from, shown verbatim. */
  inheritName?: string;
  label?: string;
  disabled?: boolean;
  compact?: boolean;
}

const DETAIL: Record<AccessMode, string> = {
  public: "Anyone with the link can view. Good for reports meant to be shared widely.",
  password: "Viewers enter a shared password once; it's remembered per document.",
  private: PRIVATE_ACCESS_SUMMARY,
};

export function AccessPicker({
  value,
  onChange,
  inheritFrom,
  inheritName,
  label = "Access",
  disabled,
  compact,
}: AccessPickerProps) {
  const name = useId();
  const options: Array<{ value: AccessChoice; title: string; text: string; icon: ReactNode; mode: AccessMode | "inherit" }> = [];
  if (inheritFrom) {
    options.push({
      value: "inherit",
      mode: "inherit",
      title: `Inherit · ${ACCESS_META[inheritFrom].label}`,
      // User content (the repository name) is shown as typed, never re-cased.
      text: inheritName
        ? `Uses the default of “${inheritName}” (currently ${ACCESS_META[inheritFrom].label}).`
        : `Uses the repository default (currently ${ACCESS_META[inheritFrom].label}).`,
      icon: <CornerDownRight size={15} aria-hidden />,
    });
  }
  for (const m of ACCESS_MODES) {
    options.push({ value: m, mode: m, title: ACCESS_META[m].label, text: DETAIL[m], icon: ACCESS_META[m].icon(15) });
  }
  return (
    <fieldset className={`access-picker ${compact ? "is-compact" : ""}`} disabled={disabled}>
      <legend className="field-label">{label}</legend>
      <div className="access-options">
        {options.map((o) => (
          <label key={o.value} className={`access-option access-option-${o.mode} ${value === o.value ? "is-selected" : ""}`}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            <span className="access-option-icon">{o.icon}</span>
            <span className="access-option-text">
              <span className="access-option-title">{o.title}</span>
              <span className="access-option-desc">{o.text}</span>
            </span>
            <span className="access-option-radio" aria-hidden />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Password control for password-protected repos/docs.
 *  - mode "keep": a password already exists and won't change.
 *  - mode "set":  a new password is entered in `value`.
 *  - mode "clear": remove the existing password.
 */
export type PasswordMode = "keep" | "set" | "clear";

interface PasswordSettingProps {
  hasPassword: boolean;
  mode: PasswordMode;
  onModeChange: (m: PasswordMode) => void;
  value: string;
  onValueChange: (v: string) => void;
  /** Whether a password is required (access = password and nothing to fall back to). */
  required: boolean;
  allowClear: boolean;
  clearHint?: string;
  fallbackNote?: string;
  error?: string | null;
  label?: string;
}

export function PasswordSetting({
  hasPassword,
  mode,
  onModeChange,
  value,
  onValueChange,
  required,
  allowClear,
  clearHint,
  fallbackNote,
  error,
  label = "Password",
}: PasswordSettingProps) {
  const id = useId();
  if (hasPassword && mode !== "set") {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <div className={`password-status ${mode === "clear" ? "is-clearing" : ""}`}>
          <span>{mode === "clear" ? "Password will be removed on save." : "A password is set."}</span>
          <div className="password-status-actions">
            {mode === "clear" ? (
              <Button size="sm" variant="ghost" onClick={() => onModeChange("keep")}>
                Undo
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => onModeChange("set")}>
                  Change
                </Button>
                {allowClear && (
                  <Button size="sm" variant="danger-ghost" onClick={() => onModeChange("clear")}>
                    Remove
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {!allowClear && clearHint && <p className="field-hint">{clearHint}</p>}
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {hasPassword ? `New ${label.toLowerCase()}` : label}
        {!required && <span className="field-optional">Optional</span>}
      </label>
      <PasswordInput
        id={id}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        autoComplete="new-password"
        minLength={4}
        maxLength={256}
        invalid={Boolean(error)}
        aria-describedby={`${id}-hint`}
        placeholder="At least 4 characters"
      />
      {error ? (
        <p id={`${id}-hint`} className="field-error" role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className="field-hint">
          {fallbackNote ?? "Share it with viewers separately. Changing it signs out everyone who unlocked the page."}
        </p>
      )}
      {hasPassword && (
        <Button size="sm" variant="ghost" className="password-cancel" onClick={() => onModeChange("keep")}>
          Keep current password
        </Button>
      )}
    </div>
  );
}

export function passwordError(value: string, required: boolean): string | null {
  if (!value) return required ? "Enter a password (at least 4 characters)" : null;
  if (value.length < 4) return "At least 4 characters";
  if (value.length > 256) return "At most 256 characters";
  return null;
}
