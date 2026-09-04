import { tool } from "langchain";
import * as z from "zod";

import { IGNORE_PATTERNS } from "../simple/getContext"
import { sendSSEMessage } from "../../../sse";
import { model } from "../../client";
import { allTools, type WorkflowState } from "../../graphs/main";
import { assertSafeProjectId } from "types";
import { resolveSafePath } from "../security";

const errorFixerInput = z.object({
  projectId: z.string(),
  errors: z.array(z.any()),
  errorAnalysis: z.any(),
  context: z.any().optional(),
  previousAttempts: z.array(z.string()).optional(),
});

function createFallbackFixPlan(errors: any[], _errorAnalysis: any, fullBuildError?: string, existingFiles?: string[]): any[] {
  const fixPlan: any[] = [];

  if (fullBuildError && fullBuildError.includes("Cannot apply unknown utility class")) {
    console.log("[createFallbackFixPlan] Detected Tailwind CSS error - unknown utility class");
    const componentFiles = existingFiles?.filter(f =>
      (f.endsWith('.jsx') || f.endsWith('.tsx') || f.endsWith('.js')) &&
      f.includes('src/')
    ) || [];

    console.log("[createFallbackFixPlan] Will search these component files:", componentFiles.slice(0, 10));

    for (const file of componentFiles.slice(0, 5)) {
      fixPlan.push({
        priority: 1,
        action: "readFile",
        target: file,
        description: `Check ${file} for empty className attributes`,
        details: {
          filePath: file
        }
      });
    }
  }

  const allMissingPackages = new Set<string>();

  if (fullBuildError) {
    const vitePattern = /failed to resolve import ["']([^"']+)["']/gi;
    let match;
    while ((match = vitePattern.exec(fullBuildError)) !== null) {
      if (match[1]) allMissingPackages.add(match[1]);
    }

    const modulePattern = /Cannot find module ["']([^"']+)["']/gi;
    while ((match = modulePattern.exec(fullBuildError)) !== null) {
      if (match[1]) allMissingPackages.add(match[1]);
    }
  }

  const buildErrorPattern = /failed to resolve import ["']([^"']+)["']/i;
  const moduleNotFoundPattern = /Cannot find module ["']([^"']+)["']/i;

  for (const error of errors) {
    const errorMsg = error.message || error.error || String(error);
    let match = errorMsg.match(buildErrorPattern);
    if (match && match[1]) {
      allMissingPackages.add(match[1]);
    }
    match = errorMsg.match(moduleNotFoundPattern);
    if (match && match[1]) {
      allMissingPackages.add(match[1]);
    }
    if (error.type === 'dependency' || errorMsg.includes('not found')) {
      match = errorMsg.match(/['"]([^'"]+)['"]/);
      if (match && match[1]) {
        allMissingPackages.add(match[1]);
      }
    }
  } if (allMissingPackages.size > 0) {
    const packages = Array.from(allMissingPackages);
    fixPlan.push({
      priority: 1,
      action: "addDependency",
      target: packages.join(", "),
      description: `Install missing dependencies: ${packages.join(", ")}`,
      details: { packages }
    });
  }

  const exportErrorPattern = /"([^"]+)" is not exported by "([^"]+)"/i;
  for (const error of errors) {
    const errorMsg = error.message || error.error || String(error);
    const match = errorMsg.match(exportErrorPattern);
    if (match && match[1] && match[2]) {
      const wrongExport = match[1];
      const packageName = match[2];

      if (packageName.includes('lucide-react')) {
        let correctExport = wrongExport;
        if (wrongExport === 'Tools') correctExport = 'Tool';
        if (wrongExport === 'Settings') correctExport = 'Settings';
        if (wrongExport === 'Icons') correctExport = 'Icon';

        if (correctExport !== wrongExport && fullBuildError) {
          const importPattern = new RegExp(`import\\s*{([^}]*\\b${wrongExport}\\b[^}]*)}\\s*from\\s*['"]${packageName.replace(/\//g, '\\/')}['"]`, 'i');
          const importMatch = fullBuildError.match(importPattern);

          if (importMatch) {
            const oldImport = importMatch[0];
            const newImport = oldImport.replace(wrongExport, correctExport);

            fixPlan.push({
              priority: 1,
              action: "replaceInFile",
              target: `Fix ${wrongExport} -> ${correctExport}`,
              description: `Fix invalid export: ${wrongExport} should be ${correctExport} in ${packageName}`,
              details: {
                filePath: error.file || "src/components/ServicesSection.jsx",
                oldString: oldImport,
                newString: newImport
              }
            });

            fixPlan.push({
              priority: 2,
              action: "replaceInFile",
              target: `Fix JSX usage of ${wrongExport}`,
              description: `Update JSX to use ${correctExport} instead of ${wrongExport}`,
              details: {
                filePath: error.file || "src/components/ServicesSection.jsx",
                oldString: `<${wrongExport}`,
                newString: `<${correctExport}`
              }
            });

            fixPlan.push({
              priority: 3,
              action: "replaceInFile",
              target: `Fix JSX closing tag of ${wrongExport}`,
              description: `Update closing tag to use ${correctExport}`,
              details: {
                filePath: error.file || "src/components/ServicesSection.jsx",
                oldString: `</${wrongExport}`,
                newString: `</${correctExport}`
              }
            });
          }
        }
      }
    }
  }

  const importErrors = errors.filter(e => e.type === 'import');
  if (importErrors.length > 0) {
    const uiComponentErrors = importErrors.filter(e =>
      e.message?.includes('@/components/ui/') ||
      e.message?.includes('components/ui/')
    );

    if (uiComponentErrors.length > 0) {
      const componentsToAdd = new Set<string>();
      for (const error of uiComponentErrors) {
        const match = error.message?.match(/['"]([^'"]*components\/ui\/([^'"]+))['"]/) ||
          error.message?.match(/@\/components\/ui\/([^'"\s]+)/);
        if (match) {
          const componentName = match[2] || match[1];
          if (componentName && componentName !== 'button' && componentName !== 'card') {
            componentsToAdd.add(componentName);
          }
        }
      }

      if (componentsToAdd.size > 0) {
        for (const component of Array.from(componentsToAdd)) {
          fixPlan.push({
            priority: 2,
            action: "addShadcnComponent",
            target: component,
            description: `Add missing shadcn/ui component: ${component}`,
            details: {
              component,
            },
          });
        }
      }
    }
  }

  return fixPlan;
}

export const intelligentErrorFixer = tool(
  async (input: z.infer<typeof errorFixerInput>) => {
    const { errors, errorAnalysis, context, previousAttempts } = errorFixerInput.parse(input);

    const normalizedErrors = errors.map((err: any) => {
      if (typeof err === 'string') {
        return {
          type: 'unknown',
          severity: 'major',
          message: err,
          fixable: true
        };
      }
      return err;
    });

    const fullBuildError = context?.fullBuildError || "";

    const errorSummary = `
FULL BUILD ERROR OUTPUT:
======================
${fullBuildError}
======================

Build Errors Analysis:
- Total Errors: ${errorAnalysis?.totalErrors || normalizedErrors.length}
- Critical: ${errorAnalysis?.criticalCount || 0}
- Major: ${errorAnalysis?.majorCount || 0}
- Minor: ${errorAnalysis?.minorCount || 0}
- Fixable: ${errorAnalysis?.fixableCount || 0}

Error Types:
${Object.entries(errorAnalysis?.errorsByType || {})
        .filter(([_, count]) => (count as number) > 0)
        .map(([type, count]) => `- ${type}: ${count}`)
        .join('\n')}

Parsed Errors:
${normalizedErrors.slice(0, 10).map((err, idx) => `${idx + 1}. [${err.severity}] ${err.type}: ${err.message}${err.file ? ` (${err.file}${err.line ? `:${err.line}` : ''})` : ''}`).join('\n')}

${previousAttempts && previousAttempts.length > 0 ? `
Previous Fix Attempts (that failed):
${previousAttempts.map((attempt, idx) => `${idx + 1}. ${attempt}`).join('\n')}
` : ''}

Project Context:
- Available dependencies: ${context?.dependencies?.join(', ') || 'unknown'}
- React version: ${context?.dependencies?.includes('react') ? 'installed' : 'check package.json'}
${context?.existingFiles ? `
- Existing files in project (${context.existingFiles.length} files):
  ${context.existingFiles.slice(0, 50).join('\n  ')}
` : ''}
`;

    const systemPrompt = `You are an expert JavaScript/React error fixer. Analyze the FULL BUILD ERROR OUTPUT carefully to extract exact package names and create fixes.

CRITICAL INSTRUCTIONS:
1. **TAILWIND CSS ERRORS** (HIGHEST PRIORITY):
   - Error: "Cannot apply unknown utility class \`\`" (empty class)
   - The error points to src/index.css or src/App.css but the REAL problem is in JSX components
   - ROOT CAUSE: A component has empty className="" or className={undefined} or className={''}
   - SOLUTION: Use grepSearch with: className="" to find the culprit file
   - Then use replaceInFile to remove the empty className attribute entirely
   - IMPORTANT: The error says "file: /path/to/src/index.css" but DON'T fix index.css - fix the component!

2. **FILE EXISTENCE CHECK**:
   - BEFORE suggesting fixes for a file, CHECK if it exists in the "Existing files in project" list
   - If file doesn't exist (like src/components/ServicesSection.jsx), DO NOT create fixes for it
   - Only fix files that actually exist in the project

3. Read the FULL BUILD ERROR OUTPUT section to find the EXACT package/module names
4. For Vite/Rollup errors like "failed to resolve import '@radix-ui/react-label'":
   - Extract the EXACT package name from the error (e.g., @radix-ui/react-label)
   - Create an addDependency action with that exact package name
5. For missing exports like '"Tools" is not exported by "lucide-react"':
   - This means the import name is WRONG, not missing
   - For lucide-react, common icons are: Tool (singular), Wrench, Hammer, Settings, Cog, HardHat
   - Use replaceInFile action to fix the import statement
   - Use replaceInFile action again to fix JSX usage
6. Always prioritize: Tailwind errors > addDependency for missing modules > import fixes

Fix Action Types:
- grepSearch: { pattern, searchPath? } - Search for regex patterns in code
- addDependency: { packages: ["exact-package-name"], cwd? } - Install npm packages
- replaceInFile: { filePath, oldString, newString } - Find-and-replace in specific file
- updateFile: { filePath, content } - Replace entire file content
- createFile: { filePath, content } - Create new files

EXAMPLES:

Example 1: Missing package error
[
  {
    "priority": 1,
    "action": "addDependency",
    "target": "@radix-ui/react-label",
    "description": "Install missing dependency @radix-ui/react-label",
    "details": {
      "packages": ["@radix-ui/react-label"]
    }
  }
]

Example 2: Wrong import name (ONLY if file exists in project)
[
  {
    "priority": 1,
    "action": "replaceInFile",
    "target": "src/App.jsx",
    "description": "Fix invalid lucide-react import: Tools -> Tool",
    "details": {
      "filePath": "src/App.jsx",
      "oldString": "import { Construction, Building, Tools } from 'lucide-react';",
      "newString": "import { Construction, Building, Tool } from 'lucide-react';"
    }
  },
  {
    "priority": 2,
    "action": "replaceInFile",
    "target": "src/App.jsx",
    "description": "Update JSX to use Tool instead of Tools",
    "details": {
      "filePath": "src/App.jsx",
      "oldString": "<Tools",
      "newString": "<Tool"
    }
  }
]

CRITICAL: Return ONLY the JSON array. NO markdown code blocks, NO explanations, JUST the JSON array starting with [ and ending with ].`;

    try {
      const response = await model.invoke([
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: errorSummary,
        },
      ]);

      let fixPlan;
      try {
        const text = response.text.trim();

        // Try to extract JSON from markdown code blocks first
        let jsonText = text;
        const codeBlockMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (codeBlockMatch && codeBlockMatch[1]) {
          jsonText = codeBlockMatch[1];
        } else {
          // Try to find JSON array in the response
          const jsonMatch = text.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            jsonText = jsonMatch[0];
          }
        }

        // Clean up common JSON issues
        jsonText = jsonText
          .replace(/,(\s*[\]}])/g, '$1') // Remove trailing commas
          .replace(/\n/g, ' ')            // Remove newlines within strings
          .replace(/\r/g, '')             // Remove carriage returns
          .trim();

        fixPlan = JSON.parse(jsonText);

        // Validate fixPlan is an array
        if (!Array.isArray(fixPlan)) {
          throw new Error("Fix plan is not an array");
        }

        console.log("[intelligentErrorFixer] Successfully parsed fix plan with", fixPlan.length, "actions");
        console.log("[intelligentErrorFixer] First action:", JSON.stringify(fixPlan[0], null, 2));

      } catch (parseError) {
        console.error("[intelligentErrorFixer] Failed to parse AI response as JSON:", parseError);
        console.error("[intelligentErrorFixer] AI response text:", response.text);

        // Fallback: Create a simple fix plan based on error types
        console.log("Creating fallback fix plan...");
        fixPlan = createFallbackFixPlan(normalizedErrors, errorAnalysis, fullBuildError, context?.existingFiles);

        if (fixPlan.length === 0) {
          return {
            success: false,
            message: "Failed to generate fix plan",
            error: "AI response was not valid JSON and no fallback available",
          };
        }
      }

      return {
        success: true,
        fixPlan,
        errorsSummary: errorSummary,
      };
    } catch (error) {
      console.error("Error in intelligentErrorFixer:", error);
      return {
        success: false,
        message: "Failed to analyze errors",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  {
    name: "intelligentErrorFixer",
    description: "Analyzes build errors and creates an AI-powered fix plan with specific actions to resolve them.",
    schema: errorFixerInput,
  },
);

/**
 * Build a minimal-but-valid shadcn-style component for a missing `ui/*` module.
 *
 * The agent frequently emits imports like `./ui/input` (lowercase, missing
 * file) or `components/ui` (a directory, no barrel). Rather than let the LLM
 * "fix" these with an npm `addDependency` (which installs a bogus package) or a
 * matchless replaceInFile (which retries forever), we scaffold a compilable
 * component on the spot.
 *
 * These are deliberately plain renderers that forward props + className so any
 * consumer using them as native-ish elements works without a build failure.
 */
function buildShadcnComponent(name: string): string {
  const pascalParts: string[] = name.split(/[-_]/).filter((p) => p.length > 0);
  const pascal = pascalParts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  const tag = { input: "input", textarea: "textarea", select: "select", label: "label", button: "button" }[name.toLowerCase()] || "div";

  return `import * as React from "react";
import { cn } from "@/lib/utils";

/** Scaffolded minimal ${name} component (auto-generated by the error fixer). */
export function ${pascal}({ className, ...props }) {
  return React.createElement("${tag}", { className: cn(className), ...props });
}
`;
}

/** Detect unresolved LOCAL (src-relative) modules from a Vite/Rollup build error. */
function findMissingLocalModules(fullBuildError: string): string[] {
  const out: string[] = [];
  // Matches "....<drive>/src/path/to/file (imported by ...)" and the EISDIR form.
  // Capture the path right after src\ or src/ up to the following " (".
  const re = /[\\/]src[\\/]([A-Za-z0-9_.\\/|-]+?)\s+\((?:imported by|EISDIR)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fullBuildError)) !== null) {
    const ref = (m[1] as string).replace(/\\/g, "/");
    if (/^[A-Za-z0-9_./-]+$/.test(ref)) {
      out.push(`src/${ref}`);
    }
  }
  return [...new Set(out)];
}

/**
 * Best-effort scaffold of missing local modules referenced by a build error.
 * Returns the list of file paths created (relative to projectDir), or [].
 */
export function scaffoldMissingModules(
  projectDir: string,
  fullBuildError: string,
): string[] {
  const fs = require("fs");
  const path = require("path");
  const created: string[] = [];
  if (!fullBuildError) return created;

  const missing = findMissingLocalModules(fullBuildError);
  for (let rel of missing) {
    let full = path.resolve(projectDir, rel);

    // Directory imported as a module (EISDIR) -> if the dir exists but has no
    // barrel, create an index.ts that re-exports its .tsx siblings so the
    // import resolves.
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const barrel = path.join(full, "index.js");
      if (!fs.existsSync(barrel)) {
        const files = (fs.readdirSync(full) as string[])
          .filter((f) => /\.(t|j)sx$/.test(f) && !f.startsWith("index"))
          .map((f) => f.replace(/\.(t|j)sx$/, ""));
        const content = files.map((f) => `export * from "./${f}";`).join("\n");
        fs.writeFileSync(barrel, content || "export {};\n", "utf8");
        created.push(path.relative(projectDir, barrel));
      }
      continue;
    }

    // Extensionless module ref (e.g. `./ui/input`) -> try the conventional
    // resolved file `input.jsx` (then `.js`, `.tsx`, `.ts`).
    const hasExt = /\.(t|j)sx?$/.test(rel);
    if (!hasExt && !fs.existsSync(full)) {
      const tryExt = (["jsx", "js", "tsx", "ts"] as const).find((e) =>
        fs.existsSync(path.resolve(projectDir, `${rel}.${e}`)),
      );
      if (tryExt) {
        continue; // already resolvable via the real file
      }
      rel = `${rel}.jsx`;
      full = path.resolve(projectDir, rel);
    }

    // Normal missing file -> scaffold a minimal component.
    if (fs.existsSync(full)) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const name = path.basename(rel, path.extname(rel));
    fs.writeFileSync(full, buildShadcnComponent(name), "utf8");
    created.push(path.relative(projectDir, full));
  }
  return created;
}

function getAllProjectFiles(projectDir: string, baseDir: string = "",): string[] {
  const fs = require("fs");
  const path = require("path");
  const files: string[] = [];

  try {
    const entries = fs.readdirSync(path.join(projectDir, baseDir), { withFileTypes: true });

    for (const entry of entries) {
      if (IGNORE_PATTERNS.some(pattern => entry.name.includes(pattern) || entry.name.startsWith(pattern))) {
        continue;
      }

      const relativePath = baseDir ? `${baseDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        files.push(...getAllProjectFiles(projectDir, relativePath));
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  } catch (error) {
    console.error(`[getAllProjectFiles] Error reading ${baseDir}:`, error);
  }

  return files;
}

export async function fixErrorsNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  sendSSEMessage(state.clientId, {
    type: "fixing",
    message: "Analyzing and fixing errors...",
  });

  console.log("[fixErrorsNode] buildErrors:", JSON.stringify(state.buildErrors, null, 2));
  console.log("[fixErrorsNode] buildOutput:", state.buildOutput?.substring(0, 500));

  const projectId = state.projectId;
  const projectDir = resolveSafePath(
    process.env.SHARED_DIR || "/app/shared",
    assertSafeProjectId(projectId),
  );
  const existingFiles = getAllProjectFiles(projectDir);

  console.log("[fixErrorsNode] Found existing files:", existingFiles.slice(0, 20));

  // Pre-emptively scaffold missing local (src-relative) modules referenced by
  // the build error (e.g. src/components/ui/input). This addresses the common
  // failure where the agent's generated fix plan tries to `addDependency` a
  // bogus npm package (e.g. "input") or issue a matchless replaceInFile, either
  // of which retries until maxFixAttempts and errors out the whole case.
  const fullBuildError = state.buildOutput || state.error || "";
  const scaffolded = scaffoldMissingModules(projectDir, fullBuildError);
  if (scaffolded.length > 0) {
    console.log("[fixErrorsNode] Scaffolded missing modules:", scaffolded);
    sendSSEMessage(state.clientId, {
      type: "fix_success",
      message: `✓ Scaffolded missing module(s): ${scaffolded.join(", ")}`,
    });
  }

  const fixPlanResult = await intelligentErrorFixer.invoke({
    projectId: state.projectId,
    errors: state.buildErrors || [],
    errorAnalysis: state.errorAnalysis,
    context: {
      ...state.context,
      fullBuildError: fullBuildError,
      existingFiles: existingFiles,
    },
    previousAttempts: [],
  }) as any;

  if (!fixPlanResult.success || !fixPlanResult.fixPlan) {
    sendSSEMessage(state.clientId, {
      type: "fixing_failed",
      message: "Failed to generate fix plan",
    });
    return {
      fixAttempts: state.fixAttempts + 1,
    };
  }

  sendSSEMessage(state.clientId, {
    type: "fix_plan_generated",
    message: `Generated ${fixPlanResult.fixPlan.length} fix actions`,
  });

  const toolMap = allTools.reduce(
    (acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    },
    {} as Record<string, any>,
  );

  let successCount = 0;

  // Guard against the fix-loop blind spot: a replaceInFile whose oldString was
  // guessed (transcribed from the error message) but is not actually present in
  // the file will ALWAYS fail with "String not found", retrying until
  // maxFixAttempts. Drop such actions up front so a bad edit can't burn the
  // whole attempt budget. Only applies when the file can be read; if the file
  // is missing we also drop it.
  const diffFs = require("fs");
  const diffPath = require("path");
  const guardedFixPlan = fixPlanResult.fixPlan.filter((action: any) => {
    if (action.action !== "replaceInFile" || !action.details?.filePath) return true;
    const target = diffPath.resolve(projectDir, action.details.filePath);
    if (!diffFs.existsSync(target)) {
      console.warn(`[fixErrorsNode] Dropping replaceInFile to missing file ${action.details.filePath}`);
      return false;
    }
    const content = diffFs.readFileSync(target, "utf8");
    if (!content.includes(action.details.oldString ?? "")) {
      console.warn(
        `[fixErrorsNode] Dropping replaceInFile whose oldString is not in ${action.details.filePath}: "${String(action.details.oldString).substring(0, 60)}"`,
      );
      return false;
    }
    return true;
  });

  for (const action of guardedFixPlan.slice(0, 10)) {
    try {
      sendSSEMessage(state.clientId, {
        type: "executing_fix",
        message: action.description || `Executing ${action.action}`,
      });

      const tool = toolMap[action.action];
      if (!tool) {
        console.warn(`Tool ${action.action} not found in toolMap`);
        if (action.action === "addDependency" && action.details?.packages) {
          const addDepTool = toolMap["addDependency"];
          if (addDepTool) {
            const result = await addDepTool.invoke({
              packages: action.details.packages,
              cwd: action.details.cwd,
            });
            if (result.success) successCount++;
          }
        } else if (action.action === "replaceInFile" && action.details?.filePath) {
          const replaceTool = toolMap["replaceInFile"];
          if (replaceTool) {
            const result = await replaceTool.invoke({
              filePath: action.details.filePath,
              oldString: action.details.oldString,
              newString: action.details.newString,
            });
            if (result.success) successCount++;
          }
        }
        continue;
      }

      console.log(`[fixErrorsNode] Invoking tool: ${action.action} with details:`, JSON.stringify(action.details).substring(0, 200));
      const result = await tool.invoke(action.details);
      console.log(`[fixErrorsNode] Tool ${action.action} result:`, result);

      if (result?.success !== false) {
        successCount++;
        sendSSEMessage(state.clientId, {
          type: "fix_success",
          message: `✓ ${action.description || action.action}`,
        });
      } else {
        console.warn(`[fixErrorsNode] Tool ${action.action} returned success=false:`, result);
      }
    } catch (error) {
      console.error(`[fixErrorsNode] Fix action failed for ${action.action}:`, error);
      console.error(`[fixErrorsNode] Action details:`, JSON.stringify(action.details, null, 2));
      sendSSEMessage(state.clientId, {
        type: "fix_error",
        message: `✗ ${action.description || action.action}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  sendSSEMessage(state.clientId, {
    type: "fixing_complete",
    message: `Applied ${successCount}/${guardedFixPlan.length} fixes successfully`,
  });

  const noFixesGenerated = guardedFixPlan.length === 0 && scaffolded.length === 0;

  if (noFixesGenerated) {
    console.warn("[fixErrorsNode] No fixes were generated by LLM or fallback!");
    sendSSEMessage(state.clientId, {
      type: "warning",
      message: "No fixes could be generated for the errors. The LLM may not know how to fix this issue.",
    });
  }

  return {
    fixAttempts: state.fixAttempts + 1,
    fixesApplied: !noFixesGenerated,
    noFixesAvailable: noFixesGenerated,
  };
}