import type { SelectHTMLAttributes } from "react";
import { Select, selectClassName } from "./Select";
import type { SelectOption } from "./Select";

export interface GroupedSelectOption extends SelectOption {
  group: string;
}

type NativeSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "children">;

export interface GroupedSelectProps extends NativeSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: GroupedSelectOption[];
  // Omit when the field always has a real selection — no empty option is rendered in that case.
  placeholder?: string;
  extraOptions?: SelectOption[];
  groupLabel: (group: string) => string;
}

// Groups options under an <optgroup> per distinct group — but only when more than one group is
// present. With a single group (or none), this renders exactly like a flat Select: a picker
// with only one connected source stays pixel-identical to a plain flat list, and gains real
// grouping automatically the moment a second group's options appear.
export function GroupedSelect({
  value,
  onChange,
  options,
  placeholder,
  extraOptions,
  groupLabel,
  className,
  ...rest
}: GroupedSelectProps) {
  const groups = [...new Set(options.map((option) => option.group))];

  if (groups.length <= 1) {
    return (
      <Select
        value={value}
        onChange={onChange}
        options={options}
        placeholder={placeholder}
        extraOptions={extraOptions}
        className={className}
        {...rest}
      />
    );
  }

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
      {groups.map((group) => (
        <optgroup key={group} label={groupLabel(group)}>
          {options
            .filter((option) => option.group === group)
            .map((option) => (
              <option key={option.key} value={option.value}>
                {option.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
