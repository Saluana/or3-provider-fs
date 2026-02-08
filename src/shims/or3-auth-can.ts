export function requireCan(
    _session: unknown,
    _permission: string,
    _resource?: { kind: string; id?: string }
): void {
    throw new Error('Type-check shim only. Runtime should resolve ~~\/server\/auth\/can.');
}
