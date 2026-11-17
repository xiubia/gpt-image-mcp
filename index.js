#!/usr/bin/env node
import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { editImage, generateImage, pollImageTask } from "./client.js";

const { version } = JSON.parse(
  await fs.readFile(new URL("./package.json", import.meta.url), "utf8"),
);

const policy =
  "Use this server for image generation and editing through the configured image.mlgb7.com provider. The optional model parameter selects a provider model; the default is GPT_IMAGE_MODEL or gpt-image-2.5. If a request fails, report the error instead of silently changing model or provider.";

const server = new McpServer({
  name: "gpt-image",
  version,
}, { instructions: policy });

const commonFields = {
  prompt: z.string().min(1).describe("The image prompt or edit instruction."),
  model: z.string().trim().min(1).optional().describe("Provider model ID, such as gpt-image-2.5 or gpt-image-2.5-flare. Defaults to GPT_IMAGE_MODEL or gpt-image-2.5."),
  n: z.number().int().min(1).max(4).optional().describe("Number of images to return, from 1 to 4."),
  size: z.string().min(1).optional().describe("Image size accepted by the provider, such as auto."),
  quality: z.string().min(1).optional().describe("Optional provider quality setting."),
  response_format: z.literal("url").optional().describe("Request provider image URLs; the MCP also saves completed images locally and returns local_path."),
};

function success(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

server.registerTool(
  "gpt_image_generate",
  {
    title: "Generate with GPT Image",
    description: "Generate images using a selectable GPT Image model through image.mlgb7.com. Completed images are automatically saved locally and returned with local_path and requested_model. Defaults to gpt-image-2.5 unless GPT_IMAGE_MODEL is configured.",
    inputSchema: commonFields,
  },
  async (input) => {
    try {
      return success(await generateImage(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "gpt_image_edit",
  {
    title: "Edit with GPT Image",
    description: "Edit a local reference image using a selectable GPT Image model through image.mlgb7.com. Completed images are automatically saved locally and returned with local_path and requested_model.",
    inputSchema: {
      ...commonFields,
      image_path: z.string().min(1).describe("Absolute local path to the reference image."),
    },
  },
  async (input) => {
    try {
      return success(await editImage(input));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "gpt_image_poll",
  {
    title: "Poll GPT Image task",
    description: "Query image.mlgb7.com for a pending generation or edit task using its task ID, and save completed images to the local output directory.",
    inputSchema: {
      ids: z.array(z.string().min(1)).min(1).max(20).describe("One or more provider task IDs."),
    },
  },
  async (input) => {
    try {
      return success(await pollImageTask(input));
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());
