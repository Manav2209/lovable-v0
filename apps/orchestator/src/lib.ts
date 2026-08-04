import { toPreviewSlug } from "types";

/** @deprecated Prefer toPreviewSlug from "types" — kept for local imports. */
export function toK8sName(projectId: string) {
    return toPreviewSlug(projectId);
}
