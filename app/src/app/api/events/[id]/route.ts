import { NextResponse } from "next/server";
import { getDb } from "@brain/db";
import { eventsExist, readEventStream } from "@brain/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a session's events back for playback.
 *
 * Guarded by the project's view token rather than being public — a session id
 * on its own must not be enough to read a recording, or anyone who ever saw
 * one in a URL could replay it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = new URL(request.url).searchParams.get("t");
  if (!token) {
    return NextResponse.json({ error: "missing token" }, { status: 401 });
  }

  const db = await getDb();
  const session = await db.one<{ id: string }>(
    `SELECT s.id FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND (p.view_token = $2 OR p.admin_token = $2)`,
    [id, token],
  );
  if (!session) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (!(await eventsExist(id))) {
    return NextResponse.json({ error: "no events yet" }, { status: 404 });
  }

  const nodeStream = readEventStream(id);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk) =>
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        ),
      );
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "private, max-age=300",
    },
  });
}
