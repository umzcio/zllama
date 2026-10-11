export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/require-admin";
import { scrapeAllModels, searchCatalog, type EngineKind } from "@/lib/catalogs";

function isEngineKind(value: string | null): value is EngineKind {
  return value === "ollama" || value === "vllm";
}

export async function GET(req: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const search = req.nextUrl.searchParams.get("q")?.toLowerCase() || "";
  const capabilities = req.nextUrl.searchParams.get("c")?.toLowerCase() || "";
  const capList = capabilities ? capabilities.split(",").filter(Boolean) : [];
  const engineParam = req.nextUrl.searchParams.get("engine");

  // A non-ollama engine (currently just vLLM/HuggingFace) has no
  // capability tags, size tags, or pull counts the way the ollama.com
  // scrape does — it returns the thin, engine-agnostic CatalogEntry shape
  // instead of the rich ScrapedModel shape the existing ollama browsing UI
  // depends on.
  if (isEngineKind(engineParam) && engineParam !== "ollama") {
    try {
      const entries = await searchCatalog(engineParam, search);
      return NextResponse.json(entries);
    } catch {
      return NextResponse.json(
        { error: "Failed to fetch models from the catalog" },
        { status: 502 }
      );
    }
  }

  try {
    let models = await scrapeAllModels();

    if (search) {
      models = models.filter(
        (m) => m.name.toLowerCase().includes(search) || m.description.toLowerCase().includes(search)
      );
    }

    if (capList.length > 0) {
      models = models.filter((m) => capList.every((c) => m.capabilities.includes(c)));
    }

    return NextResponse.json(models);
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch models from ollama.com" },
      { status: 502 }
    );
  }
}
