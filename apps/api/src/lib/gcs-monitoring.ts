import { config } from "../config";
import { storage } from "./gcs-jobs";

type MonitorDiffArtifactBase = {
  url: string;
  previousScrapeId: string | null;
  currentScrapeId: string | null;
  generatedAt: string;
};

export type MonitorDiffArtifact =
  | (MonitorDiffArtifactBase & {
      kind: "markdown";
      text: string;
      json: unknown;
    })
  | (MonitorDiffArtifactBase & {
      kind: "json";
      /** Per-field {previous, current} diff. */
      json: Record<string, { previous: unknown; current: unknown }>;
      /** Full current JSON extraction (the snapshot at this run). */
      snapshot: Record<string, unknown>;
      /**
       * Optional markdown diff sidecar. Populated only when the monitor's
       * formats requested both `"json"` and `"git-diff"` change-tracking
       * modes — in that case we run both diffs and report `changed` if
       * either path saw a change.
       */
      markdown?: {
        text: string;
        json: unknown;
      };
    });

const contentType = "application/json";

export function monitorDiffGcsKey(params: {
  teamId: string;
  monitorId: string;
  checkId: string;
  pageId: string;
}): string {
  return `monitors/${params.teamId}/${params.monitorId}/${params.checkId}/${params.pageId}.diff.json`;
}

function artifactBytes(artifact: MonitorDiffArtifact): {
  textBytes: number;
  jsonBytes: number;
} {
  const jsonBytes = Buffer.byteLength(JSON.stringify(artifact.json ?? null));
  let textBytes = 0;
  if (artifact.kind === "markdown") {
    textBytes = Buffer.byteLength(artifact.text);
  } else if (artifact.kind === "json" && artifact.markdown) {
    // Sidecar markdown diff (mixed-mode monitor) — count it so storage
    // accounting stays honest.
    textBytes = Buffer.byteLength(artifact.markdown.text);
  }
  return { textBytes, jsonBytes };
}

export async function saveMonitorDiffArtifact(
  key: string,
  artifact: MonitorDiffArtifact,
): Promise<{ textBytes: number; jsonBytes: number }> {
  const payload = JSON.stringify(artifact);
  if (!config.GCS_BUCKET_NAME) {
    return artifactBytes(artifact);
  }

  const bucket = storage.bucket(config.GCS_BUCKET_NAME);
  await bucket.file(key).save(payload, {
    contentType,
    resumable: false,
  });

  return artifactBytes(artifact);
}

export async function getMonitorDiffArtifact(
  key: string | null | undefined,
): Promise<MonitorDiffArtifact | null> {
  if (!key || !config.GCS_BUCKET_NAME) return null;

  const bucket = storage.bucket(config.GCS_BUCKET_NAME);
  try {
    const [contents] = await bucket.file(key).download();
    const parsed = JSON.parse(
      contents.toString(),
    ) as Partial<MonitorDiffArtifact>;
    // Backwards compat: historical artifacts predate the `kind` field and
    // are always markdown.
    if (!parsed.kind) {
      return { ...(parsed as any), kind: "markdown" } as MonitorDiffArtifact;
    }
    return parsed as MonitorDiffArtifact;
  } catch (error) {
    const maybeGcsError = error as { code?: number; statusCode?: number };
    if (maybeGcsError.code === 404 || maybeGcsError.statusCode === 404) {
      return null;
    }
    throw error;
  }
}
