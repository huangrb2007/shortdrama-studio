// 走一遍真实界面操作并截图。
const { chromium } = require('playwright'); const fs = require('node:fs');
(async () => {
const base = process.env.BASE ?? 'http://127.0.0.1:4188', out = process.env.OUT ?? 'shots'; fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1360, height: 860 } }); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); pg.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const shot = (n) => pg.screenshot({ path: `${out}/${n}.png` }); const t0 = async (f) => { const a = Date.now(); await f(); return Date.now() - a; };
await pg.goto(base); await pg.waitForSelector('text=项目'); await shot('01-home');
await pg.click('text=新建项目'); await pg.fill('input[placeholder="比如：领证"]', '领证'); await pg.fill('textarea', '一夜之后，陌生美女要求当场领证'); await pg.fill('input[placeholder^="比如：真人"]', '真人都市写实'); await shot('02-new'); await pg.click('button:has-text("创建")');
const stages = ['输入解析', '立项', '大纲', '剧本', '资产提取', '分镜'];
for (const s of stages) { await pg.click(`.st:has-text("${s}")`); await pg.click(`button:has-text("开始${s}")`); await pg.waitForSelector('button:has-text("确认这个版本")'); if (s === '剧本' || s === '资产提取' || s === '分镜') await shot(`03-${s}`); await pg.click('button:has-text("确认这个版本")'); await pg.waitForSelector('button:has-text("已确认")'); }
await pg.click('.st:has-text("资产生成")'); await pg.waitForSelector('.slot'); await pg.locator('.slot button:has-text("生成")').first().click(); await pg.waitForSelector('text=确认后才会提交'); await shot('04-estimate-image'); await pg.click('button:has-text("确认并提交")');
await pg.waitForSelector('.thumbs img', { timeout: 15000 });
for (let i = 0; i < 4; i++) { const slot = pg.locator('.slot').nth(i); if (i > 0) { await slot.locator('button:has-text("生成")').click(); await pg.click('button:has-text("确认并提交")'); await slot.locator('.thumbs img').waitFor({ timeout: 15000 }); } await slot.locator('.thumbs img').first().click(); }
await pg.click('button:has-text("保存图槽表")'); await pg.waitForTimeout(300); await shot('05-slots'); await pg.click('button:has-text("确认图槽")'); await pg.waitForTimeout(200);
await pg.click('.st:has-text("提示词")'); await pg.click('button:has-text("编译这一段")'); await pg.waitForSelector('.prompt', { timeout: 20000 }); await shot('06-prompt'); await pg.click('button:has-text("确认提示词")'); await pg.waitForTimeout(200);
await pg.click('.st:has-text("镜头生成")'); await pg.click('button:has-text("估价并生成")'); await pg.waitForSelector('text=预计费用'); await shot('07-estimate-video'); await pg.click('button:has-text("确认并提交")'); await pg.waitForSelector('.chip.ok:has-text("完成")', { timeout: 15000 }); await shot('08-generated');
await pg.click('.st:has-text("候选复核")'); await pg.waitForSelector('video'); await pg.click('button:has-text("技术复核")'); await pg.waitForSelector('.frames img', { timeout: 20000 }); await pg.click('button:has-text("选定这一条")'); await pg.waitForTimeout(400); await shot('09-review');
const reload = await t0(async () => { await pg.reload(); await pg.waitForSelector('.rail'); }); await pg.click('.st:has-text("分镜")'); await pg.waitForSelector('.sb-r'); const switchMs = await t0(async () => { await pg.click('.st:has-text("剧本")'); await pg.waitForSelector('.script-line'); }); await shot('10-after-reload');
await pg.click('.st:has-text("粗剪")'); await pg.click('button:has-text("合成已选定的段")'); await pg.waitForSelector('video'); await shot('11-rough');
await pg.setViewportSize({ width: 390, height: 800 }); await pg.waitForTimeout(100); await shot('12-mobile');
console.log(JSON.stringify({ errs, reloadMs: reload, stageSwitchMs: switchMs })); await b.close(); if (errs.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
