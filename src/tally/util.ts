// Shared utilities for tool implementations.

/** Coerce any Tally value (which may already be a Number/Boolean from the parser) to a string. */
export function s(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Coerce to number, handling Tally's empty / whitespace cases. */
export function n(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  const num = Number(v);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * Tally amount fields often look like "1234.56" or " 1234.56 Cr" / "-1234.56 Dr".
 * Returns a signed number where Debit is negative and Credit is positive
 * (matching the Tally convention that ISDEEMEDPOSITIVE=No is positive).
 */
export function amount(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const raw = String(v).trim();
  if (!raw) return 0;
  const isCr = /\bCr\b/i.test(raw);
  const isDr = /\bDr\b/i.test(raw);
  const stripped = raw.replace(/\b(Cr|Dr)\b/gi, "").replace(/,/g, "").trim();
  let num = Number(stripped);
  if (Number.isNaN(num)) return 0;
  if (isDr) num = -Math.abs(num);
  else if (isCr) num = Math.abs(num);
  return num;
}

/** Normalize an array-ish XML node so we can iterate safely. */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Render a tabular result as compact CSV — friendly for LLM consumption. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (cell: string | number): string => {
    const str = String(cell ?? "");
    if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
    return str;
  };
  const out = [headers.join(",")];
  for (const row of rows) {
    out.push(row.map(escape).join(","));
  }
  return out.join("\n");
}
