import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useId,
  useState,
} from "react";
import { Check, ChevronDown, Eye, EyeOff } from "lucide-react";

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  /** Render prop receives the generated control id + aria-describedby. */
  children: (ctl: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
  /** Visually hide the label (still read by screen readers). */
  hideLabel?: boolean;
}

export function Field({ label, hint, error, optional, children, className, hideLabel }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [errId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${className ?? ""}`}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "field-label"}>
        {label}
        {optional && <span className="field-optional">Optional</span>}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errId} className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> & {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, leading, trailing, className, ...rest },
  ref,
) {
  if (leading || trailing) {
    return (
      <div className={`input-group ${invalid ? "is-invalid" : ""} ${className ?? ""}`}>
        {leading && <span className="input-affix">{leading}</span>}
        <input ref={ref} className="input input-bare" aria-invalid={invalid || undefined} {...rest} />
        {trailing && <span className="input-affix">{trailing}</span>}
      </div>
    );
  }
  return (
    <input
      ref={ref}
      className={`input ${invalid ? "is-invalid" : ""} ${className ?? ""}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export const PasswordInput = forwardRef<HTMLInputElement, Omit<InputProps, "type" | "trailing">>(
  function PasswordInput({ invalid, className, ...rest }, ref) {
    const [show, setShow] = useState(false);
    return (
      <div className={`input-group ${invalid ? "is-invalid" : ""} ${className ?? ""}`}>
        <input
          ref={ref}
          type={show ? "text" : "password"}
          className="input input-bare"
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          {...rest}
        />
        <button
          type="button"
          className="input-reveal"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
        >
          {show ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
        </button>
      </div>
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={`input textarea ${invalid ? "is-invalid" : ""} ${className ?? ""}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ invalid, className, children, ...rest }, ref) {
  return (
    <div className={`select ${className ?? ""}`}>
      <select ref={ref} className={`input ${invalid ? "is-invalid" : ""}`} aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
      <ChevronDown size={15} className="select-chevron" aria-hidden />
    </div>
  );
});

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className={`switch-row ${disabled ? "is-disabled" : ""}`}>
      <div className="switch-text">
        <label htmlFor={id} className="switch-label">
          {label}
        </label>
        {description && (
          <p id={`${id}-desc`} className="field-hint">
            {description}
          </p>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-desc` : undefined}
        className="switch"
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, description, disabled }: CheckboxProps) {
  const id = useId();
  return (
    <label htmlFor={id} className={`checkbox-row ${checked ? "is-checked" : ""} ${disabled ? "is-disabled" : ""}`}>
      <span className="checkbox">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          aria-describedby={description ? `${id}-desc` : undefined}
        />
        <span className="checkbox-box" aria-hidden>
          <Check size={12} strokeWidth={3} />
        </span>
      </span>
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description && (
          <span id={`${id}-desc`} className="field-hint">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

interface SegmentedProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: ReactNode; icon?: ReactNode; title?: string }>;
  label: string;
  size?: "sm" | "md";
}

export function Segmented<T extends string>({ value, onChange, options, label, size = "md" }: SegmentedProps<T>) {
  return (
    <div className={`segmented ${size === "sm" ? "segmented-sm" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={value === o.value ? "is-active" : ""}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = options.findIndex((x) => x.value === value);
            const next = options[(i + (e.key === "ArrowRight" ? 1 : options.length - 1)) % options.length]!;
            onChange(next.value);
            const group = e.currentTarget.parentElement;
            requestAnimationFrame(() =>
              group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(),
            );
          }}
          tabIndex={value === o.value ? 0 : -1}
        >
          {o.icon}
          {o.label && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
