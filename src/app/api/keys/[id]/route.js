import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { logAdminAction } from "@/lib/db/index.js";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";
import { parseDailyBudget } from "@/shared/utils/budget.js";

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access, name, dailyBudgetUsd } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) {
      if (typeof isActive !== "boolean") return NextResponse.json({ error: "isActive must be a boolean" }, { status: 400 });
      updateData.isActive = isActive;
    }
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.access = checked.value;
    }
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim() || name.length > 100) {
        return NextResponse.json({ error: "name must be a non-empty string (max 100 chars)" }, { status: 400 });
      }
      updateData.name = name.trim();
    }
    if (dailyBudgetUsd !== undefined) {
      const checked = parseDailyBudget(dailyBudgetUsd);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      updateData.dailyBudgetUsd = checked.value;
    }

    const updated = await updateApiKey(id, updateData);
    await logAdminAction("key.update", id, {
      before: { name: existing.name, isActive: existing.isActive, dailyBudgetUsd: existing.dailyBudgetUsd, access: existing.access },
      after: updateData,
    });

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const existing = await getApiKeyById(id);
    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    // Budget ledger rows are kept: they are the key's spend history.
    await logAdminAction("key.delete", id, { name: existing?.name });

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
