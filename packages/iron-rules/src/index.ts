import type { Cut, Issue, Segment } from '@studio/domain';
export const CHARS_PER_SECOND = 3.3;
export const SPEAKER_CHANGE_GAP = 0.3;
export const MIN_DURATION_SPREAD = 0.5;
const spoken = (t: string) => t.replace(/[\s，。！？、；：,.!?;:“”"'…—\-（）()]/g, '').length;
export const estimateSeconds = (t: string) => spoken(t) / CHARS_PER_SECOND;
const fail = (rule: string, message: string, next_step: string, cutId?: string): Issue => ({ rule, level: 'fail', message, next_step, cutId });
const warn = (rule: string, message: string, next_step: string, cutId?: string): Issue => ({ rule, level: 'warn', message, next_step, cutId });

/** 铁律 2、3、4、6 与 1 的结构部分。这些是代码校验，换 skill 也绕不过。 */
export function validateSegment(seg: Segment): Issue[] {
  const out: Issue[] = [];
  const total = seg.cuts.reduce((s, c) => s + c.duration, 0);
  if (seg.duration > 15) out.push(fail('铁律2', `段时长 ${seg.duration} 秒，超过 15 秒`, '拆成两段'));
  if (Math.abs(total - seg.duration) > 0.01) out.push(fail('铁律2', `cut 时长合计 ${total} 秒，与段时长 ${seg.duration} 秒不一致`, '调整 cut 时长'));
  const [min, max] = seg.is_tail || seg.duration < 15 ? [Math.max(1, Math.round((seg.duration / 15) * 5)), Math.max(1, Math.round((seg.duration / 15) * 6))] : [5, 6];
  if (seg.duration < 15 && !seg.is_tail) out.push(fail('铁律2', `非尾段必须 15 秒，当前 ${seg.duration} 秒`, '补足内容，或标记为尾段'));
  if (seg.cuts.length < min || seg.cuts.length > max) out.push(fail('铁律2', `${seg.duration} 秒段应为 ${min}–${max} 镜，当前 ${seg.cuts.length} 镜`, '合并或拆分 cut'));
  const ds = seg.cuts.map((c) => c.duration);
  if (ds.length > 1 && Math.max(...ds) - Math.min(...ds) < MIN_DURATION_SPREAD) out.push(fail('铁律3', '各镜时长几乎相等，属于等分网格', '按信息量调整时长'));
  let speechEnd = 0, cursor = 0, prev = '';
  seg.cuts.forEach((c, i) => {
    if (c.duration < 2 || c.duration > 5) out.push(fail('分镜结构', `${c.id} 时长 ${c.duration} 秒，cut 应在 2–5 秒`, '调整时长', c.id));
    if (i > 0 && seg.cuts[i - 1].shot_size === c.shot_size && !(c.dialogue?.length && seg.cuts[i - 1].dialogue?.length)) out.push(warn('分镜结构', `${c.id} 与上一镜景别相同`, '换一个景别', c.id));
    if (c.shot_size === 'wide' || c.shot_size === 'extreme_wide') for (const p of c.characters) if (p.facing === 'front' || p.facing === 'three_quarter') out.push(fail('铁律4', `${c.id} 是远景，${p.name} 不能露正脸`, '改为背影、侧影或剪影', c.id));
    if (/[；;]|同时|并且|然后|接着|一边/.test(c.primary_action)) out.push(fail('铁律6', `${c.id} 的动作像是多个动作：“${c.primary_action}”`, '一个 cut 只留一个动作，其余拆开', c.id));
    if (c.characters.length > 2) out.push(fail('分镜结构', `${c.id} 入画 ${c.characters.length} 人，H3 易出分身`, '一镜最多两人', c.id));
    for (const d of c.dialogue ?? []) {
      if (!d.speaker.trim()) out.push(fail('铁律1', `${c.id} 有台词没绑定说话人`, '绑定说话人', c.id));
      if (d.on_screen) {
        const who = c.characters.find((x) => x.name === d.speaker);
        if (!who) out.push(fail('铁律1', `${c.id}：${d.speaker} 标为入画说话，但不在画面里`, '加入画面，或改为画外音', c.id));
        else if (who.lips !== 'speaking') out.push(fail('铁律1', `${c.id}：${d.speaker} 说话时没有标记可见嘴型`, '把嘴型设为“说话”', c.id));
      }
      for (const p of c.characters) if (p.lips === 'speaking' && !(c.dialogue ?? []).some((l) => l.speaker === p.name && l.on_screen)) out.push(fail('铁律1', `${c.id}：${p.name} 没有台词，应闭嘴`, '把嘴型设为“闭嘴”', c.id));
      if (prev && prev !== d.speaker) speechEnd += SPEAKER_CHANGE_GAP;
      prev = d.speaker; speechEnd += estimateSeconds(d.text);
      if (speechEnd > cursor + c.duration + 0.6) out.push(warn('台词铺轨', `${c.id} 的台词预计说到 ${speechEnd.toFixed(1)} 秒，镜头 ${(cursor + c.duration).toFixed(1)} 秒就切走了`, '延长这一镜，或缩短台词', c.id));
    }
    cursor += c.duration;
  });
  const hasLines = seg.cuts.some((c) => c.dialogue?.length);
  if (hasLines && !seg.cuts[0].dialogue?.length) out.push(warn('台词铺轨', 'H3 的音轨从第 0 秒开始铺，第一镜没有台词会让嘴和人对不上', '把第一句台词放进第一镜', seg.cuts[0].id));
  if (speechEnd > seg.duration) out.push(fail('台词铺轨', `台词预计 ${speechEnd.toFixed(1)} 秒，超过段时长`, '把后面的台词移到下一段'));
  return out;
}

export function allLines(seg: Segment) { return seg.cuts.flatMap((c: Cut) => c.dialogue ?? []); }

/** 铁律 1 的文本部分和铁律 5：台词逐字进提示词、每句一次、图槽一致。 */
export function validatePrompt(prompt: string, seg: Segment, slotCount: number): Issue[] {
  const out: Issue[] = [];
  const found = [...prompt.matchAll(/<d>(?:\[[^\]]+\]\s*)?([\s\S]*?)<\/d>/g)].map((m) => m[1].trim());
  const want = allLines(seg).map((l) => l.text.trim());
  want.forEach((w) => { const n = found.filter((f) => f === w).length; if (n !== 1) out.push(fail('铁律1', `台词“${w}”在提示词里出现 ${n} 次，应为逐字 1 次`, '重新编译这一段，台词不许改写')); });
  found.filter((f) => !want.includes(f)).forEach((f) => out.push(fail('铁律1', `提示词多出分镜里没有的台词“${f}”`, '删除，或先改分镜')));
  if (found.join('|') !== want.join('|') && out.length === 0) out.push(fail('铁律1', '台词顺序与分镜不一致', 'H3 按文本顺序铺音轨，必须按分镜顺序写'));
  if (!/while (his|her|their) lips remain completely closed/.test(prompt) && allLines(seg).some((l) => !l.on_screen)) out.push(fail('铁律1', '有画外音，但没有写入画人物闭嘴', '使用画外音公式'));
  for (const m of prompt.matchAll(/<Subject (\d+)>/g)) if (Number(m[1]) > slotCount) out.push(fail('铁律5', `引用了 Subject ${m[1]}，但图槽只有 ${slotCount} 个`, '使用固定图槽表'));
  const shots = [...prompt.matchAll(/\[Shot (\d+)\]/g)].length;
  if (shots !== seg.cuts.length) out.push(fail('铁律2', `提示词有 ${shots} 个 Shot，分镜有 ${seg.cuts.length} 个 cut`, '重新编译'));
  let t = 0; seg.cuts.forEach((c, i) => { if (i > 0) { const mm = String(Math.floor(t / 60)).padStart(2, '0'); const ss = (t % 60).toFixed(3).padStart(6, '0'); if (!prompt.includes(`[Shot ${i + 1}] At ${mm}:${ss}`)) out.push(fail('铁律3', `Shot ${i + 1} 的切点应为 ${mm}:${ss}`, '按分镜时长写切点', c.id)); } t += c.duration; });
  return out;
}

/** 铁律 7：返修必须针对单节点并带真实原因。 */
export function validateRepair(r: { nodeId?: string; reason?: string; scope?: string }): Issue[] {
  const out: Issue[] = [];
  if (!r.nodeId) out.push(fail('铁律7', '返修必须指定具体的段或 cut', '选择要返修的节点'));
  if (!r.reason?.trim()) out.push(fail('铁律7', '返修必须写真实失败原因', '写清哪里错了'));
  if (r.scope === 'episode') out.push(fail('铁律7', '不允许重跑整集', '只返修失败的段'));
  return out;
}
export const hasFail = (xs: Issue[]) => xs.some((i) => i.level === 'fail');
