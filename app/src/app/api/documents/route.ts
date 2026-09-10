import { NextResponse } from "next/server";
import { resolveProject } from "@brain/auth";
import { getDb } from "@brain/db";
import { ingestDocument } from "@brain/ingest-docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Max per upload. Bigger than any PRD or hour-long transcript. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Upload a PRD or a meeting transcript.
 *
 * Plain text in, chunks out. Markdown, .txt, .vtt and .srt all work; the
 * shape is detected rather than declared, because people don't reliably know
 * which they have.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected a file upload" }, { status: 400 });

  const token = String(form.get("token") ?? "");
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 401 });

  const db = await getDb();
  const project = await resolveProject(token, "admin");
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no files were attached" }, { status: 400 });
  }

  const results = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      results.push({ filename: file.name, error: "larger than 2 MB" });
      continue;
    }
    try {
      const text = await file.text();
      if (!text.trim()) {
        results.push({ filename: file.name, error: "file is empty" });
        continue;
      }
      const result = await ingestDocument(project.id, { filename: file.name, text });
      results.push({ filename: file.name, ...result });
    } catch (error) {
      results.push({
        filename: file.name,
        error: error instanceof Error ? error.message : "could not read this file",
      });
    }
  }

  return NextResponse.json({ results });
}
