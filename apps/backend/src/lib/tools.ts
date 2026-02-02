import { tool } from "@langchain/core/tools";
import { z } from "zod";


export function fileTools(){

  const createFile = tool(
    async ({ location, content }) => {
    
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
