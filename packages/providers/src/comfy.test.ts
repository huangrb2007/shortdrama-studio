import { it, expect, describe } from 'vitest';
import { uiToApi, applyBinding, ComfyClient, createLLM } from './index';
const info = { Sampler: { input: { required: { model: ['MODEL'], seed: ['INT', {}], steps: ['INT', {}] } } }, Loader: { input: { required: { name: [['a', 'b']] } } }, Text: { input: { required: { text: ['STRING', {}] } } }, Out: { input: { required: { x: ['IMAGE'] } } } };
const wf = { nodes: [
  { id: 1, type: 'Loader', mode: 0, widgets_values: ['a'], outputs: [{ type: 'MODEL' }] },
  { id: 2, type: 'SetNode', mode: 0, widgets_values: ['M'], inputs: [{ name: 'MODEL', type: 'MODEL', link: 10 }] },
  { id: 3, type: 'GetNode', mode: 0, widgets_values: ['M'] },
  { id: 4, type: 'Reroute', mode: 0, inputs: [{ name: '', type: '*', link: 11 }] },
  { id: 5, type: 'Sampler', mode: 0, widgets_values: [7, 'randomize', 20], inputs: [{ name: 'model', type: 'MODEL', link: 12 }] },
  { id: 6, type: 'Note', mode: 0, widgets_values: ['x'] },
  { id: 7, type: 'Out', mode: 0, inputs: [{ name: 'x', type: 'IMAGE', link: 13 }] },
  { id: 8, type: 'Text', mode: 2, widgets_values: ['muted'] },
  { id: 9, type: 'Text', mode: 0, widgets_values: ['p'] },
], links: [[10, 1, 0, 2, 0, 'MODEL'], [11, 3, 0, 4, 0, 'MODEL'], [12, 4, 0, 5, 0, 'MODEL'], [13, 5, 0, 7, 0, 'IMAGE']] };
describe('ComfyUI', () => {
  it('UI 转 API：穿透 Set/Get/Reroute，跳过注释和静音，种子控制位不错位', () => { const { prompt, problems } = uiToApi(wf, info); expect(problems).toEqual([]); expect(prompt['5'].inputs).toEqual({ seed: 7, steps: 20, model: ['1', 0] }); expect(prompt['7'].inputs.x).toEqual(['5', 0]); expect(prompt['8']).toBeUndefined(); expect(prompt['6']).toBeUndefined(); });
  it('绑定只改语义槽，不动原对象，节点丢失时报错', () => { const { prompt } = uiToApi(wf, info); const a = applyBinding(prompt, { promptNode: '9', promptField: 'text' }, { prompt: '新' }); expect(a['9'].inputs.text).toBe('新'); expect(prompt['9'].inputs.text).toBe('p'); expect(() => applyBinding(prompt, { promptNode: '99', promptField: 't' }, { prompt: 'x' })).toThrow(/重新绑定/); });
  it('查询状态：历史优先，再看队列，都没有是 not_found', async () => { const f = (async (u: string) => new Response(JSON.stringify(String(u).includes('/history') ? {} : { queue_running: [], queue_pending: [[0, 'p1']] }))) as any; const c = new ComfyClient('http://x', f); expect((await c.state('p1')).status).toBe('queued'); expect((await c.state('p2')).status).toBe('not_found'); });
  it('LLM 报错不含密钥', async () => { const f = (async () => new Response('bad', { status: 401 })) as any; await expect(createLLM({ id: 'a', kind: 'openai', baseUrl: 'http://x', model: 'm', apiKey: 'SECRET' }, f)({ system: '', user: '', json: false })).rejects.not.toThrow(/SECRET/); });
});
it('动态下拉的子控件不错位（来自 U22 真实节点结构）', () => {
  const info2 = { Block: { input: { required: { model: ['MODEL'], selection: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'sol-attn', inputs: { required: { density: ['FLOAT', {}] } } }, { key: 'off', inputs: {} }] }], start: ['FLOAT', {}], verbose: ['BOOLEAN', {}] } }, input_order: { required: ['model', 'selection', 'start', 'verbose'] } } };
  const r = uiToApi({ nodes: [{ id: 1, type: 'Block', mode: 0, widgets_values: ['sol-attn', 1.3, 0.2, true], inputs: [{ name: 'selection', widget: { name: 'selection' } }, { name: 'start', widget: { name: 'start' } }, { name: 'verbose', widget: { name: 'verbose' } }] }], links: [] }, info2);
  expect(r.prompt['1'].inputs).toEqual({ selection: 'sol-attn', 'selection.density': 1.3, start: 0.2, verbose: true });
});
