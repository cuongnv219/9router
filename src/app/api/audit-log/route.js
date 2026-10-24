import { NextResponse } from "next/server";
import { getAdminAuditLog } from "@/lib/db/index.js";

export const dynamic = "force-dynamic";

// GET /api/audit-log?page=&pageSize= - admin actions on API keys
export async function GET(request) {
  try {
    const sp = new URL(request.url).searchParams;
    const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || 50));
    const page = Math.max(1, Number(sp.get("page")) || 1);
    const entries = await getAdminAuditLog({ limit: pageSize, offset: (page - 1) * pageSize });
    return NextResponse.json({ entries, page, pageSize });
  } catch (error) {
    console.log("Error fetching audit log:", error);
    return NextResponse.json({ error: "Failed to fetch audit log" }, { status: 500 });
  }
}
