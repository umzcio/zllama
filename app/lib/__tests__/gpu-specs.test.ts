import { describe, it, expect } from "vitest";
import { lookupGpuSpecs } from "@/lib/gpu-specs";

describe("lookupGpuSpecs — fleet GPUs missing from the specs DB", () => {
  it("resolves 'NVIDIA GB10' to its unified-memory capacity and bandwidth", () => {
    // NVIDIA GB10 Grace Blackwell Superchip: unified LPDDR5x memory, same
    // silicon NVIDIA also ships DGX-branded (see "DGX Spark GB10 128GB"
    // below). ~128 GB usable, ~273 GB/s per NVIDIA's published GB10
    // Superchip datasheet.
    const specs = lookupGpuSpecs("NVIDIA GB10", 128);
    expect(specs).not.toBeNull();
    expect(specs!.vram).toBeGreaterThanOrEqual(96);
    expect(specs!.vram).toBeLessThanOrEqual(144);
    expect(specs!.bw).toBeGreaterThanOrEqual(200);
    expect(specs!.bw).toBeLessThanOrEqual(350);
  });

  it("resolves the full nvidia-smi name for the RTX PRO 6000 Blackwell Max-Q", () => {
    // NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition: 96 GB GDDR7
    // on a 512-bit bus, ~1792 GB/s per NVIDIA's published product specs.
    const specs = lookupGpuSpecs(
      "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
      96
    );
    expect(specs).not.toBeNull();
    expect(specs!.vram).toBeGreaterThanOrEqual(80);
    expect(specs!.vram).toBeLessThanOrEqual(100);
    expect(specs!.bw).toBeGreaterThanOrEqual(1500);
    expect(specs!.bw).toBeLessThanOrEqual(2100);
  });
});
