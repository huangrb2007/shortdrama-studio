import { defineConfig } from 'vitest/config';
import path from 'node:path';
const p = (n: string) => path.resolve(__dirname, `packages/${n}/src/index.ts`);
export default defineConfig({ resolve: { alias: { '@studio/domain': p('domain'), '@studio/iron-rules': p('iron-rules'), '@studio/skill-runtime': p('skill-runtime'), '@studio/providers': p('providers'), '@studio/billing': p('billing') } }, test: { include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'], testTimeout: 60000 } });
