import path from 'node:path'; import crypto from 'node:crypto'; import fs from 'node:fs'; import { buildApp } from './app';
const dataDir = process.env.SDS_DATA_DIR ?? path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const keyFile = path.join(dataDir, '.master');
const masterKey = process.env.SDS_MASTER_KEY ?? (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : (() => { const k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, k, { mode: 0o600 }); return k; })());
(async () => {
const { app } = await buildApp({ dataDir, skillsDir: process.env.SDS_SKILLS_DIR ?? path.resolve('skills'), webDir: process.env.SDS_WEB_DIR ?? path.resolve('apps/web/dist'), masterKey, token: process.env.SDS_TOKEN, ffmpeg: process.env.SDS_FFMPEG });
const port = Number(process.env.SDS_PORT ?? 4173);
const address = await app.listen({ port, host: process.env.SDS_HOST ?? '127.0.0.1' });
console.log(`SDS_READY ${address}`);
(process as any).parentPort?.postMessage({ type: 'ready', address });
})().catch((e) => { console.error(e); process.exit(1); });
