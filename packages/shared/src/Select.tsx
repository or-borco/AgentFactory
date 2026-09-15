import type { SelectHTMLAttributes } from "react";

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
  placeholder: string;
  // Rendered right after the placeholder, before `options` — for a caller-specific option that
  // doesn't belong in the main list (e.g. the current value, kept selectable even though it's
  // fallen out of a freshly-fetched options list).
  extraOptions?: SelectOption[];
}

export function Select({ value, onChange, options, placeholder, extraOptions, ...rest }: SelectProps) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      <option value="">{placeholder}</option>
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
