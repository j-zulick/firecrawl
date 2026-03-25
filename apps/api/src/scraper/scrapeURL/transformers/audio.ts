import { Meta } from "..";
import { Document } from "../../../controllers/v2/types";
import { config } from "../../../config";
import { hasFormatOfType } from "../../../lib/format-utils";

export async function fetchAudio(
  meta: Meta,
  document: Document,
): Promise<Document> {
  if (!hasFormatOfType(meta.options.formats, "audio")) {
    return document;
  }

  if (!config.AVGRAB_SERVICE_URL) {
    meta.logger.warn("AVGRAB_SERVICE_URL is not configured");
    document.warning =
      "Audio format is not available (service not configured)." +
      (document.warning ? " " + document.warning : "");
    return document;
  }

  const response = await fetch(`${config.AVGRAB_SERVICE_URL}/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: meta.url }),
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "Unknown error" }));
    throw new Error(`Audio download failed: ${error.detail}`);
  }

  const data = await response.json().catch(() => null);

  if (!data || !data.public_url || typeof data.public_url !== "string") {
    throw new Error(
      "Audio download failed: avgrab service returned an invalid response (missing public_url)",
    );
  }

  document.audio = data.public_url;
  return document;
}
