export interface ShimSessionContext {
    authenticated: boolean;
    user?: { id: string };
}

export async function resolveSessionContext(_event: unknown): Promise<ShimSessionContext> {
    throw new Error('Type-check shim only. Runtime should resolve ~~\/server\/auth\/session.');
}
