const FORMULA_PREFIXES = ["=", "+", "-", "@"];

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";

  let str = String(value);

  if (FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) {
    str = `'${str}`;
  }

  if (/[",\r\n]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvField).join(",");
}
