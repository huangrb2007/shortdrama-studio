export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, any>; _meta?: { title?: string } }>;
const VIRTUAL = new Set(['Note', 'MarkdownNote', 'Label (rgthree)', 'Fast Groups Bypasser (rgthree)', 'Fast Groups Muter (rgthree)', 'Bookmark (rgthree)']);
const isPass = (t: string) => t === 'Reroute' || t === 'SetNode' || t === 'GetNode';

function widgetNames(node: any, info: any): string[] {
  const fromUi = (node.inputs ?? []).filter((i: any) => i.widget).map((i: any) => i.widget.name ?? i.name);
  const sec = { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) };
  const order = info?.input_order ? [...(info.input_order.required ?? []), ...(info.input_order.optional ?? [])] : Object.keys(sec);
  const isWidget = (n: string) => { const t = sec[n]?.[0]; return Array.isArray(t) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'].includes(t); };
  const names = order.filter(isWidget);
  return fromUi.length >= names.length ? fromUi : names;
}
const hasControl = (name: string, info: any) => { const sec = { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) }; return name === 'seed' || name === 'noise_seed' || sec[name]?.[1]?.control_after_generate === true; };

/** 把 UI 工作流转成 /prompt 可接受的 API 格式。只在内存里转换，不写回云端。 */
export function uiToApi(wf: any, objectInfo: Record<string, any>): { prompt: ApiPrompt; problems: string[] } {
  const problems: string[] = [];
  const nodes = new Map<number, any>(wf.nodes.map((n: any) => [n.id, n]));
  const links = new Map<number, { from: number; slot: number; type: string }>(wf.links.map((l: any) => (Array.isArray(l) ? [l[0], { from: l[1], slot: l[2], type: l[5] }] : [l.id, { from: l.origin_id, slot: l.origin_slot, type: l.type }])));
  const setters = new Map<string, any>();
  for (const n of wf.nodes) if (n.type === 'SetNode') setters.set(n.widgets_values?.[0], n);
  const resolve = (linkId: number, depth = 0): [string, number] | null => {
    if (depth > 100) return null;
    const l = links.get(linkId); if (!l) return null;
    const src = nodes.get(l.from); if (!src) return null;
    if (src.type === 'Reroute' || src.type === 'SetNode') { const li = src.inputs?.[0]?.link; return li == null ? null : resolve(li, depth + 1); }
    if (src.type === 'GetNode') { const s = setters.get(src.widgets_values?.[0]); const li = s?.inputs?.[0]?.link; return li == null ? null : resolve(li, depth + 1); }
    if (src.mode === 4) { const out = src.outputs?.[l.slot]; const via = (src.inputs ?? []).find((i: any) => i.link != null && i.type === (out?.type ?? l.type)); return via ? resolve(via.link, depth + 1) : null; }
    if (src.mode === 2) return null;
    return [String(src.id), l.slot];
  };
  const prompt: ApiPrompt = {};
  for (const n of wf.nodes) {
    if (VIRTUAL.has(n.type) || isPass(n.type) || n.mode === 2 || n.mode === 4) continue;
    const info = objectInfo[n.type];
    if (!info) { problems.push(`云端缺少节点 ${n.type}（#${n.id}）`); continue; }
    const inputs: Record<string, any> = {};
    const w = n.widgets_values;
    if (w && !Array.isArray(w)) { for (const [k, v] of Object.entries(w)) if (k !== 'videopreview') inputs[k] = v; }
    else if (Array.isArray(w)) {
      let i = 0;
      const sec = { ...(info?.input?.required ?? {}), ...(info?.input?.optional ?? {}) };
      const take = (name: string, spec: any) => {
        if (i >= w.length) return;
        const value = w[i++]; inputs[name] = value;
        if (hasControl(name, info) && ['randomize', 'fixed', 'increment', 'decrement'].includes(w[i])) i++;
        // 动态下拉：所选项自带子控件，API 名为 父名.子名
        if (spec?.[0] === 'COMFY_DYNAMICCOMBO_V3') {
          const opt = (spec[1]?.options ?? []).find((o: any) => o.key === value);
          const sub = { ...(opt?.inputs?.required ?? {}), ...(opt?.inputs?.optional ?? {}) };
          for (const [k, v] of Object.entries(sub)) take(`${name}.${k}`, v);
        }
      };
      for (const name of widgetNames(n, info)) take(name, sec[name]);
    }
    for (const inp of n.inputs ?? []) { if (inp.link == null) continue; const r = resolve(inp.link); if (r) inputs[inp.name] = r; else delete inputs[inp.name]; }
    prompt[String(n.id)] = { class_type: n.type, inputs, _meta: { title: n.title ?? n.type } };
  }
  for (const [id, n] of Object.entries(prompt)) for (const [k, v] of Object.entries(n.inputs)) if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' && !prompt[v[0]]) problems.push(`#${id}.${k} 指向不存在的节点 ${v[0]}`);
  return { prompt, problems };
}

export interface WorkflowBinding { promptNode: string; promptField: string; secondsNode?: string; secondsField?: string; aspectNode?: string; aspectField?: string; aspectMap?: Record<string, string>; imageNodes?: { node: string; field: string }[]; mediaFilesNode?: string; mediaFilesField?: string; outputKinds?: string[] }

/** 只把语义槽写进 API 副本。 */
export function applyBinding(api: ApiPrompt, b: WorkflowBinding, v: { prompt: string; seconds?: number; aspect?: string; images?: string[] }): ApiPrompt {
  const out: ApiPrompt = structuredClone(api);
  const req = (id: string) => { if (!out[id]) throw new Error(`绑定的节点 #${id} 不在工作流里，请重新绑定`); return out[id]; };
  req(b.promptNode).inputs[b.promptField] = v.prompt;
  if (b.secondsNode && v.seconds != null) req(b.secondsNode).inputs[b.secondsField!] = v.seconds;
  if (b.aspectNode && v.aspect) { const mapped = b.aspectMap?.[v.aspect]; if (!mapped) throw new Error(`工作流不支持画幅 ${v.aspect}`); req(b.aspectNode).inputs[b.aspectField!] = mapped; }
  if (v.images) { if (b.mediaFilesNode) req(b.mediaFilesNode).inputs[b.mediaFilesField!] = JSON.stringify(v.images); (b.imageNodes ?? []).forEach((s, i) => { if (v.images![i] != null) req(s.node).inputs[s.field] = v.images![i]; }); }
  for (const n of Object.values(out)) for (const k of ['seed', 'noise_seed']) if (typeof n.inputs[k] === 'number') n.inputs[k] = Math.floor(Math.random() * 2 ** 48);
  return out;
}

export class ComfyClient {
  constructor(private baseUrl: string, private f: typeof fetch = fetch) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  private async json(p: string, init?: RequestInit) { const r = await this.f(this.baseUrl + p, init); if (!r.ok) throw new Error(`ComfyUI ${p} 返回 ${r.status}：${(await r.text()).slice(0, 400)}`); return r.json() as any; }
  stats() { return this.json('/system_stats'); }
  listWorkflows(): Promise<string[]> { return this.json('/api/userdata?dir=workflows&recurse=true&split=false'); }
  readWorkflow(p: string) { return this.json('/api/userdata/' + encodeURIComponent('workflows/' + p)); }
  objectInfo() { return this.json('/object_info'); }
  queue() { return this.json('/queue'); }
  async upload(name: string, bytes: Uint8Array, mime = 'image/png') { const fd = new FormData(); fd.append('image', new Blob([bytes as BlobPart], { type: mime }), name); fd.append('overwrite', 'false'); const d = await this.json('/upload/image', { method: 'POST', body: fd }); return d.subfolder ? `${d.subfolder}/${d.name}` : d.name; }
  submit(prompt: ApiPrompt, clientId: string): Promise<{ prompt_id: string; node_errors?: any }> { return this.json('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }) }); }
  async history(id: string) { const d = await this.json(`/history/${id}`); return d[id] ?? null; }
  async state(id: string): Promise<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found'; outputs: { filename: string; subfolder: string; type: string }[]; error?: string }> {
    const h = await this.history(id);
    if (h) { const ok = h.status?.status_str !== 'error'; const outputs = Object.values<any>(h.outputs ?? {}).flatMap((o) => [...(o.images ?? []), ...(o.gifs ?? []), ...(o.videos ?? [])]); const msg = (h.status?.messages ?? []).find((m: any) => m[0] === 'execution_error')?.[1]; return { status: ok ? 'succeeded' : 'failed', outputs, error: msg ? `${msg.node_type}: ${msg.exception_message}` : undefined }; }
    const q = await this.queue();
    if (q.queue_running?.some((x: any) => x[1] === id)) return { status: 'running', outputs: [] };
    if (q.queue_pending?.some((x: any) => x[1] === id)) return { status: 'queued', outputs: [] };
    return { status: 'not_found', outputs: [] };
  }
  async download(o: { filename: string; subfolder: string; type: string }) { const r = await this.f(`${this.baseUrl}/view?filename=${encodeURIComponent(o.filename)}&subfolder=${encodeURIComponent(o.subfolder)}&type=${o.type}`); if (!r.ok) throw new Error(`下载失败 ${r.status}`); return new Uint8Array(await r.arrayBuffer()); }
}
