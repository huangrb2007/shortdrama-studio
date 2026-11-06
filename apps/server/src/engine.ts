import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { execFile } from 'node:child_process'; import { promisify } from 'node:util';
import { STAGES, downstream, stageIndex, type StageId, type Storyboard, type Issue } from '@studio/domain';
import { validateSegment, validatePrompt, validateRepair, hasFail } from '@studio/iron-rules';
import { SkillStore, loadSkill, runStage, runLintSandboxed, parseJson, type LoadedSkill } from '@studio/skill-runtime';
import { createLLM, ComfyClient, uiToApi, applyBinding, type LLMConfig, type TaskKind, type WorkflowBinding } from '@studio/providers';
import { estimate, requestHash, assertTransition, type RateCard, type LedgerState } from '@studio/billing';
import type { DB, Secrets } from './db';
const exec = promisify(execFile);
export const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const DEFAULT_STACK: Partial<Record<StageId, string[]>> = { input: ['studio-pipeline'], brief: ['studio-pipeline'], outline: ['studio-pipeline'], script: ['studio-pipeline', 'studio-novel-adapter'], assets: ['studio-pipeline'], storyboard: ['studio-storyboard'], prompt_compile: ['studio-h3-compiler'] };
const TASK_OF: Partial<Record<StageId, TaskKind>> = { input: 'creative', brief: 'creative', outline: 'creative', script: 'creative', assets: 'creative', storyboard: 'creative', prompt_compile: 'compile' };
export class UserError extends Error { constructor(msg: string, public next_step: string, public code = 400) { super(msg); } }
export interface Deps { db: DB; secrets: Secrets; dataDir: string; skillsDir: string; emit: (e: any) => void; fetchImpl?: typeof fetch; llmOverride?: (r: { system: string; user: string; json: boolean }) => Promise<string>; ffmpeg?: string }

export class Engine {
  store: SkillStore; lintPath: string;
  constructor(public d: Deps) {
    this.store = new SkillStore(path.join(d.dataDir, 'skills'));
    this.lintPath = path.join(d.skillsDir, 'vendor/forest-laoli-h3/scripts/h3_lint.py');
  }
  // 设置
  getSetting<T>(k: string, def: T): T { const r: any = this.d.db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? JSON.parse(r.value) : def; }
  setSetting(k: string, v: unknown) { this.d.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, JSON.stringify(v)); }
  publicSettings() { const llms: LLMConfig[] = this.getSetting('llms', []); return { llms: llms.map((l) => ({ ...l, apiKey: undefined, hasKey: this.d.secrets.has(`llm:${l.id}`) })), routing: this.getSetting('routing', {}), comfy: this.getSetting('comfy', { baseUrl: '', videoWorkflow: '', imageWorkflow: '' }), rates: this.getSetting('rates', { comfy: { kind: 'gpu_hourly', currency: 'CNY', source: '用户填写', verifiedAt: '' } }), skills: this.skillBindings() }; }
  skillBindings(): Record<string, string[]> { return { ...DEFAULT_STACK, ...this.getSetting('skillBindings', {}) } as any; }
  saveLLM(c: LLMConfig & { apiKey?: string }) { const all: LLMConfig[] = this.getSetting('llms', []); const { apiKey, ...rest } = c; if (apiKey) this.d.secrets.set(`llm:${c.id}`, apiKey); this.setSetting('llms', [...all.filter((x) => x.id !== c.id), rest]); }
  private llmFor(task: TaskKind) {
    if (this.d.llmOverride) return { call: this.d.llmOverride, model: 'test-model', cfg: {} as any };
    const routing: any = this.getSetting('routing', {}); const all: LLMConfig[] = this.getSetting('llms', []);
    const cfg = all.find((l) => l.id === routing[task]) ?? all.find((l) => l.id === routing.creative) ?? all[0];
    if (!cfg) throw new UserError('还没有配置文本模型', '去“设置 → 模型”添加一个模型并填入密钥');
    const call = createLLM({ ...cfg, apiKey: this.d.secrets.get(`llm:${cfg.id}`) }, this.d.fetchImpl);
    return { call: call as any, model: `${cfg.id}/${cfg.model}`, cfg };
  }
  // 项目
  createProject(p: { title: string; input_type: 'idea' | 'novel' | 'video'; input: string; aspect?: string; style?: string; budget_llm?: number; budget_gen?: number; rights_confirmed?: boolean }) {
    if (p.input_type === 'video' && !p.rights_confirmed) throw new UserError('视频反推只能用于你有版权的素材', '确认版权后再继续');
    if (!p.input?.trim()) throw new UserError('输入内容是空的', '填写想法，或上传小说 / 视频');
    const id = uid();
    this.d.db.prepare('INSERT INTO projects(id,title,input_type,input,aspect,style,budget_llm,budget_gen,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, p.title, p.input_type, p.input, p.aspect ?? '9:16', p.style ?? '', p.budget_llm ?? null, p.budget_gen ?? null, now());
    STAGES.forEach((s, i) => this.d.db.prepare('INSERT INTO stages(project_id,stage,status) VALUES(?,?,?)').run(id, s.id, i === 0 ? 'ready' : 'locked'));
    fs.mkdirSync(path.join(this.mediaDir(id)), { recursive: true });
    return this.project(id);
  }
  mediaDir(id: string) { return path.join(this.d.dataDir, 'projects', id, 'media'); }
  listProjects() { return this.d.db.prepare('SELECT id,title,input_type,aspect,created_at FROM projects ORDER BY created_at DESC').all(); }
  project(id: string): any { const p: any = this.d.db.prepare('SELECT * FROM projects WHERE id=?').get(id); if (!p) throw new UserError('项目不存在', '回到项目列表', 404); const stages = this.d.db.prepare('SELECT stage,status,version,error,next_step FROM stages WHERE project_id=?').all(id); return { ...p, stages }; }
  updateProject(id: string, patch: { aspect?: string; style?: string; title?: string; budget_llm?: number; budget_gen?: number }) { for (const k of ['aspect', 'style', 'title', 'budget_llm', 'budget_gen'] as const) if (patch[k] !== undefined) this.d.db.prepare(`UPDATE projects SET ${k}=? WHERE id=?`).run(patch[k] as any, id); return this.project(id); }
  private setStage(pid: string, stage: string, status: string, error?: string | null, next?: string | null) { this.d.db.prepare('UPDATE stages SET status=?,error=?,next_step=? WHERE project_id=? AND stage=?').run(status, error ?? null, next ?? null, pid, stage); this.d.emit({ type: 'stage', projectId: pid, stage, status, error }); }
  artifact(pid: string, stage: string, version?: number): any { const r: any = version ? this.d.db.prepare('SELECT * FROM artifacts WHERE project_id=? AND stage=? AND version=?').get(pid, stage, version) : this.d.db.prepare('SELECT * FROM artifacts WHERE project_id=? AND stage=? ORDER BY version DESC LIMIT 1').get(pid, stage); return r ? { ...r, content: JSON.parse(r.content), skill_lock: r.skill_lock ? JSON.parse(r.skill_lock) : null, issues: r.issues ? JSON.parse(r.issues) : [] } : null; }
  private frozen(pid: string, stage: StageId) { const r: any = this.d.db.prepare('SELECT * FROM artifacts WHERE project_id=? AND stage=? AND frozen=1 ORDER BY version DESC LIMIT 1').get(pid, stage); if (!r) throw new UserError(`“${STAGES[stageIndex(stage)].name}”还没确认`, '先确认上一阶段'); return JSON.parse(r.content); }
  private saveArtifact(pid: string, stage: string, content: unknown, lock: unknown, issues: Issue[] = []) { const v = ((this.d.db.prepare('SELECT MAX(version) v FROM artifacts WHERE project_id=? AND stage=?').get(pid, stage) as any).v ?? 0) + 1; const body = JSON.stringify(content); this.d.db.prepare('INSERT INTO artifacts(id,project_id,stage,version,content,hash,skill_lock,issues,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(uid(), pid, stage, v, body, sha(body), JSON.stringify(lock ?? null), JSON.stringify(issues), now()); this.d.db.prepare('UPDATE stages SET version=? WHERE project_id=? AND stage=?').run(v, pid, stage); return v; }
  installBuiltins() { for (const n of ['studio-pipeline', 'studio-novel-adapter', 'studio-idea-diagnosis', 'studio-storyboard', 'studio-h3-compiler']) { /* 引用 vendor 的相对路径，直接从内置目录加载 */ loadSkill(path.join(this.d.skillsDir, n)); } }
  listSkills() { const entries = fs.readdirSync(this.d.skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'vendor'); return [...entries.map((e) => { const s = loadSkill(path.join(this.d.skillsDir, e.name)); return { id: s.manifest.id, version: s.manifest.version, hash: s.hash, license: s.manifest.license, stages: s.manifest.stages, source: '内置' }; }), ...this.store.list().map((s) => ({ id: s.manifest.id, version: s.manifest.version, hash: s.hash, license: s.manifest.license ?? '未声明，仅本机使用', stages: s.manifest.stages, source: '已安装' }))]; }
  private stack(stage: StageId): LoadedSkill[] { const ids = this.skillBindings()[stage] ?? []; return ids.map((id) => { const b = path.join(this.d.skillsDir, id); return fs.existsSync(b) ? loadSkill(b) : this.store.get(id); }); }
  private budgetGuard(p: any, chars: number, cfg: any) { const inc = ((chars / 2.5) / 1e6) * (cfg?.pricePerMTok ?? 0); if (p.budget_llm != null && p.spent_llm + inc > p.budget_llm) throw new UserError(`文本模型花费将超过项目预算 ${p.budget_llm}`, '提高预算，或换便宜的模型'); return inc; }
  private stageInputs(pid: string, stage: StageId, extra: any = {}) { const p = this.project(pid); const base: any = { stage, project: { title: p.title, aspect: p.aspect, style: p.style } }; switch (stage) { case 'input': return { ...base, input_type: p.input_type, input: p.input, ...extra }; case 'brief': return { ...base, parsed: this.frozen(pid, 'input'), ...extra }; case 'outline': return { ...base, brief: this.frozen(pid, 'brief'), parsed: this.frozen(pid, 'input'), ...extra }; case 'script': return { ...base, outline: this.frozen(pid, 'outline'), source: p.input_type === 'novel' ? p.input : undefined, parsed: this.frozen(pid, 'input'), ...extra }; case 'assets': return { ...base, script: this.frozen(pid, 'script'), ...extra }; case 'storyboard': return { ...base, script: this.frozen(pid, 'script'), bible: this.frozen(pid, 'assets'), ...extra }; default: return { ...base, ...extra }; } }

  /** 跑一个 LLM 阶段。失败停在本阶段，只返修本阶段。 */
  async runStage(pid: string, stage: StageId, opts: { note?: string; images?: any[] } = {}) {
    const st: any = this.d.db.prepare('SELECT status FROM stages WHERE project_id=? AND stage=?').get(pid, stage);
    if (st.status === 'locked') throw new UserError('上一阶段还没确认', '先确认上一阶段');
    if (st.status === 'running') throw new UserError('这个阶段正在运行', '等它完成，不用重复点');
    const task = TASK_OF[stage]; if (!task) throw new UserError('这个阶段不走文本模型', '使用本页的操作按钮');
    this.setStage(pid, stage, 'running');
    try {
      const p = this.project(pid); const { call, model, cfg } = this.llmFor(task);
      const user = JSON.stringify(this.stageInputs(pid, stage, opts.note ? { revision_note: opts.note } : {}));
      const inc = this.budgetGuard(p, user.length, cfg);
      const res = await runStage<any>({ stage, stack: this.stack(stage), user, model, llm: (q) => call({ ...q, images: opts.images }), validate: (o) => this.validateStage(stage, o, pid) });
      this.d.db.prepare('UPDATE projects SET spent_llm=spent_llm+? WHERE id=?').run(inc * res.attempts, pid);
      if (res.output.blockers?.length) { this.saveArtifact(pid, stage, res.output, res.lock); this.setStage(pid, stage, 'failed', `模型报告阻断项：${res.output.blockers.join('；')}`, '按提示修改输入后重跑这一阶段'); return this.artifact(pid, stage); }
      const issues = stage === 'storyboard' ? (res.output as Storyboard).segments.flatMap(validateSegment) : [];
      this.saveArtifact(pid, stage, res.output, res.lock, issues);
      this.setStage(pid, stage, 'review');
      return this.artifact(pid, stage);
    } catch (e: any) { this.setStage(pid, stage, 'failed', e.message, e.next_step ?? '看清原因后只重跑这一阶段，前面的结果都保留'); throw e; }
  }
  private validateStage(stage: StageId, o: any, pid: string): string[] {
    if (stage === 'storyboard') { const segs: any[] = o.segments ?? []; segs.forEach((s, i) => { if (i === segs.length - 1 && s.duration < 15) s.is_tail = true; }); return segs.flatMap((s) => validateSegment(s).filter((i) => i.level === 'fail').map((i) => `${s.id} ${i.rule}：${i.message}（${i.next_step}）`)); }
    if (stage === 'script' && this.project(pid).input_type === 'novel') { const src = this.project(pid).input.replace(/\s/g, ''); return (o.scenes ?? []).flatMap((s: any) => (s.source_quotes ?? []).filter((q: string) => !src.includes(q.replace(/\s/g, ''))).map((q: string) => `原文证据“${q}”在原文里搜不到`)); }
    return [];
  }
  /** 冻结：通过后产物不可变，下游解锁。 */
  freeze(pid: string, stage: StageId) {
    const a = this.artifact(pid, stage); if (!a) throw new UserError('这个阶段还没有产物', '先运行');
    if (stage === 'storyboard') { const fails = (a.content as Storyboard).segments.flatMap(validateSegment).filter((i) => i.level === 'fail'); if (fails.length) throw new UserError(`分镜有 ${fails.length} 项不符合铁律：${fails[0].message}`, fails[0].next_step); }
    this.d.db.prepare('UPDATE artifacts SET frozen=1 WHERE project_id=? AND stage=? AND version=?').run(pid, stage, a.version);
    this.setStage(pid, stage, 'frozen');
    const next = STAGES[stageIndex(stage) + 1]; if (next) { const n: any = this.d.db.prepare('SELECT status FROM stages WHERE project_id=? AND stage=?').get(pid, next.id); if (n.status === 'locked' || n.status === 'stale') this.setStage(pid, next.id, 'ready'); }
    return this.project(pid);
  }
  /** 编辑产物：冻结后改动产生新版本，下游标为过期，不静默覆盖、不自动重跑。 */
  editArtifact(pid: string, stage: StageId, content: unknown) {
    const a = this.artifact(pid, stage); if (!a) throw new UserError('没有可编辑的内容', '先运行这一阶段');
    let issues: Issue[] = []; if (stage === 'storyboard') { const sb = content as Storyboard; issues = sb.segments.flatMap(validateSegment); }
    if (a.frozen) { this.saveArtifact(pid, stage, content, a.skill_lock, issues); this.setStage(pid, stage, 'review'); for (const d of downstream(stage)) { const s: any = this.d.db.prepare('SELECT status FROM stages WHERE project_id=? AND stage=?').get(pid, d); if (s.status !== 'locked') this.setStage(pid, d, 'stale', '上游改过了，这一步的结果可能不再匹配', '确认上游后重新运行这一步'); } }
    else { const body = JSON.stringify(content); this.d.db.prepare('UPDATE artifacts SET content=?,hash=?,issues=? WHERE project_id=? AND stage=? AND version=?').run(body, sha(body), JSON.stringify(issues), pid, stage, a.version); }
    this.d.db.prepare('INSERT INTO commands(project_id,type,payload,inverse,at) VALUES(?,?,?,?,?)').run(pid, `edit:${stage}`, JSON.stringify({ version: a.version + (a.frozen ? 1 : 0) }), JSON.stringify(a.content), now());
    this.d.emit({ type: 'artifact', projectId: pid, stage });
    return this.artifact(pid, stage);
  }
  undo(pid: string) { const c: any = this.d.db.prepare('SELECT * FROM commands WHERE project_id=? AND undone=0 ORDER BY id DESC LIMIT 1').get(pid); if (!c) throw new UserError('没有可撤销的操作', '继续工作即可'); const stage = c.type.split(':')[1]; const body = c.inverse; const a = this.artifact(pid, stage); if (a.frozen) throw new UserError('这个版本已确认，不能撤销', '再次编辑会产生新版本'); this.d.db.prepare('UPDATE artifacts SET content=?,hash=? WHERE project_id=? AND stage=? AND version=?').run(body, sha(body), pid, stage, a.version); this.d.db.prepare('UPDATE commands SET undone=1 WHERE id=?').run(c.id); this.d.emit({ type: 'artifact', projectId: pid, stage }); return this.artifact(pid, stage); }

  /** H3 编译：铁律文本校验 + 沙箱机检，FAIL 不过不进下一步。 */
  async compile(pid: string, segId: string, note?: string) {
    this.setStage(pid, 'prompt_compile', 'running');
    try {
      const p = this.project(pid); const sb: Storyboard = this.frozen(pid, 'storyboard'); const seg = sb.segments.find((s) => s.id === segId); if (!seg) throw new UserError(`没有找到段 ${segId}`, '回到分镜表确认');
      const gen = this.frozen(pid, 'asset_gen'); const bible = this.frozen(pid, 'assets'); const { call, model } = this.llmFor('compile');
      const user = JSON.stringify({ stage: 'prompt_compile', aspect: p.aspect, style: p.style, segment: seg, slots: gen.slots, bible, revision_note: note });
      let report: any = null;
      const res = await runStage<{ prompt: string }>({ stage: 'prompt_compile', stack: this.stack('prompt_compile'), user, model, llm: call, validate: async (o) => { const iron = validatePrompt(o.prompt ?? '', seg, gen.slots.length).filter((i) => i.level === 'fail').map((i) => `${i.rule}：${i.message}`); report = await runLintSandboxed(this.lintPath, o.prompt ?? '', seg.duration, p.aspect); return [...iron, ...report.items.filter((i: any) => i.level === 'FAIL').map((i: any) => `机检 ${i.code}：${i.msg}`)]; } });
      const prev = this.artifact(pid, 'prompt_compile')?.content ?? { prompts: {} };
      const content = { prompts: { ...prev.prompts, [segId]: { prompt: res.output.prompt, lint: { fail: report.fail, warn: report.warn, warnings: report.items.filter((i: any) => i.level === 'WARN') } } } };
      this.saveArtifact(pid, 'prompt_compile', content, res.lock); this.setStage(pid, 'prompt_compile', 'review'); return this.artifact(pid, 'prompt_compile');
    } catch (e: any) { this.setStage(pid, 'prompt_compile', 'failed', e.message, '只重编这一段，分镜和图槽不用动'); throw e; }
  }

  // 付费提交：估价 → 人工确认 → 提交
  private comfy() { const c: any = this.getSetting('comfy', {}); if (!c.baseUrl) throw new UserError('还没有配置 ComfyUI 地址', '去“设置 → 生成通道”填写'); return new ComfyClient(c.baseUrl, this.d.fetchImpl); }
  private rate(): RateCard { return (this.getSetting('rates', {}) as any).comfy; }
  createEstimate(pid: string, r: { kind: 'video' | 'image'; target: string; repair_reason?: string; slot?: number }) {
    const p = this.project(pid); const c: any = this.getSetting('comfy', {});
    let request: any;
    if (r.kind === 'video') {
      const pr = this.frozen(pid, 'prompt_compile').prompts?.[r.target]; if (!pr) throw new UserError('这一段还没有确认的提示词', '先编译并确认');
      const gen = this.frozen(pid, 'asset_gen'); const sb: Storyboard = this.frozen(pid, 'storyboard'); const seg = sb.segments.find((s) => s.id === r.target)!;
      request = { kind: 'video', prompt: pr.prompt, seconds: seg.duration, aspect: p.aspect, images: gen.slots.map((s: any) => s.file_hash), workflow: c.videoWorkflow };
    } else {
      const assets = this.frozen(pid, 'assets'); const item = assetBySlot(assets, r.slot!); request = { kind: 'image', prompt: item.image_prompt, aspect: item.kind === 'character' ? '16:9' : p.aspect, workflow: c.imageWorkflow, slot: r.slot };
    }
    if (r.repair_reason !== undefined) { const v = validateRepair({ nodeId: r.target, reason: r.repair_reason }); if (hasFail(v)) throw new UserError(v[0].message, v[0].next_step); }
    const hash = requestHash(r.repair_reason ? { ...request, repair: r.repair_reason } : request);
    const live: any = this.d.db.prepare("SELECT id,state FROM ledger WHERE project_id=? AND request_hash=? AND state NOT IN ('failed','canceled') ORDER BY created_at DESC LIMIT 1").get(pid, hash);
    if (live) return this.ledger(live.id);
    const est = estimate({ model: request.workflow || '工作流未选', type: r.kind, seconds: request.seconds }, this.rate());
    const id = uid(); this.d.db.prepare('INSERT INTO ledger(id,project_id,kind,target,provider,request,request_hash,estimate,state,repair_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, pid, r.kind, r.target, 'comfy', JSON.stringify(request), hash, JSON.stringify({ ...est, requestHash: hash }), 'estimated', r.repair_reason ?? null, now(), now());
    return this.ledger(id);
  }
  ledger(id: string): any { const r: any = this.d.db.prepare('SELECT * FROM ledger WHERE id=?').get(id); if (!r) throw new UserError('任务不存在', '回到任务列表', 404); const { ticket, ...rest } = r; return { ...rest, estimate: JSON.parse(r.estimate), request: JSON.parse(r.request) }; }
  listLedger(pid: string) { return (this.d.db.prepare('SELECT id FROM ledger WHERE project_id=? ORDER BY created_at DESC').all(pid) as any[]).map((r) => { const l = this.ledger(r.id); return { ...l, request: { kind: l.request.kind, seconds: l.request.seconds } }; }); }
  private move(id: string, to: LedgerState, patch: Record<string, any> = {}) { const cur = this.ledger(id); assertTransition(cur.state, to); const keys = Object.keys(patch); this.d.db.prepare(`UPDATE ledger SET state=?,updated_at=?${keys.map((k) => `,${k}=?`).join('')} WHERE id=?`).run(to, now(), ...keys.map((k) => patch[k]), id); this.d.emit({ type: 'ledger', projectId: cur.project_id, id, state: to }); return this.ledger(id); }
  /** 人工确认。只有界面的确认按钮会调用；票据绑定请求哈希，一次性。 */
  confirm(id: string, actor: string) {
    if (actor !== 'human') throw new UserError('付费确认只能由人点击', '在界面上点确认', 403);
    const l = this.ledger(id); const p = this.project(l.project_id); const spent: any = this.d.db.prepare("SELECT COALESCE(SUM(reserved),0) r, COALESCE(SUM(settled),0) s FROM ledger WHERE project_id=? AND state NOT IN ('failed','canceled','estimated')").get(p.id);
    if (p.budget_gen != null && spent.r + spent.s + l.estimate.cost > p.budget_gen) throw new UserError(`这次会超过生成预算 ${p.budget_gen}`, '提高预算后再确认');
    return this.move(id, 'confirmed', { ticket: `${l.request_hash}:${uid()}`, reserved: l.estimate.cost });
  }
  cancel(id: string) { return this.move(id, 'canceled', { reserved: 0 }); }
  /** 提交一次。先写台账再发请求，崩溃或断网后状态变 unknown，只查询不重提。 */
  async submit(id: string) {
    const r: any = this.d.db.prepare('SELECT ticket,request_hash,state FROM ledger WHERE id=?').get(id);
    if (r?.state !== 'confirmed' || !r.ticket?.startsWith(`${r.request_hash}:`)) throw new UserError('这个任务没有有效的确认', '回到估价卡确认后再提交', 403);
    const l = this.ledger(id); this.move(id, 'submitting', { ticket: null });
    let prompt: any;
    try { prompt = await this.buildPrompt(l); } catch (e: any) { this.move(id, 'failed', { error: e.message, reserved: 0 }); throw new UserError(e.message, e.next_step ?? '修好配置后重新估价'); }
    try {
      const res = await this.comfy().submit(prompt, id);
      if (res.node_errors && Object.keys(res.node_errors).length) return this.move(id, 'failed', { error: `工作流校验失败：${JSON.stringify(res.node_errors).slice(0, 500)}`, reserved: 0 });
      return this.move(id, 'submitted', { provider_ref: res.prompt_id, submitted_at: now() });
    } catch (e: any) {
      if (/返回 4\d\d/.test(e.message)) return this.move(id, 'failed', { error: e.message, reserved: 0 });
      return this.move(id, 'unknown', { error: `提交时断开，不确定云端有没有收到：${e.message}。先去任务列表查询，不要重复提交` });
    }
  }
  private async buildPrompt(l: any) {
    const c: any = this.getSetting('comfy', {}); const client = this.comfy();
    const wfName = l.kind === 'video' ? c.videoWorkflow : c.imageWorkflow; if (!wfName) throw new UserError('还没有选择工作流', '去“设置 → 生成通道”选择');
    const bind: WorkflowBinding | undefined = (this.getSetting('bindings', {}) as any)[wfName] ?? autoBinding(wfName); if (!bind) throw new UserError(`工作流 ${wfName} 还没有绑定输入节点`, '去设置里绑定');
    const wf = await client.readWorkflow(wfName); const info = await client.objectInfo(); const { prompt, problems } = uiToApi(wf, info);
    if (problems.length) throw new UserError(`工作流转换有问题：${problems[0]}`, '检查云端是否缺节点');
    let images: string[] | undefined;
    if (l.kind === 'video') { const gen = this.frozen(l.project_id, 'asset_gen'); images = []; for (const s of gen.slots) { const bytes = fs.readFileSync(path.join(this.mediaDir(l.project_id), s.file)); images.push(await client.upload(`sds_${s.file_hash.slice(0, 16)}${path.extname(s.file)}`, bytes)); } }
    return applyBinding(prompt, bind, { prompt: l.request.prompt, seconds: l.request.seconds, aspect: l.request.aspect, images });
  }
  /** 轮询：只查询，从不重提。 */
  async pollOnce() {
    const rows = this.d.db.prepare("SELECT id FROM ledger WHERE state IN ('submitted','unknown')").all() as any[];
    for (const { id } of rows) {
      const l = this.ledger(id);
      try {
        if (!l.provider_ref) { this.move(id, 'needs_human', { error: '提交时断开，也没拿到任务号，无法查询。去 ComfyUI 看队列和输出；确认没跑再重新估价' }); continue; }
        const s = await this.comfy().state(l.provider_ref);
        if (s.status === 'succeeded') await this.finish(l, s.outputs);
        else if (s.status === 'failed') this.move(id, 'failed', { error: s.error ?? '云端报告失败', reserved: 0 });
        else if (s.status === 'not_found') { if (l.state === 'submitted') this.move(id, 'unknown', { error: '云端查不到这个任务，可能重启过' }); else this.move(id, 'needs_human', { error: '云端查不到这个任务。去 ComfyUI 确认后手动处理，不要直接重提' }); }
        else this.d.emit({ type: 'progress', projectId: l.project_id, id, status: s.status });
      } catch (e: any) { this.d.emit({ type: 'poll_error', id, error: e.message }); }
    }
  }
  private async finish(l: any, outputs: any[]) {
    const media = outputs.find((o) => (l.kind === 'video' ? /\.(mp4|webm|mov)$/i : /\.(png|jpe?g|webp)$/i).test(o.filename)); if (!media) { this.move(l.id, 'failed', { error: '任务完成了，但没找到输出文件', reserved: 0 }); return; }
    const bytes = await this.comfy().download(media); const name = `${l.target.replace(/\W/g, '_')}_${l.id.slice(0, 8)}${path.extname(media.filename)}`; fs.writeFileSync(path.join(this.mediaDir(l.project_id), name), bytes);
    const elapsed = l.submitted_at ? (Date.now() - Date.parse(l.submitted_at)) / 1000 : null;
    const actual = elapsed && (this.rate() as any).hourly ? Math.round((elapsed / 3600) * (this.rate() as any).hourly * 10000) / 10000 : l.estimate.cost;
    this.d.db.prepare('INSERT INTO candidates(id,project_id,target,ledger_id,file,created_at) VALUES(?,?,?,?,?,?)').run(uid(), l.project_id, l.target, l.id, name, now());
    this.move(l.id, 'succeeded', { output: name, reserved: 0, settled: actual });
    if (l.kind === 'video') { this.setStage(l.project_id, 'video_gen', 'review'); const r: any = this.d.db.prepare("SELECT status FROM stages WHERE project_id=? AND stage='review'").get(l.project_id); if (r.status === 'locked' || r.status === 'stale') this.setStage(l.project_id, 'review', 'ready'); }
  }
  candidates(pid: string, target?: string) { return (target ? this.d.db.prepare('SELECT * FROM candidates WHERE project_id=? AND target=? ORDER BY created_at').all(pid, target) : this.d.db.prepare('SELECT * FROM candidates WHERE project_id=? ORDER BY created_at').all(pid)).map((c: any) => ({ ...c, review: c.review ? JSON.parse(c.review) : null })); }
  /** 图槽冻结：把选定的图写进图槽表。 */
  commitSlots(pid: string, choices: Record<string, string>) {
    const assets = this.frozen(pid, 'assets'); const slots = assets.slots.map((s: any) => { const file = choices[String(s.slot)]; if (!file) throw new UserError(`图槽 ${s.slot}（${s.name}）还没有选图`, '生成或上传后选定'); const bytes = fs.readFileSync(path.join(this.mediaDir(pid), path.basename(file))); return { ...s, file: path.basename(file), file_hash: sha(bytes as any) }; });
    if (slots.length > 9) throw new UserError('图槽超过 9 个', '减少资产');
    this.saveArtifact(pid, 'asset_gen', { slots }, null); this.setStage(pid, 'asset_gen', 'review'); return this.artifact(pid, 'asset_gen');
  }
  selectCandidate(pid: string, id: string) { const c: any = this.d.db.prepare('SELECT * FROM candidates WHERE id=? AND project_id=?').get(id, pid); if (!c) throw new UserError('候选不存在', '刷新页面'); this.d.db.prepare('UPDATE candidates SET selected=0 WHERE project_id=? AND target=?').run(pid, c.target); this.d.db.prepare('UPDATE candidates SET selected=1 WHERE id=?').run(id); const sb: Storyboard = this.frozen(pid, 'storyboard'); const chosen = new Set((this.d.db.prepare('SELECT target FROM candidates WHERE project_id=? AND selected=1').all(pid) as any[]).map((x) => x.target)); this.setStage(pid, 'review', 'review'); const next: any = this.d.db.prepare("SELECT status FROM stages WHERE project_id=? AND stage='rough_cut'").get(pid); if (next.status === 'locked') this.setStage(pid, 'rough_cut', 'ready'); if (sb.segments.every((g) => chosen.has(g.id))) { this.setStage(pid, 'video_gen', 'frozen'); this.setStage(pid, 'review', 'frozen'); } return this.candidates(pid, c.target); }
  /** 技术复核：时长、音轨、按 cut 中点抽帧。 */
  async review(pid: string, candidateId: string) {
    const c: any = this.d.db.prepare('SELECT * FROM candidates WHERE id=? AND project_id=?').get(candidateId, pid); if (!c) throw new UserError('候选不存在', '刷新页面');
    const file = path.join(this.mediaDir(pid), c.file); const ff = this.d.ffmpeg ?? 'ffmpeg';
    const info: string = await exec(ff, ['-hide_banner', '-i', file]).then((r) => r.stderr, (e) => e.stderr ?? ''); const dm = /Duration: (\d+):(\d+):([\d.]+)/.exec(info); if (!dm) throw new UserError('读不出视频信息', '确认文件没有损坏'); const duration = Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]); const hasAudio = /Stream #.*Audio:/.test(info);
    const sb: Storyboard = this.frozen(pid, 'storyboard'); const seg = sb.segments.find((s) => s.id === c.target)!; let t = 0; const frames: { cut: string; file: string }[] = [];
    for (const cut of seg.cuts) { const name = `${c.id.slice(0, 8)}_${cut.id}.jpg`; await exec(ff, ['-y', '-ss', String(t + cut.duration / 2), '-i', file, '-frames:v', '1', '-q:v', '3', path.join(this.mediaDir(pid), name)]); frames.push({ cut: cut.id, file: name }); t += cut.duration; }
    const issues: string[] = []; if (Math.abs(duration - seg.duration) > 0.5) issues.push(`时长 ${duration.toFixed(2)} 秒，分镜要求 ${seg.duration} 秒`); if (!hasAudio) issues.push('没有音轨：铁律 1 要求对白原生生成');
    const review = { duration, hasAudio, frames, issues, lines: seg.cuts.flatMap((x) => x.dialogue ?? []).map((l) => l.text), asr: null };
    this.d.db.prepare('UPDATE candidates SET review=? WHERE id=?').run(JSON.stringify(review), c.id); return review;
  }
  /** 启动恢复：提交中途退出的任务一律标为状态不明。 */
  recover() { for (const r of this.d.db.prepare("SELECT id FROM ledger WHERE state='submitting'").all() as any[]) this.move(r.id, 'unknown', { error: '上次退出时正在提交，不确定云端有没有收到。先查询，不要重复提交' }); for (const r of this.d.db.prepare("SELECT project_id,stage FROM stages WHERE status='running'").all() as any[]) this.setStage(r.project_id, r.stage, 'failed', '上次退出时这一步还没跑完', '重新运行这一步'); }
  async ingestNovel(text: string) { const chapters = text.split(/(?=第[0-9一二三四五六七八九十百千]+章)/).map((c) => c.trim()).filter(Boolean); return { chapters: chapters.map((c, i) => ({ index: i + 1, title: c.split('\n')[0].slice(0, 40), chars: c.length })) }; }
  async videoFrames(pid: string, file: string) { const ff = this.d.ffmpeg ?? 'ffmpeg'; const dir = path.join(this.mediaDir(pid), 'reverse'); fs.mkdirSync(dir, { recursive: true }); await exec(ff, ['-y', '-i', file, '-vf', 'fps=1/2,scale=512:-2', '-frames:v', '12', path.join(dir, 'f%02d.jpg')]); return fs.readdirSync(dir).map((f) => ({ mime: 'image/jpeg', base64: fs.readFileSync(path.join(dir, f)).toString('base64') })); }
}
export function assetBySlot(a: any, slot: number) { const s = a.slots.find((x: any) => x.slot === slot); if (!s) throw new UserError(`没有图槽 ${slot}`, '检查资产表'); const pool = s.kind === 'character' ? a.characters : s.kind === 'scene' ? a.scenes : a.props; const item = pool.find((x: any) => x.name === s.name); if (!item) throw new UserError(`图槽 ${slot} 的 ${s.name} 不在 bible 里`, '修改资产表'); return { ...item, kind: s.kind }; }
const ASPECTS: Record<string, string> = { '9:16': '9:16 (Portrait Widescreen)', '16:9': '16:9 (Widescreen)', '3:4': '3:4 (Portrait Standard)', '4:3': '4:3 (Standard)', '1:1': '1:1 (Square)', '21:9': '21:9 (Ultrawide)' };
/** 已核对的工作流绑定。其他工作流在设置里手动绑定。 */
export function autoBinding(name: string): WorkflowBinding | undefined {
  if (/U22.*终极篇/.test(name)) return { promptNode: '403', promptField: 'prompt', secondsNode: '403', secondsField: 'seconds', aspectNode: '403', aspectField: 'aspect_ratio', aspectMap: ASPECTS, imageNodes: Array.from({ length: 9 }, (_, i) => ({ node: '403', field: `ref_image_${i}` })) };
  if (/B18-Qwen-Image-2\.1/.test(name)) return { promptNode: '37', promptField: 'prompt', aspectNode: '42', aspectField: 'aspect_ratio', aspectMap: ASPECTS };
  return undefined;
}
