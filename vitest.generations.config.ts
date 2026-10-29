import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Explicit cross-provider lane. Requires the reviewed SQLite source/dependencies
// at ../sqlite; a missing checkout is an error, never a skipped safety test.
export default defineConfig({ ...base, test: { ...base.test, include: ['integration/**/*.test.ts'] } });
