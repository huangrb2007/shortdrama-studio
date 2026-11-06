# Shortdrama Studio

本地优先的 AI 短剧制片工作台。输入一个想法、一部小说或一段视频，按 13 个阶段做出短剧。H3 为主。

- **Skill 驱动：** 改写、分镜、H3 编译的规则都在 `skills/`，换 skill 不用改代码。
- **铁律硬校验：** 台词逐字、每段镜数、时长不等、远景不露脸等，代码级拦截。
- **花钱先确认：** 估价、人工确认、提交台账；状态不明只查询，不重复提交。
- **数据在本机：** 密钥加密存在本机，不进日志。

```bash
pnpm install
pnpm test
pnpm build && pnpm dev:server   # 打开 http://127.0.0.1:4173
```

没有模型密钥时可用 `npx tsx scripts/demo.ts` 走完整流程（假模型、假 ComfyUI，不花钱）。

第三方来源见 [docs/THIRD_PARTY.md](docs/THIRD_PARTY.md)。协议：MIT。
