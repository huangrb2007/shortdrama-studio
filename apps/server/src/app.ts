import Fastify from 'fastify'; import websocket from '@fastify/websocket'; import fstatic from '@fastify/static';
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { openDb, Secrets } from './db'; import { Engine, UserError, uid } from './engine';
import { ComfyClient } from '@studio/providers';
const exec = promisify(execFile);
export interface AppOptions { dataDir: string; skillsDir: string; webDir?: string; masterKey: string; port?: number; host?: string; token?: string; ffmpeg?: string; llmOverride?: any; fetchImpl?: typeof fetch }
export async function buildApp(o: AppOptions) {
  const db = openDb(o.dataDir); const clients = new Set<any>();
  const engine = new Engine({ db, secrets: new Secrets(db, o.masterKey), dataDir: o.dataDir, skillsDir: o.skillsDir, ffmpeg: o.ffmpeg, llmOverride: o.llmOverride, fetchImpl: o.fetchImpl, emit: (e) => { const s = JSON.stringify(e); for (const c of clients) try { c.send(s); } catch { clients.delete(c); } } });
  engine.recover();
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  const token = o.token ?? crypto.randomBytes(24).toString('hex');
  app.addContentTypeParser('application/octet-stream', (_r, p, done) => done(null, p));
  await app.register(websocket);
  app.addHook('onRequest', async (req, rep) => { if (!req.url.startsWith('/api/') && !req.url.startsWith('/media/')) return; const c = /(?:^|;\s*)sds=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]; if (c !== token) { rep.code(401).send({ error: '会话已失效', next_step: '刷新页面' }); } });
  app.setErrorHandler((e: any, _r, rep) => { const code = e instanceof UserError ? e.code : 500; rep.code(code).send({ error: e.message, next_step: e.next_step ?? '看清原因后只重试这一步，已确认的结果不受影响' }); });
  const P = (r: any) => r.params as any, B = (r: any) => r.body as any;
  app.get('/api/ws', { websocket: true }, (socket) => { clients.add(socket); socket.on('close', () => clients.delete(socket)); });
  app.get('/api/settings', () => engine.publicSettings());
  app.post('/api/settings/llm', (r) => { engine.saveLLM(B(r)); return engine.publicSettings(); });
  app.delete('/api/settings/llm/:id', (r) => { engine.setSetting('llms', engine.getSetting<any[]>('llms', []).filter((l) => l.id !== P(r).id)); return engine.publicSettings(); });
  app.post('/api/settings/:key', (r) => { const k = P(r).key; if (!['routing', 'comfy', 'rates', 'skillBindings', 'bindings'].includes(k)) throw new UserError('不支持的设置', '刷新页面'); engine.setSetting(k, B(r)); return engine.publicSettings(); });
  app.get('/api/comfy/test', async () => { const c: any = engine.getSetting('comfy', {}); if (!c.baseUrl) throw new UserError('还没填 ComfyUI 地址', '先填写地址'); const cl = new ComfyClient(c.baseUrl, o.fetchImpl); try { const [s, w] = await Promise.all([cl.stats(), cl.listWorkflows()]); return { ok: true, version: s.system?.comfyui_version, workflows: w }; } catch (e: any) { throw new UserError(`连不上 ComfyUI：${e.message}`, '确认云端实例开着，地址没变'); } });
  app.get('/api/skills', () => engine.listSkills());
  app.post('/api/skills/install', (r) => { const s = engine.store.install(B(r).path); return { id: s.manifest.id, version: s.manifest.version, hash: s.hash }; });
  app.get('/api/projects', () => engine.listProjects());
  app.post('/api/projects', (r) => engine.createProject(B(r)));
  app.get('/api/projects/:id', (r) => engine.project(P(r).id));
  app.patch('/api/projects/:id', (r) => engine.updateProject(P(r).id, B(r)));
  app.get('/api/projects/:id/artifacts/:stage', (r) => engine.artifact(P(r).id, P(r).stage) ?? null);
  app.put('/api/projects/:id/artifacts/:stage', (r) => engine.editArtifact(P(r).id, P(r).stage, B(r)));
  app.post('/api/projects/:id/undo', (r) => engine.undo(P(r).id));
  app.post('/api/projects/:id/stages/:stage/run', async (r) => { const p = engine.project(P(r).id); const opts: any = { note: B(r)?.note }; if (P(r).stage === 'input' && p.input_type === 'video') opts.images = await engine.videoFrames(p.id, p.input); return engine.runStage(p.id, P(r).stage, opts); });
  app.post('/api/projects/:id/stages/:stage/freeze', (r) => engine.freeze(P(r).id, P(r).stage));
  app.post('/api/projects/:id/compile', (r) => engine.compile(P(r).id, B(r).segment, B(r).note));
  app.post('/api/projects/:id/slots', (r) => engine.commitSlots(P(r).id, B(r)));
  app.post('/api/projects/:id/estimates', (r) => engine.createEstimate(P(r).id, B(r)));
  app.get('/api/projects/:id/ledger', (r) => engine.listLedger(P(r).id));
  app.get('/api/projects/:id/candidates', (r) => engine.candidates(P(r).id));
  app.post('/api/projects/:id/candidates/:cid/select', (r) => engine.selectCandidate(P(r).id, P(r).cid));
  app.post('/api/projects/:id/candidates/:cid/review', (r) => engine.review(P(r).id, P(r).cid));
  // 确认和提交只开放给界面会话；智能体工具不经过这里（actor 固定由路由写死为 human，智能体走自己的入口时为 agent）。
  app.post('/api/ledger/:id/confirm', async (r) => { engine.confirm(P(r).id, 'human'); return engine.submit(P(r).id); });
  app.post('/api/ledger/:id/cancel', (r) => engine.cancel(P(r).id));
  app.post('/api/projects/:id/rough-cut', async (r) => { const pid = P(r).id; const sb = engine.artifact(pid, 'storyboard')?.content; const cs = engine.candidates(pid); const files = (sb?.segments ?? []).map((s: any) => cs.find((c: any) => c.target === s.id && c.selected)).filter(Boolean); if (!files.length) throw new UserError('还没有选定任何视频', '先在候选复核里选定'); const dir = path.join(o.dataDir, 'projects', pid, 'exports'); fs.mkdirSync(dir, { recursive: true }); const list = path.join(dir, 'list.txt'); fs.writeFileSync(list, files.map((c: any) => `file '${path.join(engine.mediaDir(pid), c.file).replaceAll("'", "'\\''")}'`).join('\n')); const out = path.join(engine.mediaDir(pid), `rough_${Date.now()}.mp4`); await exec(o.ffmpeg ?? 'ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]); return { file: path.basename(out), segments: files.length, missing: (sb?.segments?.length ?? 0) - files.length }; });
  app.put('/api/projects/:id/upload', async (r: any) => { const name = `${uid().slice(0, 8)}_${path.basename(String(r.query.name ?? 'file')).replace(/[^\w.\u4e00-\u9fa5-]/g, '_')}`; const dest = path.join(engine.mediaDir(P(r).id), name); await pipeline(r.body, fs.createWriteStream(dest)); return { file: name }; });
  app.put('/api/upload-source', async (r: any) => { const dir = path.join(o.dataDir, 'sources'); fs.mkdirSync(dir, { recursive: true }); const name = `${uid().slice(0, 8)}_${path.basename(String(r.query.name ?? 'file')).replace(/[^\w.\u4e00-\u9fa5-]/g, '_')}`; const dest = path.join(dir, name); await pipeline(r.body, fs.createWriteStream(dest)); if (/\.epub$/i.test(name)) return { path: dest, text: await readEpub(dest) }; return { path: dest }; });
  app.get('/media/:id/:file', async (r, rep) => { const f = path.join(engine.mediaDir(P(r).id), path.basename(P(r).file)); if (!fs.existsSync(f)) return rep.code(404).send({ error: '文件不存在' }); const ext = path.extname(f).toLowerCase(); rep.type(ext === '.mp4' ? 'video/mp4' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : 'application/octet-stream'); return rep.send(fs.createReadStream(f)); });
  if (o.webDir && fs.existsSync(o.webDir)) { await app.register(fstatic, { root: o.webDir, setHeaders: (res) => res.setHeader('set-cookie', `sds=${token}; HttpOnly; SameSite=Strict; Path=/`) }); app.setNotFoundHandler((_r, rep) => rep.header('set-cookie', `sds=${token}; HttpOnly; SameSite=Strict; Path=/`).sendFile('index.html')); }
  const timer = setInterval(() => void engine.pollOnce().catch(() => {}), 3000); app.addHook('onClose', async () => clearInterval(timer));
  return { app, engine, token };
}
export async function readEpub(file: string) { const mod: any = await import('epub2'); const EPub = mod.EPub ?? mod.default?.EPub ?? mod.default; const book = await EPub.createAsync(file); const parts: string[] = []; for (const c of book.flow) { const html = await book.getChapterRawAsync(c.id); parts.push(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<\/(p|div|h\d|br)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()); } return parts.filter(Boolean).join('\n\n'); }
