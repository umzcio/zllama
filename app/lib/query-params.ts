export function parseIntParam(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number | null {
  if (raw === null || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  if (value < min || value > max) return null;

  return value;
}

export function parseDateParam(raw: string | null): Date | null | undefined {
  if (raw === null || raw === "") return undefined;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;

  return date;
}
