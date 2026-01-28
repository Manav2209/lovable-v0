import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { Sandbox } from "@e2b/code-interpreter";

export function createSandboxTools(sandbox: Sandbox) {

  const createFile = tool(
    async ({ location, content }) => {
      await sandbox.files.write(location, content);
      return "File created";
    },
    {
      name: "create_file",
      description: "Create a file in the sandbox",
      schema: z.object({
        location: z.string(),
        content: z.string(),
      }),
    }
  );

  const updateFile = tool(
    async ({ location, content }) => {
      await sandbox.files.write(location, content);
      return "File updated";
    },
    {
      name: "update_file",
      description: "Update a file in the sandbox",
      schema: z.object({
        location: z.string(),
        content: z.string(),
      }),
    }
  );

  const deleteFile = tool(
    async ({ location }) => {
      await sandbox.files.remove(location);
      return "File deleted";
    },
    {
      name: "delete_file",
      description: "Delete a file in the sandbox",
      schema: z.object({
        location: z.string(),
      }),
    }
  );

  const readFile = tool(
    async ({ location }) => {
      return await sandbox.files.read(location);
    },
    {
      name: "read_file",
      description: "Read a file from the sandbox",
      schema: z.object({
        location: z.string(),
      }),
    }
  );

  return [createFile, updateFile, deleteFile, readFile];
}
