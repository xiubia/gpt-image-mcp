import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_BASE_URL = "https://image.mlgb7.com/v1";
export const DEFAULT_MODEL = "gpt-image-2.5";
export const DEFAULT_TIMEOUT_MS = 120_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RETRY_DELAY_MS = 1_000;
const TRANSIENT_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
]);
export const DEFAULT_OUTPUT_DIR = path.join(
  os.homedir(),
  "Documents",
  "Codex",
  "gpt-image",
);

export function getConfig(env = process.env) {
  const apiKey = env.MLGB7_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("MLGB7_API_KEY is not configured for the gpt-image MCP server.");
  }

  return {
    apiKey,
    model: env.GPT_IMAGE_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: (env.MLGB7_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    timeoutMs: Number(env.MLGB7_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    outputDir: path.resolve(
      env.GPT_IMAGE_OUTPUT_DIR || env.MLGB7_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    ),
  };
}

function requireFetch(fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("This MCP server requires a runtime with global fetch support.");
  }
  return fetchFn;
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  }[extension] || "application/octet-stream";
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function findTaskId(value) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.task_id === "string") return value.task_id;
  if (typeof value.taskId === "string") return value.taskId;
  for (const child of Object.values(value)) {
    const nested = findTaskId(child);
    if (nested) return nested;
  }
  return undefined;
}

function errorMessage(payload, status) {
  if (typeof payload === "string") return payload;
  return (
    payload?.error?.message ||
    payload?.message ||
    payload?.error ||
    `Image API request failed with HTTP ${status}.`
  );
}

function isTransientNetworkError(error) {
  return error instanceof TypeError
    && error.message === "fetch failed"
    && TRANSIENT_NETWORK_CODES.has(error.cause?.code);
}

async function request(pathname, options, { env, fetchImpl } = {}) {
  const config = getConfig(env);
  const fetchFn = requireFetch(fetchImpl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${config.apiKey}`,
    ...(options.headers || {}),
  };
  // The provider deduplicates retries of a submission by Idempotency-Key.
  if (options.method === "POST") headers["Idempotency-Key"] = randomUUID();

  try {
    const targetUrl = pathname.startsWith("http") ? pathname : `${config.baseUrl}${pathname}`;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchFn(targetUrl, {
          ...options,
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        if (isTransientNetworkError(error) && attempt === 0) {
          await delay(RETRY_DELAY_MS, undefined, { signal: controller.signal });
          continue;
        }
        if (error instanceof TypeError && error.message === "fetch failed") {
          const code = error.cause?.code ? ` (${error.cause.code})` : "";
          throw new Error(`Image API request fetch failed for ${new URL(targetUrl).origin}${code}.`, { cause: error });
        }
        throw error;
      }
      const payload = await readResponse(response);
      const taskId = findTaskId(payload);

      if (response.status === 504 || (taskId && [202, 502].includes(response.status))) {
        return {
          status: "pending",
          http_status: response.status,
          task_id: taskId,
          response: payload,
        };
      }

      if (response.status === 502 && attempt === 0) {
        await delay(RETRY_DELAY_MS, undefined, { signal: controller.signal });
        continue;
      }

      if (!response.ok) {
        throw new Error(errorMessage(payload, response.status));
      }

      return payload;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function extensionForImage(contentType, imageUrl) {
  const normalizedType = contentType.split(";", 1)[0].trim().toLowerCase();
  const typeExtensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  if (typeExtensions[normalizedType]) return typeExtensions[normalizedType];

  const extension = path.extname(new URL(imageUrl).pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension)
    ? extension
    : ".png";
}

async function downloadImage(imageUrl, options = {}) {
  const config = getConfig(options.env);
  const fetchFn = requireFetch(options.fetchImpl);
  const resolvedUrl = new URL(imageUrl, config.baseUrl).toString();
  const baseOrigin = new URL(config.baseUrl).origin;
  const imageOrigin = new URL(resolvedUrl).origin;
  const headers = { Accept: "image/*", "User-Agent": USER_AGENT };
  // Provider responses may use a relative or same-origin URL that still needs
  // the API credential. Never send the credential to an unrelated CDN host.
  if (imageOrigin === baseOrigin) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const requestOptions = {
      method: "GET",
      headers,
      signal: controller.signal,
    };
    let response;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetchFn(resolvedUrl, requestOptions);
        break;
      } catch (error) {
        if (isTransientNetworkError(error) && attempt === 0) {
          await delay(RETRY_DELAY_MS, undefined, { signal: controller.signal });
          continue;
        }
        if (error instanceof TypeError && error.message === "fetch failed") {
          const code = error.cause?.code ? ` (${error.cause.code})` : "";
          throw new Error(`Image download fetch failed for ${new URL(resolvedUrl).origin}${code}.`, { cause: error });
        }
        throw error;
      }
    }
    if (response.status === 502) {
      await response.body?.cancel();
      await delay(RETRY_DELAY_MS, undefined, { signal: controller.signal });
      response = await fetchFn(resolvedUrl, requestOptions);
    }
    if (!response.ok) {
      throw new Error(`Image download failed with HTTP ${response.status}.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Image download returned an empty file.");

    await fs.mkdir(config.outputDir, { recursive: true });
    const contentType = response.headers.get("content-type") || "";
    const fileName = `gpt-image-${Date.now()}-${randomUUID().slice(0, 8)}${extensionForImage(contentType, resolvedUrl)}`;
    const localPath = path.join(config.outputDir, fileName);
    await fs.writeFile(localPath, bytes);
    return localPath;
  } catch (error) {
    if (error instanceof TypeError && error.message === "fetch failed") {
      throw new Error(`Image download fetch failed for ${new URL(resolvedUrl).origin}.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadGeneratedImages(result, options = {}) {
  if (!result || result.status === "pending" || !Array.isArray(result.data)) {
    return result;
  }

  const data = await Promise.all(
    result.data.map(async (item) => {
      if (!item || typeof item.url !== "string" || !item.url.trim()) return item;
      return {
        ...item,
        local_path: await downloadImage(item.url, options),
      };
    }),
  );

  return { ...result, data };
}

function imageRequestBody(input, model) {
  const body = {
    model,
    prompt: input.prompt,
    n: input.n ?? 1,
    size: input.size ?? "auto",
    response_format: input.response_format ?? "url",
  };
  if (input.quality !== undefined) body.quality = input.quality;
  return body;
}

function resolveModel(input, config) {
  const model = input.model ?? config.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("model must be a non-empty provider model ID.");
  }
  return model.trim();
}

export async function generateImage(input, options = {}) {
  if (!input?.prompt?.trim()) throw new Error("prompt is required.");
  const model = resolveModel(input, getConfig(options.env));
  const result = await request(
    "/images/generations",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(imageRequestBody(input, model)),
    },
    options,
  );
  return downloadGeneratedImages({ ...result, requested_model: model }, options);
}

export async function editImage(input, options = {}) {
  if (!input?.prompt?.trim()) throw new Error("prompt is required.");
  if (!input?.image_path?.trim()) throw new Error("image_path is required.");

  const config = getConfig(options.env);
  const model = resolveModel(input, config);
  const bytes = await fs.readFile(input.image_path);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", input.prompt);
  form.append("n", String(input.n ?? 1));
  form.append("size", input.size ?? "auto");
  form.append("response_format", input.response_format ?? "url");
  if (input.quality !== undefined) form.append("quality", input.quality);
  form.append(
    "image",
    new Blob([bytes], { type: contentTypeFor(input.image_path) }),
    path.basename(input.image_path),
  );

  const result = await request(
    "/images/edits",
    { method: "POST", body: form },
    options,
  );
  return downloadGeneratedImages({ ...result, requested_model: model }, options);
}

export function buildPollUrl(baseUrl, ids) {
  const url = new URL(`${baseUrl}/`);
  const rootPath = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${rootPath}/api/image-tasks`;
  url.search = "";
  url.searchParams.set("ids", ids.join(","));
  return url.toString();
}

export async function pollImageTask(input, options = {}) {
  if (!Array.isArray(input?.ids) || input.ids.length === 0) {
    throw new Error("ids must contain at least one task ID.");
  }

  const config = getConfig(options.env);
  const result = await request(
    buildPollUrl(config.baseUrl, input.ids),
    { method: "GET" },
    options,
  );
  return downloadGeneratedImages(result, options);
}
