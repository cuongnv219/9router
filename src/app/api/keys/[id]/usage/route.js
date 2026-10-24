import { NextResponse } from "next/server";
import { getApiKeyById, getBudgetDays, getKeyReservations, getKeyModelBreakdown, budgetDay } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/keys/[id]/usage?day=YYYY-MM-DD&from=&to=&page=&pageSize=
// Daily spend history plus the per-request ledger (time, model, provider, cost).
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) return NextResponse.json({ error: "Key not found" }, { status: 404 });

    const sp = new URL(request.url).searchParams;
    const day = sp.get("day") || budgetDay();
    const from = sp.get("from");
    const to = sp.get("to");
    for (const v of [day, from, to]) {
      if (v && !DAY_RE.test(v)) return NextResponse.json({ error: "Dates must be YYYY-MM-DD" }, { status: 400 });
    }
    const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || 50));
    const page = Math.max(1, Number(sp.get("page")) || 1);

    const [days, requests, byModel] = await Promise.all([
      getBudgetDays(id, { from, to }),
      getKeyReservations(id, { day, limit: pageSize, offset: (page - 1) * pageSize }),
      getKeyModelBreakdown(id, day),
    ]);

    return NextResponse.json({
      key: { id: key.id, name: key.name, isActive: key.isActive, dailyBudgetUsd: key.dailyBudgetUsd },
      day, days, requests, page, pageSize, byModel,
    });
  } catch (error) {
    console.log("Error fetching key usage:", error);
    return NextResponse.json({ error: "Failed to fetch key usage" }, { status: 500 });
  }
}
