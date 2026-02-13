
export function toK8sName(projectId: string) {
    return (
        "proj-" +
        projectId
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/^-+/, "")
            .replace(/-+$/, "")
            .slice(0, 50) 
    );
}