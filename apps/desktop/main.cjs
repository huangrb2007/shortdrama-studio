const { app, BrowserWindow, utilityProcess, safeStorage, shell, dialog } = require('electron');
const path = require('node:path'); const fs = require('node:fs'); const crypto = require('node:crypto');
let server, win;
const res = (...p) => (app.isPackaged ? path.join(process.resourcesPath, ...p) : path.resolve(__dirname, '../..', ...p));
function masterKey() { const f = path.join(app.getPath('userData'), 'master.bin'); if (fs.existsSync(f)) { const b = fs.readFileSync(f); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString(); } const k = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(k) : k, { mode: 0o600 }); return k; }
function ffmpegPath() { const p = require('ffmpeg-static'); return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p; }
function startServer() { return new Promise((resolve, reject) => {
  server = utilityProcess.fork(res('dist', 'server', 'main.cjs'), [], { env: { ...process.env, SDS_DATA_DIR: path.join(app.getPath('userData'), 'data'), SDS_MASTER_KEY: masterKey(), SDS_SKILLS_DIR: res('skills'), SDS_WEB_DIR: res('apps', 'web', 'dist'), SDS_PORT: '0', SDS_FFMPEG: ffmpegPath(), NODE_NO_WARNINGS: '1' }, stdio: 'pipe' });
  let err = ''; server.stderr?.on('data', (d) => { err += d; }); server.on('message', (m) => { if (m?.type === 'ready') resolve(m.address); }); server.on('exit', (c) => reject(new Error(`服务启动失败（${c}）：${err.slice(-500)}`))); }); }
app.whenReady().then(async () => {
  try { const address = await startServer(); if (process.env.SDS_SMOKE) { const r = await fetch(address); console.log('SMOKE', r.status, address); app.quit(); return; }
    win = new BrowserWindow({ width: 1360, height: 860, minWidth: 960, minHeight: 600, backgroundColor: '#0e0f12', title: 'Shortdrama Studio', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } }); win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; }); win.loadURL(address);
    if (app.isPackaged) { const { autoUpdater } = require('electron-updater'); autoUpdater.checkForUpdatesAndNotify().catch(() => {}); }
  } catch (e) { dialog.showErrorBox('启动失败', e.message); app.quit(); } });
app.on('window-all-closed', () => app.quit()); app.on('before-quit', () => server?.kill());
