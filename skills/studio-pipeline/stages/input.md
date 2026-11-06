# 输入解析
按 `input_type` 处理：
- idea：诊断主角、欲望、阻碍、升级、结果，给 3 个方向。
- novel：逐章提取人物（含年龄）、场景、道具、时间线，每条带 `source_quote`（逐字原文）；提出改编边界：保留什么、改什么、合规上要改什么。
- video：根据抽帧和转写反推剧本草稿，标注哪些是推测。

输出：`{"summary":string,"directions":[{"title","promise","hook_3s","why_must","episode1_cliffhanger","cast_size","scene_count"}],"characters":[{"name","age","evidence"}],"timeline":[string],"adaptation_boundary":{"keep":[string],"change":[string],"compliance":[string]},"blockers":[string],"open_questions":[string]}`。
