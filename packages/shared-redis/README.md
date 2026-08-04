# shared-redis

Shared Redis client and stream helpers for the Lovable monorepo.

## Consumer groups

Use `readGroupLoop` for durable stream consumption:

```ts
import {
  RedisManager,
  readGroupLoop,
  publishEnvelope,
  parseStreamFields,
  StreamGroups,
} from "shared-redis";

await readGroupLoop({
  stream: "backend:orch",
  group: StreamGroups.orch,
  readerRole: "orchBackend",
  handler: async (id, fields) => {
    const msg = parseStreamFields(fields);
    // handle; ack happens automatically on success
  },
});
```

Publish with a consistent envelope:

```ts
await publishEnvelope("orch:backend", {
  type: "PROJECT_INITIALIZED",
  projectId: "...",
});
```

Messages are stored as `{ data: JSON.stringify(envelope) }`.
`parseStreamFields` also accepts legacy flat `type` / `payload` fields and `key` as an alias for `type`.
