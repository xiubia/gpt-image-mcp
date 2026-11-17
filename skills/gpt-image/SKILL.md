---
name: gpt-image
description: >
  Route every user request to generate, create, edit, transform, iterate on, or
  produce an image through the configured GPT Image MCP server. Trigger for
  Chinese or English requests involving images, posters, illustrations, icons,
  product renders, concept art, image variations, reference-image edits, or
  prompts such as 生图、生成图片、画图、出图、改图、以图生图、海报、插画、头像、
  产品图 and similar wording, even when the user does not mention an MCP. Use
  this skill whenever an image result is requested, using the requested or
  configured GPT image model. If the configured MCP fails, report the failure
  without silently switching models, providers, or image tools.
metadata:
  requirements: "Requires the local gpt-image MCP server and MLGB7_API_KEY in the MCP process environment."
---

# GPT Image

## Routing rule

All image generation and image editing must go through the MCP server named
`gpt-image` and its tools:

- `gpt_image_generate` for text-to-image requests.
- `gpt_image_edit` for requests with a local reference image.
- `gpt_image_poll` when a generation or edit returns a provider task ID
  with HTTP 202, 502, or 504.

Do not call a built-in image-generation capability, another MCP, another
provider, or a direct HTTP request as a substitute. The server is deliberately
the single image route for this skill. If the server is unavailable, the API
key is missing, or the provider fails, stop and tell the user what failed; do
not silently fall back.

## Request defaults

- Generation and editing accept an optional `model`. Use the model the user
  requests; otherwise omit it to use the configured default. The server selects
  the request's `model`, then `GPT_IMAGE_MODEL`, then `gpt-image-2.5`.
- Model IDs are not fixed to one version. For example, pass
  `model: "gpt-image-2.5"` or `model: "gpt-image-2.5-flare"` when requested.
  Use exact provider model IDs and report unsupported-model errors without
  silently downgrading or switching providers.
- Default `n` to `1`, `size` to `auto`, and `response_format` to `url` unless
  the user gives a supported value.
- Keep the user's visual intent intact. Clarify only genuinely missing details;
  do not replace the requested image with a code-generated SVG, HTML mockup, or
  unrelated stock asset.
- For edits, pass the absolute local reference-image path in `image_path` and
  keep the edit instruction in `prompt`.
- The MCP automatically downloads every completed provider image to a local
  directory. Read `data[].local_path` from the result and use that absolute
  path when showing the image in Codex. The default directory is
  `%USERPROFILE%/Documents/Codex/gpt-image`; it can be changed with
  `GPT_IMAGE_OUTPUT_DIR`.
- If the tool returns `status: pending` and a `task_id`, call the polling tool
  with `ids: [task_id]`. After completion, use the returned `data[].local_path`;
  report the provider error if polling fails. A pending response without a task
  ID cannot be polled; report it without submitting a duplicate generation.
- The MCP sends a browser User-Agent to the provider. It retries one HTTP 502
  with the same idempotency key and request body; if a task ID is already
  returned, poll that task instead of submitting the image again.

For a specific model, a generation call can be as small as:

```json
{"prompt":"A small jade-green ceramic robot on an ivory background","model":"gpt-image-2.5","n":1}
```

## Output

After a successful call, show the generated image with Markdown using the
absolute local path from `data[].local_path`, and briefly state which operation
completed. Use `requested_model` to identify the model sent in the request;
do not infer a successful generation from a model listing or a pending task.
The provider URL may be included as a secondary reference, but must
not be the only image output. Never reveal `MLGB7_API_KEY` or place it in
prompts, files, logs, or the response.
