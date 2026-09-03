import { addDependency, removeDependency } from "./simple/addAndRemoveDependency";
import { addShadcnComponent } from "./simple/addShadcnComponent";
import { createFile } from "./simple/createFile";
import { deleteFile } from "./simple/deleteFile";
import { listDir } from "./simple/listDir";
import { readFile } from "./simple/readFile";
import { grepSearch } from "./simple/grepSearch";
import { replaceInFile } from "./simple/replaceInFile";
import { updateFile } from "./simple/updateFile";

export const codingAgentTools = [
    listDir,
    grepSearch,
    readFile,
    createFile,
    updateFile,
    replaceInFile,
    deleteFile,
    addDependency,
    removeDependency,
    addShadcnComponent,
];
