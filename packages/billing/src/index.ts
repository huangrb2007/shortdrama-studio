import crypto from 'node:crypto';
export interface RateCard { kind: 'gpu_hourly' | 'per_second'; currency: string; hourly?: number; computeSecondsPerVideoSecond?: number; computeSecondsPerImage?: number; perSecond?: number; freeImages?: number; perExtraImage?: number; source: string; verifiedAt: string }
export interface EstimateInput { model: string; type: 'video' | 'image'; seconds?: number; images?: number; count?: number }
export interface Estimate { model: string; seconds: number; cost: number; currency: string; basis: string; requestHash?: string }
const round = (n: number) => Math.round(n * 10000) / 10000;
export function estimate(i: EstimateInput, r: RateCard): Estimate {
  const count = i.count ?? 1, seconds = i.seconds ?? 0;
  if (r.kind === 'gpu_hourly') {
    if (!r.hourly || (i.type === 'video' ? !r.computeSecondsPerVideoSecond : !r.computeSecondsPerImage)) throw new Error('价格表不完整，请在设置里填写算力价格');
    const compute = i.type === 'video' ? seconds * r.computeSecondsPerVideoSecond! : r.computeSecondsPerImage!;
    return { model: i.model, seconds, cost: round((compute / 3600) * r.hourly * count), currency: r.currency, basis: i.type === 'video' ? `预计占用算力 ${Math.round(compute * count)} 秒 × ${r.hourly} ${r.currency}/小时` : `预计占用算力 ${Math.round(compute * count)} 秒 × ${r.hourly} ${r.currency}/小时` };
  }
  const extra = Math.max(0, (i.images ?? 0) - (r.freeImages ?? 0));
  return { model: i.model, seconds, cost: round((seconds * (r.perSecond ?? 0) + extra * (r.perExtraImage ?? 0)) * count), currency: r.currency, basis: `${seconds} 秒 × ${r.perSecond} + 超额图片 ${extra} 张` };
}
export const requestHash = (req: unknown) => crypto.createHash('sha256').update(stable(req)).digest('hex');
function stable(v: any): string { if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`; if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`; return JSON.stringify(v) ?? 'null'; }

/** 提交状态机：只有 ready 状态可以提交。unknown 状态只能查询。 */
export type LedgerState = 'estimated' | 'confirmed' | 'submitting' | 'submitted' | 'unknown' | 'succeeded' | 'failed' | 'needs_human' | 'canceled';
const ALLOWED: Record<LedgerState, LedgerState[]> = { estimated: ['confirmed', 'canceled'], confirmed: ['submitting', 'canceled'], submitting: ['submitted', 'unknown', 'failed'], submitted: ['succeeded', 'failed'], unknown: ['submitted', 'succeeded', 'failed', 'needs_human'], succeeded: [], failed: [], needs_human: ['failed', 'succeeded'], canceled: [] };
export function assertTransition(from: LedgerState, to: LedgerState) { if (!ALLOWED[from].includes(to)) throw new Error(`提交状态不能从 ${from} 变为 ${to}`); }
