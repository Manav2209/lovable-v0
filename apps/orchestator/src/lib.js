"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toK8sName = toK8sName;
function toK8sName(projectId) {
    return ("proj-" +
        projectId
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+/, "")
            .replace(/-+$/, "")
            .slice(0, 50));
}
