import { addDependency, removeDependency } from "./simple/addAndRemoveDependency";
import { addShadcnComponent } from "./simple/addShadcnComponent";
import { createFile } from "./simple/createFile";
import { deleteFile } from "./simple/deleteFile";
import { listDir } from "./simple/listDir";
import { readFile } from "./simple/readFile";
import { grepSearch } from "./simple/grepSearch";
import { replaceInFile } from "./simple/replaceInFile";
import { updateFile } from "./simple/updateFile";

export type ToolKind = "read" | "mutate";

export const toolRegistry = [
    { tool: listDir, kind: "read" },
    { tool: grepSearch, kind: "read" },
    { tool: readFile, kind: "read" },
    { tool: createFile, kind: "mutate" },
    { tool: updateFile, kind: "mutate" },
    { tool: replaceInFile, kind: "mutate" },
    { tool: deleteFile, kind: "mutate" },
    { tool: addDependency, kind: "mutate" },
    { tool: removeDependency, kind: "mutate" },
    { tool: addShadcnComponent, kind: "mutate" },
] as const;

export const codingAgentTools = toolRegistry.map((entry) => entry.tool);

export const RETRIEVAL_TOOLS = new Set<string>(
    toolRegistry
        .filter((entry) => entry.kind === "read")
        .map((entry) => entry.tool.name),
);

export const MUTATION_TOOLS = new Set<string>(
    toolRegistry
        .filter((entry) => entry.kind === "mutate")
        .map((entry) => entry.tool.name),
);