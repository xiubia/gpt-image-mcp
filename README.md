# GPT Image MCP

Generate and edit images through `https://image.mlgb7.com/v1`, with a local
stdio MCP server and a companion [GPT Image skill](skills/gpt-image/SKILL.md).
The server and tool names are independent of the selected model version.

- `gpt_image_generate` for text-to-image generation.
- `gpt_image_edit` for editing an absolute local reference-image path.
- `gpt_image_poll` for pending generation or edit tasks with a task ID.

The default model is **`gpt-image-2.5`**. Generation and editing accept an
optional `model`; selection order is the request's `model`, `GPT_IMAGE_MODEL`,
then the default. Model IDs are passed through to the provider, which decides
whether they are supported. A failed request reports the error without
silently changing models or providers.

## Install the MCP server

Use Node.js 20 or newer and npm.

```sh
git clone https://github.com/xiubia/gpt-image-mcp.git
cd gpt-image-mcp
npm ci
```

Set `MLGB7_API_KEY` in the MCP process environment. For a persistent Windows
user environment variable, use PowerShell and restart the MCP client:

```powershell
[Environment]::SetEnvironmentVariable("MLGB7_API_KEY", "<your-api-key>", "User")
```

On macOS or Linux, launch the MCP client from a shell with the key exported:

```sh
export MLGB7_API_KEY="<your-api-key>"
```

The server reads the key from its environment. It does not load `.env` files.

For Codex, add the following to `~/.codex/config.toml`. Replace the example
path with the absolute path to this checkout, then reconnect the MCP client:

```toml
[mcp_servers.gpt-image]
command = "node"
args = ["/absolute/path/to/gpt-image-mcp/index.js"]
startup_timeout_sec = 30.0
tool_timeout_sec = 300.0
```

On Windows, an argument such as `"C:/path/to/gpt-image-mcp/index.js"` works.
Clients that do not inherit the shell environment can supply `MLGB7_API_KEY`
through their local MCP environment settings.

For other MCP clients, use this stdio registration with the same absolute
path and process environment:

```json
{
  "mcpServers": {
    "gpt-image": {
      "command": "node",
      "args": ["/absolute/path/to/gpt-image-mcp/index.js"]
    }
  }
}
```

## Install the companion skill

Copy the complete [`skills/gpt-image`](skills/gpt-image) directory into your
client's skill directory. For Codex, use `$CODEX_HOME/skills/gpt-image`, or
`~/.codex/skills/gpt-image` when `CODEX_HOME` is unset. On Windows, for example,
run this from the checkout:

```powershell
Copy-Item -LiteralPath .\skills\gpt-image -Destination "$env:USERPROFILE\.codex\skills\gpt-image" -Recurse
```

The repository also includes an importable [`gpt-image.skill`](gpt-image.skill)
archive. The skill routes image requests to this MCP; the server must be
configured separately. Invoke it with `$gpt-image`, or ask for an image and
allow the client to select the skill automatically.

## Generate, edit and poll

Call `gpt_image_generate`:

```json
{"prompt":"A small jade-green ceramic robot on an ivory background","model":"gpt-image-2.5","n":1,"size":"auto"}
```

Call `gpt_image_edit` with an absolute local reference path:

```json
{"image_path":"/absolute/path/to/reference.png","prompt":"Make the scene a warm sunset, preserving the subject","n":1}
```

Defaults are `n: 1`, `size: "auto"` and `response_format: "url"`. Requests can
set an optional provider `quality` value; `n` accepts values from 1 to 4.

When a response includes `status: "pending"` and a `task_id`, call
`gpt_image_poll` with the same ID:

```json
{"ids":["<returned-task-id>"]}
```

Do not resubmit generation to check progress. If a pending response contains
no task ID, report that result instead of creating another generation.

Completed images are saved locally. Each `data` item keeps the provider's
`url` and adds an absolute `local_path` for opening or displaying the image.
Generation and edit responses also include `requested_model`, recording the
model sent to the provider.

## Configuration

- `GPT_IMAGE_MODEL` changes the default model from `gpt-image-2.5`.
- `MLGB7_API_BASE_URL` defaults to `https://image.mlgb7.com/v1`.
  A different endpoint must support the same generation, edit and task APIs.
- `MLGB7_TIMEOUT_MS` defaults to `120000`.
- `GPT_IMAGE_OUTPUT_DIR` controls where generated images are saved. It defaults
  to `~/Documents/Codex/gpt-image`.
  The existing `MLGB7_OUTPUT_DIR` alias remains supported.

## Network handling

API requests, task polls and image downloads send a browser User-Agent to
avoid the provider's Cloudflare 1010 rejection of default client signatures.
An HTTP 502 response is retried at most once after one second, within the
existing request timeout. Generation and edit retries reuse the same request
body and `Idempotency-Key`; each new tool invocation gets a new key. The
provider documents this header for deduplicating retries of the same task.

Responses with a task ID and HTTP 202, 502 or 504 return `status: pending` for
polling instead of resubmitting generation. A failed image download retries
only that image URL, never the generation request. Authentication errors,
Cloudflare blocks, ambiguous network failures and timeouts are not retried.
Recognized transient connection failures retry once with the same request and
idempotency key.
Do not blindly repeat a tool invocation after an ambiguous failure, since a
new invocation uses a new idempotency key.

## Run the tests

```sh
npm test
```

Tests use simulated provider responses and a local stdio MCP connection;
they require no real API key and do not submit billable image requests.
