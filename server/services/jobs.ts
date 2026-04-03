import crypto from "crypto";
import { getDb } from "../db";
import { listMigrationSessions } from "./migration";

type JobStatus = "pending" | "running" | "completed" | "failed" | "rolled_back" | "blocked";

type CreateJobInput = {
  kind: string;
  sourceEnvironmentId?: string | null;
  targetEnvironmentId?: string | null;
  status?: JobStatus;
  metadata?: Record<string, unknown>;
};

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createJob(input: CreateJobInput) {
  const db = getDb();
  const id = crypto.randomUUID();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, kind, source_environment_id, target_environment_id, status, metadata_json, created_at, updated_at)
     VALUES (@id, @kind, @sourceEnvironmentId, @targetEnvironmentId, @status, @metadataJson, @createdAt, @updatedAt)`
  ).run({
    id,
    kind: input.kind,
    sourceEnvironmentId: input.sourceEnvironmentId || null,
    targetEnvironmentId: input.targetEnvironmentId || null,
    status: input.status || "pending",
    metadataJson: JSON.stringify(input.metadata || {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return id;
}

export function appendJobEvent(jobId: string, level: "info" | "warning" | "error", phase: string | null, message: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO job_events_index (id, job_id, level, phase, message, created_at)
     VALUES (@id, @jobId, @level, @phase, @message, @createdAt)`
  ).run({
    id: crypto.randomUUID(),
    jobId,
    level,
    phase,
    message,
    createdAt: nowIso(),
  });
}

export function updateJob(jobId: string, status: JobStatus, metadata?: Record<string, unknown>) {
  const db = getDb();
  db.prepare(
    `UPDATE jobs
     SET status = @status,
         metadata_json = CASE
           WHEN @metadataJson IS NULL THEN metadata_json
           ELSE @metadataJson
         END,
         updated_at = @updatedAt
     WHERE id = @id`
  ).run({
    id: jobId,
    status,
    metadataJson: metadata ? JSON.stringify(metadata) : null,
    updatedAt: nowIso(),
  });
}

export function listJobs(serverId?: string) {
  const db = getDb();
  const rows = (serverId
    ? db
        .prepare(
          `SELECT * FROM jobs
           WHERE source_environment_id = @serverId
              OR target_environment_id = @serverId
              OR (source_environment_id IS NULL AND target_environment_id IS NULL)
           ORDER BY updated_at DESC`
        )
        .all({ serverId })
    : db.prepare("SELECT * FROM jobs ORDER BY updated_at DESC").all()) as Array<{
    id: string;
    kind: string;
    source_environment_id: string | null;
    target_environment_id: string | null;
    status: JobStatus;
    metadata_json: string;
    created_at: string;
    updated_at: string;
  }>;

  const persistedJobs = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    sourceServerId: row.source_environment_id,
    targetServerId: row.target_environment_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    source: "job" as const,
  }));

  const migrationJobs = listMigrationSessions(serverId).map((session) => ({
    id: `migration:${session.id}`,
    kind: "migration",
    sourceServerId: session.sourceEnvironmentId,
    targetServerId: session.targetEnvironmentId,
    status:
      session.status === "completed"
        ? ("completed" as JobStatus)
        : session.status === "rolled_back"
          ? ("rolled_back" as JobStatus)
          : session.status === "blocked"
            ? ("blocked" as JobStatus)
            : session.status === "failed"
              ? ("failed" as JobStatus)
              : ("running" as JobStatus),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: {
      sessionId: session.id,
      projectName: session.projectName,
      currentPhase: session.currentPhase,
      progress: session.progress.percent,
      message: session.result.message,
    },
    source: "migration" as const,
  }));

  return [...migrationJobs, ...persistedJobs].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
