"use client";

import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
}

function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/**
 * Flattens React children (including fragments and arrays) into the list of
 * `<option>` descriptors backing the custom listbox. Mirrors native `<option>`
 * semantics: an option without an explicit `value` falls back to its text.
 */
function parseSelectOptions(children: ReactNode): SelectOption[] {
  const options: SelectOption[] = [];
  const walk = (node: ReactNode) => {
    Children.forEach(node, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Fragment) {
        walk((child.props as { children?: ReactNode }).children);
        return;
      }
      if (child.type === "option") {
        const props = child.props as {
          value?: string | number | readonly string[];
          children?: ReactNode;
          disabled?: boolean;
        };
        const label = extractText(props.children);
        const value =
          props.value != null ? String(props.value) : label;
        options.push({ value, label, disabled: Boolean(props.disabled) });
        return;
      }
      const nested = (child.props as { children?: ReactNode }).children;
      if (nested) walk(nested);
    });
  };
  walk(children);
  return options;
}

interface SelectProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onChange" | "value" | "defaultValue"
  > {
  label?: string;
  error?: string;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: { target: { value: string } }) => void;
  required?: boolean;
}

const TYPEAHEAD_RESET_MS = 500;

const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      className,
      label,
      error,
      id,
      name,
      value,
      defaultValue,
      onChange,
      disabled,
      required,
      children,
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) => {
    const reactId = useId();
    const baseId = id || name || reactId;
    const labelId = `${baseId}-label`;
    const listboxId = `${baseId}-listbox`;
    const errorId = `${baseId}-error`;

    const options = useMemo(() => parseSelectOptions(children), [children]);

    const [internalValue, setInternalValue] = useState(
      defaultValue != null ? String(defaultValue) : ""
    );
    const selectedValue = value != null ? String(value) : internalValue;
    const selectedIndex = options.findIndex((o) => o.value === selectedValue);
    const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;

    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const [dropUp, setDropUp] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
    const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>(
      { buffer: "", timer: null }
    );

    const setTriggerRef = useCallback(
      (node: HTMLButtonElement | null) => {
        triggerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );

    const firstEnabledIndex = useCallback(() => {
      return options.findIndex((o) => !o.disabled);
    }, [options]);

    const lastEnabledIndex = useCallback(() => {
      for (let i = options.length - 1; i >= 0; i -= 1) {
        if (!options[i].disabled) return i;
      }
      return -1;
    }, [options]);

    const nextEnabledIndex = useCallback(
      (from: number, direction: 1 | -1) => {
        let i = from + direction;
        while (i >= 0 && i < options.length) {
          if (!options[i].disabled) return i;
          i += direction;
        }
        return from;
      },
      [options]
    );

    const commit = useCallback(
      (newValue: string) => {
        if (value === undefined) setInternalValue(newValue);
        onChange?.({ target: { value: newValue } });
      },
      [onChange, value]
    );

    const openList = useCallback(() => {
      if (disabled) return;
      const trigger = triggerRef.current;
      if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        setDropUp(spaceBelow < 256 && spaceAbove > spaceBelow);
      }
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex());
      setOpen(true);
    }, [disabled, selectedIndex, firstEnabledIndex]);

    const closeList = useCallback(() => {
      setOpen(false);
      setActiveIndex(-1);
    }, []);

    const selectActive = useCallback(() => {
      const option = options[activeIndex];
      if (option && !option.disabled) commit(option.value);
      closeList();
      triggerRef.current?.focus();
    }, [options, activeIndex, commit, closeList]);

    const handleTypeahead = useCallback(
      (char: string) => {
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.buffer += char.toLowerCase();
        state.timer = setTimeout(() => {
          state.buffer = "";
        }, TYPEAHEAD_RESET_MS);

        const match = options.findIndex(
          (o) => !o.disabled && o.label.toLowerCase().startsWith(state.buffer)
        );
        if (match < 0) return;
        if (open) setActiveIndex(match);
        else commit(options[match].value);
      },
      [options, open, commit]
    );

    const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          if (!open) openList();
          else setActiveIndex((i) => nextEnabledIndex(i, 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          if (!open) openList();
          else setActiveIndex((i) => nextEnabledIndex(i, -1));
          break;
        case "Home":
          if (open) {
            event.preventDefault();
            setActiveIndex(firstEnabledIndex());
          }
          break;
        case "End":
          if (open) {
            event.preventDefault();
            setActiveIndex(lastEnabledIndex());
          }
          break;
        case "Enter":
          event.preventDefault();
          if (open) selectActive();
          else openList();
          break;
        case " ":
          event.preventDefault();
          if (open) selectActive();
          else openList();
          break;
        case "Escape":
          if (open) {
            event.preventDefault();
            closeList();
          }
          break;
        case "Tab":
          if (open) closeList();
          break;
        default:
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
            handleTypeahead(event.key);
          }
      }
    };

    useEffect(() => {
      if (!open) return;
      const handlePointer = (event: MouseEvent) => {
        if (!containerRef.current?.contains(event.target as Node)) closeList();
      };
      document.addEventListener("mousedown", handlePointer);
      return () => document.removeEventListener("mousedown", handlePointer);
    }, [open, closeList]);

    useLayoutEffect(() => {
      if (open && activeIndex >= 0) {
        optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
      }
    }, [open, activeIndex]);

    useEffect(() => {
      const state = typeahead.current;
      return () => {
        if (state.timer) clearTimeout(state.timer);
      };
    }, []);

    const activeOptionId =
      open && activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined;

    return (
      <div className="w-full">
        {label && (
          <label
            id={labelId}
            htmlFor={baseId}
            className="mb-1 block text-sm font-medium"
          >
            {label}
          </label>
        )}
        <div ref={containerRef} className="relative">
          <button
            ref={setTriggerRef}
            id={baseId}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            aria-labelledby={label ? labelId : undefined}
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            aria-required={required || undefined}
            disabled={disabled}
            onClick={() => (open ? closeList() : openList())}
            onKeyDown={handleKeyDown}
            className={cn(
              "flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-[hsl(var(--background))] px-3 py-2 text-left text-sm text-[hsl(var(--foreground))] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50",
              error && "border-[hsl(var(--destructive))]",
              className
            )}
            {...props}
          >
            <span className="truncate">{selectedOption?.label ?? " "}</span>
            <ChevronDown
              className="h-4 w-4 shrink-0 text-[hsl(var(--muted-foreground))]"
              aria-hidden="true"
            />
          </button>
          {open && (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-labelledby={label ? labelId : undefined}
              tabIndex={-1}
              className={cn(
                "absolute z-50 max-h-60 w-full overflow-auto rounded-md border bg-[hsl(var(--card))] py-1 text-sm text-[hsl(var(--card-foreground))] shadow-lg",
                dropUp ? "bottom-full mb-1" : "top-full mt-1"
              )}
            >
              {options.map((option, index) => {
                const isSelected = option.value === selectedValue;
                const isActive = index === activeIndex;
                return (
                  <li
                    key={`${option.value}-${index}`}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    id={`${baseId}-option-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onMouseEnter={() => {
                      if (!option.disabled) setActiveIndex(index);
                    }}
                    onClick={() => {
                      if (option.disabled) return;
                      commit(option.value);
                      closeList();
                      triggerRef.current?.focus();
                    }}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5",
                      isActive && "bg-[hsl(var(--accent))] text-[hsl(var(--accent-foreground))]",
                      option.disabled && "cursor-not-allowed opacity-50"
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {isSelected && (
                      <Check
                        className="h-4 w-4 shrink-0 text-[hsl(var(--primary))]"
                        aria-hidden="true"
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {error && (
          <p id={errorId} className="mt-1 text-xs text-[hsl(var(--destructive))]">
            {error}
          </p>
        )}
      </div>
    );
  }
);
Select.displayName = "Select";

export { Select, parseSelectOptions, type SelectProps, type SelectOption };
