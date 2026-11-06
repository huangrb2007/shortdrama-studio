# 资产提取
从剧本提取 bible，全片共用一份。资产越少越稳：
- 只有反复出现、或文字描述不准的物件才做道具图。
- 人物服装写具体颜色和款式；换装才算变体，表情和姿势不算。
- 场景写清门窗位置、主要家具，只写单数家具。
- 声音写音高、音色、语速；同性别同场的人要明显不同。

`slots` 是固定图槽表，顺序全片不变，最多 9 个，人物在前，然后场景、道具。

`image_prompt` 生成干净的设定图：人物用多视图（正面、侧面、背面全身加半身），中性站姿、纯灰背景、无文字；场景用无人空镜。人物图必须完整穿着、明显成年。

输出：`{"characters":[{"name","age","appearance","wardrobe","voice","image_prompt"}],"scenes":[{"name","layout","light","image_prompt"}],"props":[{"name","look","image_prompt"}],"slots":[{"slot":1,"kind":"character|scene|prop","name":string}],"blockers":[string]}`。
