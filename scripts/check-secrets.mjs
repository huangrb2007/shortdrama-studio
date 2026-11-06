import { execSync } from 'node:child_process'; import fs from 'node:fs';
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('skills/vendor'));
const bad = [/sk-[A-Za-z0-9]{20,}/, /seetacloud\.com/, /x-api-key['"]?:\s*['"][A-Za-z0-9]{16,}/];
let n = 0; for (const f of files) { if (!fs.existsSync(f)) continue; const t = fs.readFileSync(f, 'utf8'); for (const r of bad) if (r.test(t)) { console.error(`发现疑似敏感内容：${f} ${r}`); n++; } }
if (n) process.exit(1); console.log('未发现密钥或私有地址');
