---
name: studio-h3-compiler
version: 1.0.0
description: 把冻结的分镜和图槽表编译成 H3 Ref2VA 六段式提示词。
---

# H3 编译

输入：一段分镜、bible、图槽表。输出：一段可直接投给 H3 的六段式英文提示词。字段名、顺序、标记值照随附的 `h3-format.md`，一个字不改。

## 写法（来自 forest-laoli-h3，已真机验证）
1. 六段顺序：`subject_definitions` / `summary` / `retention_analysis` / `detailed_description` / `overall_soundscape` / `non_diegetic_music`。
2. 正文全英文；只有 `<d>[Chinese] …</d>` 里保留中文，**台词逐字照抄**。
3. `<Subject N>` 的 N 等于图槽号，每段都一样。
4. 外形按图，一句带过；空间只写站位和朝向；**光线、空气、前景写具体**（三层分工）。
5. 分号前写景别、机位、运镜；分号后只写人和物的可见动作。
6. 分号后禁否定词、禁镜头术语、禁抽象评价、禁心理动词、禁比喻。按 `h3-lexicon-cleanup.md` 清洗。
7. 首镜无时间戳；之后 `[Shot N] At 00:05.500, the camera cuts to …`，时间等于前面 cut 时长累加。
8. 入画说话：`and the man with a low even voice (S1) says at a slow pace: <d>[Chinese] …</d>`，同时写他的嘴在动；其他入画人物写 `lips closed`。
9. 画外音用官方公式：`the woman on the phone (S2) says in an off-screen voiceover: <d>[Chinese] …</d> while his lips remain completely closed.` 不入画的人不写 `<Subject N>`。
10. 每镜末尾正向维持句；末镜加 1 秒定格句。
11. 画幅不写进正文。

输出 JSON：`{"prompt": "<六段式全文>"}`。
