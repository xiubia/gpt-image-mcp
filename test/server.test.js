import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio exposes the generic tools, optional model and actionable configuration errors", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    env: { ...process.env, MLGB7_API_KEY: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "gpt-image-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, "gpt-image");
    assert.match(client.getInstructions(), /optional model parameter/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [
      "gpt_image_generate", "gpt_image_edit", "gpt_image_poll",
    ]);
    for (const tool of tools.slice(0, 2)) {
      assert.equal(tool.inputSchema.properties.model.type, "string");
      assert.ok(!tool.inputSchema.required.includes("model"));
    }
    const invalid = await client.callTool({
      name: "gpt_image_generate", arguments: { prompt: "test", model: " " },
    });
    assert.equal(invalid.isError, true);
    const missingKey = await client.callTool({
      name: "gpt_image_generate", arguments: { prompt: "test", model: "gpt-image-2.5" },
    });
    assert.equal(missingKey.isError, true);
    assert.match(missingKey.content[0].text, /MLGB7_API_KEY is not configured for the gpt-image MCP server/);
  } finally {
    await client.close();
  }
});
