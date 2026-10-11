"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import { Calendar, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/cn";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Serializes a local date to `yyyy-mm-dd` (the `<input type="date">` format). */
function dateToISO(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses a `yyyy-mm-dd` string to a local `Date`, rejecting invalid calendar dates. */
function isoToDate(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function addMonths(date: Date, amount: number): Date {
  const next = new Date(date);
  const day = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + amount);
  const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, daysInMonth));
  return next;
}

function isSameDay(a: Date, b: Date): boolean {
  return dateToISO(a) === dateToISO(b);
}

/** Six-week grid (Sunday-first) covering the month `date` falls in. */
function buildMonthMatrix(date: Date): Date[][] {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const gridStart = addDays(first, -first.getDay());
  const weeks: Date[][] = [];
  let cursor = gridStart;
  for (let w = 0; w < 6; w += 1) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(row);
  }
  return weeks;
}

function isBelowMin(date: Date, minISO?: string): boolean {
  if (!minISO) return false;
  const min = isoToDate(minISO);
  return min ? dateToISO(date) < dateToISO(min) : false;
}

function isAboveMax(date: Date, maxISO?: string): boolean {
  if (!maxISO) return false;
  const max = isoToDate(maxISO);
  return max ? dateToISO(date) > dateToISO(max) : false;
}

function isDateInRange(date: Date, minISO?: string, maxISO?: string): boolean {
  return !isBelowMin(date, minISO) && !isAboveMax(date, maxISO);
}

interface DatePickerProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  error?: string;
  id?: string;
  name?: string;
}

function DatePicker({
  label,
  value,
  onChange,
  min,
  max,
  error,
  id,
  name,
}: DatePickerProps) {
  const t = useTranslations("ui.datePicker");
  const locale = useLocale();
  const reactId = useId();
  const baseId = id || name || reactId;
  const labelId = `${baseId}-label`;
  const dialogId = `${baseId}-dialog`;
  const errorId = `${baseId}-error`;
  const gridLabelId = `${baseId}-grid-label`;

  const selectedDate = useMemo(() => isoToDate(value), [value]);

  const [open, setOpen] = useState(false);
  const [inputText, setInputText] = useState(value);
  const [focusDate, setFocusDate] = useState<Date>(selectedDate ?? new Date());

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLTableElement>(null);
  const moveGridFocus = useRef(false);

  useEffect(() => {
    setInputText(value);
  }, [value]);

  const { weekdays, monthLabel, fullDateFormatter } = useMemo(() => {
    const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
    const weekdayLongFmt = new Intl.DateTimeFormat(locale, { weekday: "long" });
    const sunday = new Date(2024, 0, 7);
    return {
      weekdays: Array.from({ length: 7 }, (_, i) => ({
        short: weekdayFmt.format(addDays(sunday, i)),
        long: weekdayLongFmt.format(addDays(sunday, i)),
      })),
      monthLabel: new Intl.DateTimeFormat(locale, {
        month: "long",
        year: "numeric",
      }).format(focusDate),
      fullDateFormatter: new Intl.DateTimeFormat(locale, { dateStyle: "full" }),
    };
  }, [locale, focusDate]);

  const openCalendar = useCallback(() => {
    moveGridFocus.current = true;
    setFocusDate(selectedDate ?? new Date());
    setOpen(true);
  }, [selectedDate]);

  const closeCalendar = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    []
  );

  const selectDate = useCallback(
    (date: Date) => {
      if (!isDateInRange(date, min, max)) return;
      onChange(dateToISO(date));
      closeCalendar();
    },
    [min, max, onChange, closeCalendar]
  );

  const handleInputChange = (text: string) => {
    setInputText(text);
    if (text === "") {
      onChange("");
      return;
    }
    const parsed = isoToDate(text);
    if (parsed && isDateInRange(parsed, min, max)) onChange(dateToISO(parsed));
  };

  const handleInputBlur = () => {
    const parsed = isoToDate(inputText);
    if (inputText !== "" && !parsed) setInputText(value);
  };

  const clear = () => {
    onChange("");
    setInputText("");
    triggerRef.current?.focus();
  };

  const handleGridKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    let next: Date | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = addDays(focusDate, -1);
        break;
      case "ArrowRight":
        next = addDays(focusDate, 1);
        break;
      case "ArrowUp":
        next = addDays(focusDate, -7);
        break;
      case "ArrowDown":
        next = addDays(focusDate, 7);
        break;
      case "Home":
        next = addDays(focusDate, -focusDate.getDay());
        break;
      case "End":
        next = addDays(focusDate, 6 - focusDate.getDay());
        break;
      case "PageUp":
        next = addMonths(focusDate, event.shiftKey ? -12 : -1);
        break;
      case "PageDown":
        next = addMonths(focusDate, event.shiftKey ? 12 : 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectDate(focusDate);
        return;
      case "Escape":
        event.preventDefault();
        closeCalendar();
        return;
      default:
        return;
    }
    if (next) {
      event.preventDefault();
      moveGridFocus.current = true;
      setFocusDate(next);
    }
  };

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeCalendar(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    return () => document.removeEventListener("mousedown", handlePointer);
  }, [open, closeCalendar]);

  useLayoutEffect(() => {
    if (!open || !moveGridFocus.current) return;
    moveGridFocus.current = false;
    const iso = dateToISO(focusDate);
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-date="${iso}"]`)
      ?.focus();
  }, [open, focusDate]);

  const matrix = useMemo(() => buildMonthMatrix(focusDate), [focusDate]);
  const viewMonth = focusDate.getMonth();

  return (
    <div className="w-full">
      {label && (
        <label id={labelId} htmlFor={baseId} className="mb-1 block text-sm font-medium">
          {label}
        </label>
      )}
      <div ref={containerRef} className="relative">
        <div
          className={cn(
            "flex h-9 w-full items-center rounded-md border bg-[hsl(var(--background))] pl-3 pr-1 text-sm transition-colors focus-within:ring-2 focus-within:ring-[hsl(var(--ring))] focus-within:ring-offset-1",
            error && "border-[hsl(var(--destructive))]"
          )}
        >
          <input
            id={baseId}
            name={name}
            type="text"
            inputMode="numeric"
            value={inputText}
            placeholder="yyyy-mm-dd"
            aria-labelledby={label ? labelId : undefined}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => handleInputChange(e.target.value)}
            onBlur={handleInputBlur}
            className="h-full flex-1 bg-transparent text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus-visible:outline-none"
          />
          {value && (
            <button
              type="button"
              onClick={clear}
              aria-label={t("clear")}
              className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={dialogId}
            aria-label={t("openCalendar")}
            onClick={() => (open ? closeCalendar(false) : openCalendar())}
            className="rounded p-1 text-[hsl(var(--muted-foreground))] transition-colors hover:text-[hsl(var(--foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
          >
            <Calendar className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {open && (
          <div
            id={dialogId}
            role="dialog"
            aria-modal="false"
            aria-label={t("dialogLabel")}
            onKeyDown={(event) => {
              // Grid navigation handles its own Escape; this catches Escape
              // from the month buttons and other popup controls.
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeCalendar();
              }
            }}
            className="absolute top-full z-50 mt-1 w-72 rounded-md border bg-[hsl(var(--card))] p-3 text-[hsl(var(--card-foreground))] shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setFocusDate(addMonths(focusDate, -1))}
                aria-label={t("previousMonth")}
                className="rounded p-1 transition-colors hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <span id={gridLabelId} aria-live="polite" className="text-sm font-medium">
                {monthLabel}
              </span>
              <button
                type="button"
                onClick={() => setFocusDate(addMonths(focusDate, 1))}
                aria-label={t("nextMonth")}
                className="rounded p-1 transition-colors hover:bg-[hsl(var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <table
              ref={gridRef}
              role="grid"
              aria-labelledby={gridLabelId}
              className="w-full border-collapse"
              onKeyDown={handleGridKeyDown}
            >
              <thead>
                <tr role="row">
                  {weekdays.map((day) => (
                    <th
                      key={day.long}
                      role="columnheader"
                      scope="col"
                      abbr={day.long}
                      className="pb-1 text-center text-xs font-medium text-[hsl(var(--muted-foreground))]"
                    >
                      {day.short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.map((week) => (
                  <tr key={dateToISO(week[0])} role="row">
                    {week.map((day) => {
                      const iso = dateToISO(day);
                      const inMonth = day.getMonth() === viewMonth;
                      const isSelected = selectedDate ? isSameDay(day, selectedDate) : false;
                      const isFocusTarget = isSameDay(day, focusDate);
                      const disabled = !isDateInRange(day, min, max);
                      return (
                        <td key={iso} role="gridcell" aria-selected={isSelected} className="p-0.5">
                          <button
                            type="button"
                            data-date={iso}
                            tabIndex={isFocusTarget ? 0 : -1}
                            disabled={disabled}
                            aria-label={fullDateFormatter.format(day)}
                            aria-current={isSelected ? "date" : undefined}
                            onClick={() => selectDate(day)}
                            className={cn(
                              "flex h-8 w-8 items-center justify-center rounded text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]",
                              !inMonth && "text-[hsl(var(--muted-foreground))]",
                              isSelected
                                ? "bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))]"
                                : "hover:bg-[hsl(var(--accent))]",
                              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
                            )}
                          >
                            {day.getDate()}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

export {
  DatePicker,
  dateToISO,
  isoToDate,
  addDays,
  addMonths,
  buildMonthMatrix,
  isDateInRange,
  type DatePickerProps,
};
