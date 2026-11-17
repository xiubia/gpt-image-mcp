import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPollUrl,
  editImage,
  generateImage,
  pollImageTask,
} from "../client.js";

const env = {
  MLGB7_API_KEY: "test-key",
  MLGB7_API_BASE_URL: "https://image.example/v1",
  MLGB7_TIMEOUT_MS: "5000",
};

test("generateImage defaults to GPT Image 2.5 and downloads the result", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-output-"));
  let providerRequest;
  let downloadRequest;
  try {
    const result = await generateImage(
      { prompt: "minimal product poster", n: 1, size: "auto" },
      {
        env: { ...env, GPT_IMAGE_OUTPUT_DIR: outputDir },
        fetchImpl: async (url, options) => {
          if (url === "https://image.example/v1/images/generations") {
            providerRequest = { url, options };
            return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/a.png" }] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          downloadRequest = { url, options };
          return new Response(Buffer.from("png-bytes"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    assert.deepEqual(result.data[0].url, "https://cdn.example/a.png");
    assert.equal(result.requested_model, "gpt-image-2.5");
    assert.equal(path.dirname(result.data[0].local_path), outputDir);
    assert.match(path.basename(result.data[0].local_path), /^gpt-image-.*\.png$/);
    assert.deepEqual(await fs.readFile(result.data[0].local_path), Buffer.from("png-bytes"));
    assert.equal(providerRequest.url, "https://image.example/v1/images/generations");
    assert.equal(downloadRequest.url, "https://cdn.example/a.png");
    assert.equal(downloadRequest.options.headers.Authorization, undefined);
    assert.equal(providerRequest.options.headers.Authorization, "Bearer test-key");
    assert.match(providerRequest.options.headers["User-Agent"], /^Mozilla\/5\.0 /);
    assert.equal(downloadRequest.options.headers["User-Agent"], providerRequest.options.headers["User-Agent"]);
    assert.deepEqual(JSON.parse(providerRequest.options.body), {
      model: "gpt-image-2.5",
      prompt: "minimal product poster",
      n: 1,
      size: "auto",
      response_format: "url",
    });
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("same-origin image URLs receive the API credential", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-auth-output-"));
  let imageRequest;
  try {
    await generateImage(
      { prompt: "same-origin image" },
      {
        env: { ...env, GPT_IMAGE_OUTPUT_DIR: outputDir },
        fetchImpl: async (url, options) => {
          if (url.endsWith("/images/generations")) {
            return new Response(JSON.stringify({ data: [{ url: "/generated.png" }] }), { status: 200 });
          }
          imageRequest = { url, options };
          return new Response(Buffer.from("same-origin-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
      },
    );
    assert.equal(imageRequest.url, "https://image.example/generated.png");
    assert.equal(imageRequest.options.headers.Authorization, "Bearer test-key");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("generateImage exposes a 504 task for polling", async () => {
  const result = await generateImage(
    { prompt: "queued image" },
    {
      env,
      fetchImpl: async () =>
        new Response(JSON.stringify({ task_id: "api_gen_123" }), { status: 504 }),
    },
  );

  assert.deepEqual(result, {
    status: "pending",
    http_status: 504,
    task_id: "api_gen_123",
    response: { task_id: "api_gen_123" },
    requested_model: "gpt-image-2.5",
  });
});

test("editImage sends a multipart reference image", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-test-"));
  const imagePath = path.join(tempDir, "reference.png");
  const outputDir = path.join(tempDir, "output");
  await fs.writeFile(imagePath, Buffer.from("png-bytes"));

  try {
    let providerRequest;
    await editImage(
      { image_path: imagePath, prompt: "make it a night scene" },
      {
        env: { ...env, GPT_IMAGE_OUTPUT_DIR: outputDir },
        fetchImpl: async (url, options) => {
          if (url === "https://image.example/v1/images/edits") {
            providerRequest = { url, options };
            return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/b.png" }] }), {
              status: 200,
            });
          }
          return new Response(Buffer.from("edited-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    assert.equal(providerRequest.url, "https://image.example/v1/images/edits");
    assert.equal(providerRequest.options.body.get("model"), "gpt-image-2.5");
    assert.equal(providerRequest.options.body.get("prompt"), "make it a night scene");
    assert.equal(providerRequest.options.body.get("image").name, "reference.png");
    assert.match(providerRequest.options.headers["User-Agent"], /^Mozilla\/5\.0 /);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("model selection honors explicit input, configured defaults and older model IDs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-model-test-"));
  const imagePath = path.join(tempDir, "reference.png");
  await fs.writeFile(imagePath, Buffer.from("png-bytes"));
  try {
    for (const operation of [generateImage, editImage]) {
      for (const [model, configuredModel, expected] of [
        [undefined, undefined, "gpt-image-2.5"],
        [undefined, "gpt-image-2.5-flare", "gpt-image-2.5-flare"],
        ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5"],
        ["gpt-image-2", undefined, "gpt-image-2"],
        [" gpt-image-future ", "gpt-image-2.5", "gpt-image-future"],
      ]) {
        let sentModel;
        const result = await operation({ prompt: "model selection", image_path: imagePath, model }, {
          env: { ...env, GPT_IMAGE_MODEL: configuredModel },
          fetchImpl: async (_url, options) => {
            sentModel = options.body instanceof FormData
              ? options.body.get("model") : JSON.parse(options.body).model;
            return new Response(JSON.stringify({ data: [] }));
          },
        });
        assert.equal(sentModel, expected);
        assert.equal(result.requested_model, expected);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("an empty explicit model fails before a request instead of changing models", async () => {
  for (const operation of [generateImage, editImage]) {
    let calls = 0;
    await assert.rejects(operation({ prompt: "invalid model", model: " ", image_path: "unused.png" }, {
      env,
      fetchImpl: async () => { calls++; return new Response("{}"); },
    }), /model must be a non-empty provider model ID/);
    assert.equal(calls, 0);
  }
});

test("pollImageTask queries the provider task endpoint", async () => {
  assert.equal(
    buildPollUrl("https://image.example/v1", ["api_gen_1", "api_gen_2"]),
    "https://image.example/api/image-tasks?ids=api_gen_1%2Capi_gen_2",
  );

  let request;
  await pollImageTask(
    { ids: ["api_gen_1"] },
    {
      env,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
      },
    },
  );

  assert.equal(request.url, "https://image.example/api/image-tasks?ids=api_gen_1");
  assert.equal(request.options.method, "GET");
  assert.match(request.options.headers["User-Agent"], /^Mozilla\/5\.0 /);
});

test("generateImage retries a 502 once with the same idempotency key and body", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ...options });
    return requests.length === 1
      ? new Response("Bad Gateway", { status: 502 })
      : new Response(JSON.stringify({ data: [] }), { status: 200 });
  };

  await generateImage({ prompt: "retry this image once" }, { env, fetchImpl });
  assert.equal(requests.length, 2);
  assert.ok(requests[0].headers["Idempotency-Key"]);
  assert.equal(requests[1].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"]);
  assert.equal(requests[1].body, requests[0].body);
  assert.equal(requests[1].url, requests[0].url);

  await generateImage({ prompt: "retry this image once" }, { env, fetchImpl });
  assert.notEqual(requests[2].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"]);
});

test("editImage retries a 502 with the same reference and idempotency key", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-edit-retry-"));
  const imagePath = path.join(tempDir, "reference.png");
  await fs.writeFile(imagePath, Buffer.from("reference-bytes"));
  const requests = [];
  try {
    await editImage(
      { image_path: imagePath, prompt: "edit once" },
      {
        env,
        fetchImpl: async (url, options) => {
          requests.push({ url, ...options });
          return new Response("{}", { status: requests.length === 1 ? 502 : 200 });
        },
      },
    );
    assert.equal(requests.length, 2);
    assert.ok(requests[0].headers["Idempotency-Key"]);
    assert.equal(requests[1].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"]);
    assert.equal(requests[1].body, requests[0].body);
    assert.equal(await requests[1].body.get("image").text(), "reference-bytes");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("a persistent 502 stops after one retry", async () => {
  let attempts = 0;
  await assert.rejects(
    generateImage({ prompt: "gateway failure" }, {
      env,
      fetchImpl: async () => {
        attempts++;
        return new Response("Bad Gateway", { status: 502 });
      },
    }),
    /HTTP 502/,
  );
  assert.equal(attempts, 2);
});

test("accepted or gateway responses with a task ID return pending without resubmission", async () => {
  for (const status of [202, 502, 504]) {
    let attempts = 0;
    const result = await generateImage({ prompt: "already submitted" }, {
      env,
      fetchImpl: async () => {
        attempts++;
        return new Response(JSON.stringify({ task_id: "existing-task" }), { status });
      },
    });
    assert.equal(attempts, 1);
    assert.equal(result.status, "pending");
    assert.equal(result.task_id, "existing-task");
    assert.equal(result.http_status, status);
  }
});

test("authentication errors, Cloudflare blocks and ambiguous network failures are not retried", async () => {
  for (const failure of [
    new Response("Unauthorized", { status: 401 }),
    new Response("Cloudflare error 1010", { status: 403 }),
    new TypeError("fetch failed"),
    new DOMException("This operation was aborted", "AbortError"),
  ]) {
    let attempts = 0;
    await assert.rejects(generateImage({ prompt: "do not resubmit" }, {
      env,
      fetchImpl: async () => {
        attempts++;
        if (failure instanceof Error) throw failure;
        return failure;
      },
    }));
    assert.equal(attempts, 1);
  }
});

test("a transient connect timeout retries once with the same idempotency key", async () => {
  let attempts = 0;
  let firstHeaders;
  let secondHeaders;
  const result = await generateImage({ prompt: "retry connect timeout" }, {
    env,
    fetchImpl: async (url, options) => {
      attempts++;
      if (attempts === 1) {
        firstHeaders = options.headers;
        const error = new TypeError("fetch failed");
        error.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
        throw error;
      }
      secondHeaders = options.headers;
      return new Response(JSON.stringify({ status: "accepted", task_id: "connect-retry" }), { status: 202 });
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.status, "pending");
  assert.equal(result.task_id, "connect-retry");
  assert.equal(secondHeaders["Idempotency-Key"], firstHeaders["Idempotency-Key"]);
});

test("pollImageTask retries a 502 without submitting another image", async () => {
  const urls = [];
  await pollImageTask({ ids: ["existing-task"] }, {
    env,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response("{}", { status: urls.length === 1 ? 502 : 200 });
    },
  });
  assert.deepEqual(urls, [
    "https://image.example/api/image-tasks?ids=existing-task",
    "https://image.example/api/image-tasks?ids=existing-task",
  ]);
});

test("the request timeout cancels the retry delay without resubmitting", async () => {
  let attempts = 0;
  await assert.rejects(generateImage({ prompt: "stop at the timeout" }, {
    env: { ...env, MLGB7_TIMEOUT_MS: "20" },
    fetchImpl: async () => {
      attempts++;
      return new Response("Bad Gateway", { status: 502 });
    },
  }), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("persistent download failures stop after one retry without regenerating", async () => {
  let generationCalls = 0;
  let downloadCalls = 0;
  await assert.rejects(generateImage({ prompt: "keep the existing image" }, {
    env,
    fetchImpl: async (url) => {
      if (url.endsWith("/images/generations")) {
        generationCalls++;
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/failed.png" }] }));
      }
      downloadCalls++;
      return new Response("Bad Gateway", { status: 502 });
    },
  }), /Image download failed with HTTP 502/);
  assert.equal(generationCalls, 1);
  assert.equal(downloadCalls, 2);
});

test("a download 502 retries the existing URL and never resubmits generation", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-download-retry-"));
  let generationCalls = 0;
  let downloadCalls = 0;
  try {
    const result = await generateImage({ prompt: "download once" }, {
      env: { ...env, GPT_IMAGE_OUTPUT_DIR: outputDir },
      fetchImpl: async (url, options) => {
        if (url.endsWith("/images/generations")) {
          generationCalls++;
          return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/retry.png" }] }));
        }
        downloadCalls++;
        assert.equal(url, "https://cdn.example/retry.png");
        assert.match(options.headers["User-Agent"], /^Mozilla\/5\.0 /);
        assert.equal(options.headers.Authorization, undefined);
        return downloadCalls === 1
          ? new Response("Bad Gateway", { status: 502 })
          : new Response("image-bytes", { headers: { "content-type": "image/png" } });
      },
    });
    assert.equal(generationCalls, 1);
    assert.equal(downloadCalls, 2);
    assert.equal(await fs.readFile(result.data[0].local_path, "utf8"), "image-bytes");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("pollImageTask downloads completed images", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-image-poll-output-"));
  try {
    const result = await pollImageTask(
      { ids: ["api_gen_1"] },
      {
        env: { ...env, GPT_IMAGE_OUTPUT_DIR: outputDir },
        fetchImpl: async (url) => {
          if (url.includes("/api/image-tasks")) {
            return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/c.png" }] }), { status: 200 });
          }
          return new Response(Buffer.from("polled-png"), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        },
      },
    );

    assert.equal(await fs.readFile(result.data[0].local_path, "utf8"), "polled-png");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});
