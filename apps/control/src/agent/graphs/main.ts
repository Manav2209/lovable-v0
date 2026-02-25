import { promptAnalyzer } from "../tool/analysis/promptAnalyzer";
import { buildSource } from "../tool/code/buildSource";
import { checkUserGivenPrompt } from "../tool/code/userGivenPromptChecker";
import { validateBuild } from "../tool/code/validateBuild";
import { addDependency, removeDependency } from "../tool/simple/addAndRemoveDependency";
import { checkMissingPackage } from "../tool/simple/checkMissingPackage";
import { createFile } from "../tool/simple/createFile";
import { deleteFile } from "../tool/simple/deleteFile";
import { executeCommand } from "../tool/simple/executeCommand";
import { getContext } from "../tool/simple/getContext";
import { listDir } from "../tool/simple/listDir";
import { readFile } from "../tool/simple/readFile";
import { saveContext } from "../tool/simple/saveContext";
import { testBuild } from "../tool/simple/testBuild";
import { updateFile } from "../tool/simple/updateFile";
import { replaceInFile } from "../tool/simple/replaceInFile";
import { writeMultipleFile } from "../tool/simple/writeMultipleFile";
import { pushFilesToR2 } from "../tool/r2/push";
import { lineReplace } from "../tool/simple/lineReplace";
import { grepSearch } from "../tool/simple/grepSearch";
import { renameFile } from "../tool/simple/renameFile";
import type { WorkflowState } from "./main";
import { executeWorkflow } from "./main";

export const allTools = [
    promptAnalyzer,
    buildSource,
    checkUserGivenPrompt,
    validateBuild,
    addDependency,
    removeDependency,
    checkMissingPackage,
    createFile,
    deleteFile,
    executeCommand,
    getContext,
    listDir,
    readFile,
    saveContext,
    testBuild,
    updateFile,
    replaceInFile,
    writeMultipleFile,
    pushFilesToR2,
    lineReplace,
    grepSearch,
    renameFile,
];

export type { WorkflowState } from "./workflow";

export { executeWorkflow } from "./workflow";

export async function executeMainFlow(initialState: WorkflowState): Promise<WorkflowState> {
    return await executeWorkflow(initialState);
}