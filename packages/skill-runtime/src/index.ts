import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import YAML from 'yaml';
import Ajv from 'ajv';

export interface SkillManifest { id: string; version: string; license?: string; stages: string[]; entry: string; output_schema?: string; load?: Record<string, string[]>; validators?: { type: 'script'; run: string; sandbox: 'pyodide'; fail_on: string }[]; overrides?: Record<string, unknown> }
export interface LoadedSkill { manifest: SkillManifest; dir: string; hash: string }
export interface SkillLock { stage: string; skillId: string; version: string; hash: string; model: string; at: string }
export type LLMCall = (r: { system: string; user: string; json: boolean }) => Promise<string>;

function walk(dir: string): string[] { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])).sort(); }
export function hashDir(dir: string) { const h = crypto.createHash('sha256'); for (const f of walk(dir)) { h.update(path.relative(dir, f).replaceAll('\\', '/')); h.update(fs.readFileSync(f)); } return h.digest('hex'); }

export function loadSkill(dir: string): LoadedSkill {
  const file = path.join(dir, 'studio.skill.yaml');
  if (!fs.existsSync(file)) throw new Error(`${dir} 缺少 studio.skill.yaml`);
  const manifest = YAML.parse(fs.readFileSync(file, 'utf8')) as SkillManifest;
  if (!manifest.id || !manifest.version || !manifest.entry || !manifest.stages?.length) throw new Error(`${file} 字段不完整`);
  return { manifest, dir, hash: hashDir(dir) };
}

/** 版本化仓库：每个版本按哈希不可变存放，可启用、换版本、回滚。 */
export class SkillStore {
  constructor(private root: string, private builtinRoot?: string) { fs.mkdirSync(root, { recursive: true }); }
  install(src: string): LoadedSkill {
    const s = loadSkill(src);
    const dest = path.join(this.root, s.manifest.id, `${s.manifest.version}-${s.hash.slice(0, 12)}`);
    if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(src, dest, { recursive: true }); }
    return { ...s, dir: dest };
  }
  versions(id: string): LoadedSkill[] { const d = path.join(this.root, id); return fs.existsSync(d) ? fs.readdirSync(d).map((v) => loadSkill(path.join(d, v))) : []; }
  list(): LoadedSkill[] { return fs.readdirSync(this.root).flatMap((id) => this.versions(id)); }
  get(id: string, hash?: string): LoadedSkill { const vs = this.versions(id); const hit = hash ? vs.find((v) => v.hash === hash) : vs.at(-1); if (!hit) throw new Error(`找不到 skill ${id}${hash ? `@${hash.slice(0, 8)}` : ''}，请先安装`); return hit; }
}

export function buildSystem(stack: LoadedSkill[], stage: string, resolve: (s: LoadedSkill, rel: string) => string = (s, r) => path.resolve(s.dir, r)) {
  const parts: string[] = [];
  for (const s of stack) {
    parts.push(`# Skill: ${s.manifest.id}@${s.manifest.version}\n\n${fs.readFileSync(path.join(s.dir, s.manifest.entry), 'utf8')}`);
    for (const rel of s.manifest.load?.[stage] ?? []) parts.push(`## 参考：${path.basename(rel)}\n\n${fs.readFileSync(resolve(s, rel), 'utf8')}`);
    if (s.manifest.overrides) parts.push(`## 项目覆盖规则（优先于上文）\n${YAML.stringify(s.manifest.overrides)}`);
  }
  return parts.join('\n\n---\n\n');
}

export const validateSchema = (schema: object, data: unknown) => { const ajv = new Ajv({ allErrors: true, strict: false }); const ok = ajv.validate(schema, data); return ok ? [] : (ajv.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`); };
export function parseJson(text: string): any { const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''); try { return JSON.parse(t); } catch { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1)); throw new Error('模型没有返回合法 JSON'); } }

export interface RunResult<T> { output: T; lock: SkillLock[]; attempts: number }
export class StageValidationError extends Error { constructor(public problems: string[], public attempts: number) { super(`校验未通过（已重试 ${attempts - 1} 次）：${problems.slice(0, 5).join('；')}`); } }

/** 校验顺序：JSON Schema → 业务校验（铁律、机检）。不过就带具体问题重写，最多重试 2 次，仍不过就停。 */
export async function runStage<T>(o: { stage: string; stack: LoadedSkill[]; user: string; llm: LLMCall; model: string; validate?: (out: T) => Promise<string[]> | string[]; json?: boolean; maxRetries?: number; now?: () => string }): Promise<RunResult<T>> {
  const system = buildSystem(o.stack, o.stage);
  const lock: SkillLock[] = o.stack.map((s) => ({ stage: o.stage, skillId: s.manifest.id, version: s.manifest.version, hash: s.hash, model: o.model, at: (o.now ?? (() => new Date().toISOString()))() }));
  const schemaOwner = o.stack.find((s) => s.manifest.output_schema);
  const schema = schemaOwner ? JSON.parse(fs.readFileSync(path.join(schemaOwner.dir, schemaOwner.manifest.output_schema!), 'utf8')) : null;
  const max = (o.maxRetries ?? 2) + 1;
  let user = o.user, problems: string[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    const text = await o.llm({ system, user, json: o.json !== false });
    try {
      const out = (o.json === false ? text : parseJson(text)) as T;
      problems = schema ? validateSchema(schema, out) : [];
      if (!problems.length && o.validate) problems = await o.validate(out);
      if (!problems.length) return { output: out, lock, attempts: attempt };
    } catch (e: any) { problems = [e.message]; }
    user = `${o.user}\n\n上一版未通过校验，只修这些问题，其他不要动：\n${problems.map((p) => `- ${p}`).join('\n')}\n\n上一版输出：\n${text}`;
  }
  throw new StageValidationError(problems, max);
}

let py: any;
async function pyodide() { if (!py) { const require = createRequire(import.meta.url ?? __filename); const { loadPyodide } = require('pyodide'); py = await loadPyodide(); } return py; }
/** 在无网络、无本机文件权限的 Pyodide 虚拟文件系统内运行 skill 的校验脚本。 */
export async function runLintSandboxed(scriptPath: string, text: string, duration: number, aspect: string): Promise<{ fail: number; warn: number; items: { level: string; code: string; msg: string }[] }> {
  const p = await pyodide();
  p.FS.writeFile('/tmp/lint.py', fs.readFileSync(scriptPath)); p.FS.writeFile('/tmp/input.txt', text);
  p.globals.set('ARGV', p.toPy(['lint.py', '/tmp/input.txt', '--duration', String(duration), '--aspect', aspect, '--json']));
  const out = await p.runPythonAsync(`
import sys, io, runpy, contextlib
sys.argv = list(ARGV)
_b = io.StringIO()
with contextlib.redirect_stdout(_b):
    try:
        runpy.run_path('/tmp/lint.py', run_name='__main__')
    except SystemExit:
        pass
_b.getvalue()`);
  return JSON.parse(out);
}
