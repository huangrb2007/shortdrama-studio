import { it, expect } from 'vitest';
import { estimate, requestHash, assertTransition } from './index';
const gpu = { kind: 'gpu_hourly' as const, currency: 'CNY', hourly: 3, computeSecondsPerVideoSecond: 15, computeSecondsPerImage: 60, source: '用户', verifiedAt: '2026-11-06' };
it('算力估价：15 秒段 × 15 × 3 元/时', () => { expect(estimate({ model: 'U22', type: 'video', seconds: 15 }, gpu).cost).toBe(0.1875); });
it('MiniMax 官方价：15 秒 + 9 图 = 1.36', () => { expect(estimate({ model: 'H3', type: 'video', seconds: 15, images: 9 }, { kind: 'per_second', currency: 'USD', perSecond: 0.08, freeImages: 5, perExtraImage: 0.04, source: 'x', verifiedAt: 'x' }).cost).toBe(1.36); });
it('价格缺失不瞎估', () => { expect(() => estimate({ model: 'U22', type: 'video', seconds: 15 }, { ...gpu, hourly: undefined })).toThrow(/算力价格/); });
it('请求哈希与键顺序无关，内容变化则变', () => { expect(requestHash({ a: 1, b: [2] })).toBe(requestHash({ b: [2], a: 1 })); expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 })); });
it('状态不明不能回到提交', () => { expect(() => assertTransition('unknown', 'submitting')).toThrow(); expect(() => assertTransition('failed', 'submitting')).toThrow(); assertTransition('unknown', 'submitted'); });
