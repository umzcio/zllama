// Model compatibility scoring — same methodology as canirun.ai.
// Reference: https://www.canirun.ai/why
//
// Core formula:
//   tokensPerSec ≈ bandwidth (GB/s) / modelSize (GB) * EFFICIENCY
//
// LLM token generation is almost purely memory-bandwidth-bound: each token
// requires reading the full model weights once from VRAM. The efficiency
// factor accounts for bus overhead, KV-cache reads, and other memory ops.

const EFFICIENCY = 0.85;

export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export interface ModelScore {
  tps: number;       // estimated tokens / second (0 if model doesn't fit)
  memPct: number;    // model size as % of GPU VRAM
  fits: boolean;     // whether the model fits in VRAM
  grade: Grade;
  hasBandwidth: boolean; // false when GPU isn't in the database
}

export function scoreModel(
  sizeGB: number,
  gpuVramGB: number,
  bandwidthGBs: number | undefined
): ModelScore {
  const fits = sizeGB <= gpuVramGB;
  const memPct = gpuVramGB > 0 ? Math.min((sizeGB / gpuVramGB) * 100, 999) : 0;
  const hasBandwidth = bandwidthGBs != null && bandwidthGBs > 0;

  if (!fits || !hasBandwidth) {
    return {
      tps: 0,
      memPct,
      fits,
      grade: fits ? "C" : "F", // fits but no bw data → neutral C
      hasBandwidth,
    };
  }

  const tps = (bandwidthGBs * EFFICIENCY) / sizeGB;
  return { tps, memPct, fits, grade: getGrade(tps), hasBandwidth };
}

function getGrade(tps: number): Grade {
  if (tps >= 50) return "S";
  if (tps >= 30) return "A";
  if (tps >= 15) return "B";
  if (tps >= 8)  return "C";
  if (tps >= 3)  return "D";
  return "F";
}

// Theme-aware grade colours via CSS tokens (defined in globals.css for both
// modes; every value passes WCAG AA against page, card, and tinted badges).
export function gradeColor(grade: Grade): string {
  return `hsl(var(--grade-${grade.toLowerCase()}))`;
}

// Background colour at low opacity for grade badges.
export function gradeBg(grade: Grade): string {
  return `hsl(var(--grade-${grade.toLowerCase()}) / 0.15)`;
}
