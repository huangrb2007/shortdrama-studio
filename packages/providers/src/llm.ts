export type LLMKind = 'openai' | 'anthropic' | 'fake';
export interface LLMConfig { id: string; kind: LLMKind; baseUrl: string; model: string; apiKey?: string; vision?: boolean }
export interface LLMRequest { system: string; user: string; json: boolean; images?: { mime: string; base64: string }[] }
export type FetchLike = typeof fetch;
const safeError = async (r: Response, name: string) => { const body = (await r.text()).slice(0, 300); return new Error(`${name} 返回 ${r.status}：${body}。请检查模型名和余额，密钥不会写入日志`); };
export function createLLM(c: LLMConfig, f: FetchLike = fetch) {
  return async (q: LLMRequest): Promise<string> => {
    if (c.kind === 'anthropic') {
      const content: any[] = [...(q.images ?? []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.base64 } })), { type: 'text', text: q.user + (q.json ? '\n\n只输出 JSON，不要任何其他文字。' : '') }];
      const r = await f(`${c.baseUrl.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey ?? '', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: c.model, max_tokens: 8192, system: q.system, messages: [{ role: 'user', content }] }) });
      if (!r.ok) throw await safeError(r, c.id);
      const d: any = await r.json(); return d.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    }
    if (c.kind === 'openai') {
      const user = q.images?.length ? [{ type: 'text', text: q.user }, ...q.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }))] : q.user;
      const r = await f(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey ?? ''}` }, body: JSON.stringify({ model: c.model, messages: [{ role: 'system', content: q.system + (q.json ? '\n\n只输出 JSON。' : '') }, { role: 'user', content: user }] }) });
      if (!r.ok) throw await safeError(r, c.id);
      const d: any = await r.json(); return d.choices[0].message.content;
    }
    throw new Error('未配置可用的模型，请先到设置里添加');
  };
}
export const TASKS = ['creative', 'compile', 'validate', 'vision'] as const;
export type TaskKind = (typeof TASKS)[number];
export const TASK_LABEL: Record<TaskKind, string> = { creative: '写剧本和分镜', compile: 'H3 编译', validate: '校验', vision: '视频反推（需视觉模型）' };
