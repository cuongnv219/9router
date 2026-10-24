import { NextResponse } from "next/server";
import { getApiKeys, createApiKey } from "@/lib/localDb";
import { getBudgetDay, budgetDay, logAdminAction } from "@/lib/db/index.js";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { parseDailyBudget } from "@/shared/utils/budget.js";

export const dynamic = "force-dynamic";

// GET /api/keys - List API keys (with today's budget state for limited keys)
export async function GET() {
  try {
    const day = budgetDay();
    const keys = await Promise.all((await getApiKeys()).map(async (k) => {
      if (k.dailyBudgetUsd == null) return k;
      const d = await getBudgetDay(k.id, day);
      return { ...k, budget: { day, spentUsd: d.spentUsd, reservedUsd: d.reservedUsd, requests: d.requests, remainingUsd: Math.max(0, k.dailyBudgetUsd - d.spentUsd - d.reservedUsd) } };
    }));
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
export async function POST(request) {
  try {
    const body = await request.json();
    const { name, dailyBudgetUsd } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    const budget = parseDailyBudget(dailyBudgetUsd ?? null);
    if (!budget.ok) return NextResponse.json({ error: budget.error }, { status: 400 });

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name, machineId, budget.value);
    await logAdminAction("key.create", apiKey.id, { name, dailyBudgetUsd: budget.value });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
