export const STAGES = [
  { id: 'input', name: '输入解析', hint: '想法、小说或视频' },
  { id: 'brief', name: '立项', hint: '钩子、爽点、预算' },
  { id: 'outline', name: '大纲', hint: '集纲与结构' },
  { id: 'script', name: '剧本', hint: '场次与台词' },
  { id: 'assets', name: '资产提取', hint: '人物、场景、道具' },
  { id: 'storyboard', name: '分镜', hint: '集、段、cut' },
  { id: 'asset_gen', name: '资产生成', hint: '参考图与图槽' },
  { id: 'prompt_compile', name: '提示词', hint: 'H3 六段式' },
  { id: 'video_gen', name: '镜头生成', hint: '估价后提交' },
  { id: 'review', name: '候选复核', hint: '抽帧、听台词、选定' },
  { id: 'rough_cut', name: '粗剪', hint: '合片与字幕' },
  { id: 'qc', name: '质检', hint: '定位到 cut' },
  { id: 'delivery', name: '交付', hint: '成片与工程包' },
] as const;
export type StageId = (typeof STAGES)[number]['id'];
export type StageStatus = 'locked' | 'ready' | 'running' | 'review' | 'failed' | 'frozen' | 'stale';
export const stageIndex = (id: StageId) => STAGES.findIndex((s) => s.id === id);

export type ShotSize = 'extreme_wide' | 'wide' | 'full' | 'medium' | 'medium_close' | 'close' | 'extreme_close';
export const SHOT_LABEL: Record<ShotSize, string> = { extreme_wide: '大远景', wide: '远景', full: '全景', medium: '中景', medium_close: '中近景', close: '近景', extreme_close: '特写' };
export type Facing = 'front' | 'three_quarter' | 'profile' | 'back' | 'silhouette';
export interface DialogueLine { speaker: string; text: string; on_screen: boolean }
export interface CutCharacter { name: string; facing: Facing; lips?: 'speaking' | 'closed' }
export interface Cut { id: string; duration: number; shot_size: ShotSize; camera: string; primary_action: string; audience_gets: string; transition: string; characters: CutCharacter[]; dialogue?: DialogueLine[] }
export interface Segment { id: string; duration: number; space_anchor: string; value_turn: string; entry_state: string; exit_state: string; cuts: Cut[]; is_tail?: boolean }
export interface Storyboard { segments: Segment[] }
export interface Issue { rule: string; level: 'fail' | 'warn'; message: string; next_step: string; cutId?: string }

/** 下游依赖：某阶段重新生成后，这些阶段变为过期，不自动重跑。 */
export function downstream(id: StageId): StageId[] { return STAGES.slice(stageIndex(id) + 1).map((s) => s.id); }
