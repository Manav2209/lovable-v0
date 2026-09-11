import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath, runProcess } from "../security";

const dependencyInput = z.object({
    packages: z.array(z.string()),
    cwd: z.string().optional(),
});

/** Only allow npm package-name characters: no shell metacharacters, no spaces. */
const PACKAGE_NAME_RE = /^[@a-zA-Z0-9][@a-zA-Z0-9._~+/^=*-]*$/;

/**
 * Placeholder/never-declared packages the model fabricates. `bun add` on these
 * installs an unusable stub (e.g. @shadcn/ui@0.0.1) that breaks the build and,
 * in the eval harness, writes through the shared template junction and poisons
 * every subsequent case. shadcn/ui components are added via addShadcnComponent;
 * template primitives import radix-ui directly.
 */
const BLOCKED_PACKAGES = new Set(["@shadcn/ui", "shadcn/ui", "@shadcn"]);

function validatePackages(packages: string[]): string | null {
    for (const pkg of packages) {
        if (pkg.length > 256) {
            return `Package name too long: "${pkg.slice(0, 40)}..."`;
        }
        if (!PACKAGE_NAME_RE.test(pkg)) {
            return `Invalid package name: "${pkg}"`;
        }
        if (BLOCKED_PACKAGES.has(pkg)) {
            return `"${pkg}" is not installable: it is a placeholder package. Use addShadcnComponent for shadcn/ui components (or radix-ui directly, as the template's ui/ primitives do).`;
        }
    }
    return null;
}

export const addDependency = tool(
async (input: z.infer<typeof dependencyInput>) => {
    const { packages, cwd } = dependencyInput.parse(input);
    const projectDir = getProjectDir();
    const workingDir = cwd ? resolveSafePath(projectDir, cwd) : projectDir;

    const invalid = validatePackages(packages);
    if (invalid) {
        return { success: false, error: invalid };
    }

    console.log(`[addDependency] Running: bun add ${packages.join(" ")}`);
    console.log(`[addDependency] Working dir: ${workingDir}`);
    console.log(`[addDependency] Packages: ${packages.join(", ")}`);

    try {
        const result = await runProcess("bun", ["add", ...packages], {
            cwd: workingDir,
            timeoutMs: 3 * 60_000,
        });

        console.log(`[addDependency] Exit code: ${result.exitCode}`);
        console.log(`[addDependency] Success: ${result.success}`);

        if (result.success) {
            console.log(`[addDependency] Successfully installed: ${packages.join(", ")}`);
        } else {
            console.error(`[addDependency] Failed to install: ${packages.join(", ")}`);
            console.error(`[addDependency] stderr: ${result.stderr}`);
        }

        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            success: result.success,
            error: result.error,
        };
    } catch (error) {
        console.error(`[addDependency] Exception:`, error);
        return {
            success: false,
            error: `Failed to add dependencies: ${(error as Error).message}`,
        };
    }
},
{
    name: "addDependency",
    description: "Adds npm dependencies using bun.",
    schema: dependencyInput,
  },
);

export const removeDependency = tool(async (input: z.infer<typeof dependencyInput>) => {
    const { packages, cwd } = dependencyInput.parse(input);
    const projectDir = getProjectDir();
    const workingDir = cwd ? resolveSafePath(projectDir, cwd) : projectDir;

    const invalid = validatePackages(packages);
    if (invalid) {
        return { success: false, error: invalid };
    }

    console.log(`[removeDependency] Running: bun remove ${packages.join(" ")}`);
    console.log(`[removeDependency] Working dir: ${workingDir}`);

    try {
        const result = await runProcess("bun", ["remove", ...packages], {
            cwd: workingDir,
            timeoutMs: 3 * 60_000,
        });

        console.log(`[removeDependency] Exit code: ${result.exitCode}`);

        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            success: result.success,
            error: result.error,
        };
    } catch (error) {
        console.error(`[removeDependency] Exception:`, error);
        return {
            success: false,
            error: `Failed to remove dependencies: ${(error as Error).message}`,
        };
    }
},
    {
        name: "removeDependency",
        description: "Removes npm dependencies using bun.",
        schema: dependencyInput,
    },
);