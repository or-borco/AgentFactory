import type { CSSProperties, SelectHTMLAttributes } from "react";

export interface SelectOption {
  key: string | number;
  value: string;
  label: string;
}

type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "children">;

export interface SelectProps extends NativeSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  // Omit when the field always has a real selection (e.g. a run picker defaulting to the
  // newest run) — no empty option is rendered in that case.
  placeholder?: string;
  // Rendered right after the placeholder, before `options` — for a caller-specific option that
  // doesn't belong in the main list (e.g. the current value, kept selectable even though it's
  // fallen out of a freshly-fetched options list).
  extraOptions?: SelectOption[];
}

// The one look for every plain <select> in the app: a bordered box matching TextInput's, room
// on the right so the browser's native chevron doesn't crowd the border, and a muted color
// while the empty/placeholder option (value === "") is selected. Exported so `GroupedSelect`'s
// multi-group branch — a raw <select>, not this component — stays pixel-identical.
//
// Deliberately doesn't set a width — most callers want `w-full` (pass it via `className`), but a
// few (an inline run picker, a compact assignee dropdown) size to content instead.
// `className` is appended last so a caller can extend or override it.
export function selectClassName(value: string, className = ""): string {
  return `rounded-[var(--radius-md)] border border-[var(--color-divider)] bg-[var(--color-surface)] py-2.5 pl-3 pr-8 text-sm focus:border-[var(--color-accent)] focus:outline-none ${
    value === "" ? "text-[var(--color-neutral-600)]" : "text-[var(--color-text)]"
  } ${className}`;
}

// A smaller inline variant for toolbar-style pickers that sit next to compact buttons (e.g. a
// run picker in a panel header) instead of filling a form field. Callers pass this via the
// `style` prop, which — being inline — overrides `selectClassName`'s Tailwind classes for every
// property it sets; only `Select`'s `focus:` rules still apply on top.
export function compactSelectStyle(value: string): CSSProperties {
  return {
    background: "var(--color-surface)",
    border: "1px solid var(--color-divider)",
    borderRadius: "var(--radius-md)",
    color: value === "" ? "var(--color-neutral-500)" : "var(--color-text)",
    fontSize: 13,
    padding: "6px 10px",
  };
}

// A tight inline variant for an editable value sitting inside a list/meta row next to a label
// or badge (e.g. an assignee picker, a skill-version picker) — visually smaller than
// `compactSelectStyle` and sharing its neighboring inline controls' border token instead of
// `selectClassName`'s. Callers pass `hasValue` since the muted/filled color split isn't always
// driven by an empty-string placeholder value (e.g. an `undefined` id).
export function inlineSelectStyle(hasValue: boolean): CSSProperties {
  return {
    padding: "3px 20px 3px 6px",
    borderRadius: "var(--radius-sm)",
    border: "1px solid var(--color-neutral-700)",
    background: "var(--color-surface)",
    color: hasValue ? "var(--color-text)" : "var(--color-neutral-600)",
    fontSize: 13,
  };
}

export function Select({ value, onChange, options, placeholder, extraOptions, className, ...rest }: SelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectClassName(value, className)}
      {...rest}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {extraOptions?.map((option) => (
        <option key={option.key} value={option.value}>
          {option.label}
        </option>
      ))}
      {options.map((option) => (
        <option key={option.key} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
