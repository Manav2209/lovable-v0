/** Sanitize a project id into a DNS-safe slug for preview hosts / K8s names. */
export function toPreviewSlug(projectId: string): string {
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

export type PreviewUrlOptions = {
    projectId: string;
    /** e.g. preview.localhost — default from PREVIEW_DOMAIN */
    domain?: string;
    /** public protocol — default http */
    protocol?: string;
    /** public port of the ingress edge — default PREVIEW_PUBLIC_PORT or 8080 */
    port?: string | number;
};

/**
 * Build the user-facing preview URL for a project.
 * Example: http://proj-abc.preview.localhost:8080
 */
export function buildPreviewUrl(opts: PreviewUrlOptions): string {
    const slug = toPreviewSlug(opts.projectId);
    const domain =
        opts.domain || process.env.PREVIEW_DOMAIN || "preview.localhost";
    const protocol =
        opts.protocol || process.env.PREVIEW_PUBLIC_PROTOCOL || "http";
    const port = String(
        opts.port ?? process.env.PREVIEW_PUBLIC_PORT ?? "8080",
    );

    const omitPort =
        (protocol === "http" && port === "80") ||
        (protocol === "https" && port === "443");

    return omitPort
        ? `${protocol}://${slug}.${domain}`
        : `${protocol}://${slug}.${domain}:${port}`;
}

/** Extract preview slug from a Host header like `proj-abc.preview.localhost:8080`. */
export function slugFromHost(
    hostHeader: string,
    domain = process.env.PREVIEW_DOMAIN || "preview.localhost",
): string | null {
    const host = hostHeader.split(":")[0]?.toLowerCase() ?? "";
    const suffix = `.${domain.toLowerCase()}`;
    if (!host.endsWith(suffix)) return null;
    const slug = host.slice(0, -suffix.length);
    return slug || null;
}

/** Redis stream for preview route registration */
export const PreviewRegister = "preview:register";
export const PREVIEW_REGISTER = "PREVIEW_REGISTER";
export const PREVIEW_UNREGISTER = "PREVIEW_UNREGISTER";
