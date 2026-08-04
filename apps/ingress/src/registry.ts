export type RouteRecord = {
    projectId: string;
    slug: string;
    upstream: string;
    registeredAt: string;
};

const routes = new Map<string, RouteRecord>();

export function registerRoute(input: {
    projectId: string;
    slug: string;
    upstream: string;
}): RouteRecord {
    const upstream = input.upstream.replace(/\/$/, "");
    const record: RouteRecord = {
        projectId: input.projectId,
        slug: input.slug,
        upstream,
        registeredAt: new Date().toISOString(),
    };
    routes.set(input.slug, record);
    console.log(
        `[ingress] Registered ${input.slug} → ${upstream} (project=${input.projectId})`,
    );
    return record;
}

export function unregisterRoute(slug: string): boolean {
    const ok = routes.delete(slug);
    if (ok) console.log(`[ingress] Unregistered ${slug}`);
    return ok;
}

export function getRoute(slug: string): RouteRecord | undefined {
    return routes.get(slug);
}

export function listRoutes(): RouteRecord[] {
    return [...routes.values()];
}
