export function extractJsonObject(text: string): string {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (fence?.[1]) return fence[1];
    const match = trimmed.match(/\{[\s\S]*\}/);
    return match?.[0] ?? trimmed;
}

export function parseJsonObject<T = unknown>(text: string): T {
    const jsonText = extractJsonObject(text)
        .replace(/,(\s*[\]}])/g, "$1")
        .replace(/\r/g, "")
        .trim();
    return JSON.parse(jsonText) as T;
}
