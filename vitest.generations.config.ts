import { defineConfig } from 'vitest/config';
import base from './vitest.config';
import path from 'node:path';

// Explicit cross-provider lane. Requires the reviewed SQLite source/dependencies
// at ../sqlite; a missing checkout is an error, never a skipped safety test.
export default defineConfig({ ...base,
    resolve: { ...base.resolve, alias: { ...base.resolve?.alias, zod: path.resolve(__dirname, '../or3-chat/node_modules/zod/index.js') } },
    test: { ...base.test, include: ['integration/**/*.test.ts'], server: { deps: { inline: [/zod/] } } },
});
