/* 阅卷助理 — 刑事卷宗摘录与 A4 成文工具
 * Copyright (C) 2026 杰森 (GitHub: @wyj3322187)
 *
 * 本程序为自由软件，依据自由软件基金会发布的 GNU General Public License
 * 第 3 版条款（仅限该版本）进行再分发与/或修改。
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;

/* 改名不改数据：老版本（摘卷助手）的摘录都存在 %APPDATA%\zhai-juan 里，
   而 Electron 的用户数据目录是跟着包名走的 —— 包名一改，用户所有卷和摘录都会"消失"。
   所以这里把数据目录钉死在老路径上，界面叫什么名字都不影响已有数据。 */
try { app.setPath('userData', path.join(app.getPath('appData'), 'zhai-juan')); } catch (e) {}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* 本地静态服务：只监听 127.0.0.1，数据不出本机。
   关键：用 http 协议加载页面，pdf.js 的 Worker 才能正常创建
   （file:// 协议下 Worker 会被 Chromium 拦截，导致 PDF 打不开）。 */
let server = null;

/* 固定端口。为什么不用随机端口：
   浏览器/Electron 的 IndexedDB 是按「协议+域名+端口」分库的，
   端口一变就等于换了个新库，之前摘录的数据会全部"消失"。
   所以必须固定端口，保证每次启动都在同一个源上。 */
const PREFERRED_PORTS = [18737, 18738, 18739, 18740, 18741];

function makeHandler() {
  return function (req, res) {
    try {
      let u = decodeURIComponent((req.url || '/').split('?')[0]);
      if (u === '/' || u === '') u = '/阅卷助理.html';
      const fp = path.normalize(path.join(ROOT, u));
      if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        const ext = path.extname(fp).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      });
    } catch (e) { res.writeHead(500); res.end('err'); }
  };
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(makeHandler());
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => { s.removeListener('error', reject); server = s; resolve(port); });
  });
}

async function startServer() {
  for (const p of PREFERRED_PORTS) {
    try { return await listenOn(p); } catch (e) { /* 端口被占，试下一个 */ }
  }
  // 极端情况全部被占：退回随机端口（此时源会变，仅作兜底）
  return await new Promise((resolve, reject) => {
    const s = http.createServer(makeHandler());
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { server = s; resolve(s.address().port); });
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

let win = null;
let appPort = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940,
    minWidth: 1100, minHeight: 680,
    title: '阅卷助理',
    icon: path.join(__dirname, 'app.ico'),
    backgroundColor: '#EDEBE4',
    show: false,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  win.loadURL('http://127.0.0.1:' + appPort + '/?port=' + appPort);
  win.once('ready-to-show', () => { win.show(); win.focus(); });

  win.on('closed', () => { win = null; });

  win.on('close', (e) => {
    if (win && !win.isDestroyed() && global.__allowClose !== true) {
      e.preventDefault();
      dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['直接退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '阅卷助理',
        message: '确定要退出吗？',
        detail: '摘录内容已自动保存到本机，下次打开会自动恢复。'
      }).then(r => {
        if (r.response === 0) { global.__allowClose = true; win.close(); }
      });
    }
  });
}

const menuTemplate = [
  {
    label: '文件',
    submenu: [
      { label: '打开 PDF 电子卷…', accelerator: 'Ctrl+O', click: () => { if (win) win.webContents.send('menu-open-pdf'); } },
      { type: 'separator' },
      { label: '上传 Word 文档（补封面和目录）…', accelerator: 'Ctrl+Shift+O', click: () => { if (win) win.webContents.send('menu-import'); } },
      { label: '封面 / 目录的文字…', click: () => { if (win) win.webContents.send('menu-cover'); } },
      { type: 'separator' },
      { label: '导出文档…', accelerator: 'Ctrl+S', click: () => { if (win) win.webContents.send('menu-export'); } },
      { label: '备份数据…', click: () => { if (win) win.webContents.send('menu-backup'); } },
      { type: 'separator' },
      { label: '退出', accelerator: 'Alt+F4', role: 'quit' }
    ]
  },
  {
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }
    ]
  },
  {
    label: '视图',
    submenu: [
      { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' },
      { label: '实际大小', role: 'resetZoom' },
      { type: 'separator' },
      { label: '全屏', role: 'togglefullscreen' },
      { type: 'separator' },
      { label: '显示/隐藏左侧卷列表', accelerator: 'Ctrl+B', click: () => { if (win) win.webContents.send('menu-toggle'); } }
    ]
  },
  {
    label: '帮助',
    submenu: [
      {
        label: '使用说明', click: () => {
          dialog.showMessageBox({
            type: 'info', title: '使用说明', buttons: ['知道了'],
            message: '阅卷助理',
            detail: '1. 点上方「选择 PDF」选电子卷，自动按文件名建卷（可一次选多本）\n' +
              '2. 中间翻到划线所在页，选中文字复制（Ctrl+C）\n' +
              '3. 右边粘贴（Ctrl+V），点「取当前页」自动带页码\n' +
              '4. 加入本卷后继续下一条\n' +
              '5. 全部摘完点「导出文档」\n\n' +
              '分几次导出的 Word 想合成一份：点「上传文档」选那份 docx，\n' +
              '软件会把正文读回来，自动补上封面和目录；\n' +
              '封面上的字、目录里的标题和备注都能改，改完再导出就是一样的版式。\n\n' +
              '扫描件复制不了时，点「截取本页为图」。\n' +
              '卷宗页码和 PDF 页码对不上时，在「偏移」填差值。'
          });
        }
      },
      {
        label: '关于', click: () => {
          dialog.showMessageBox({
            type: 'info', title: '关于', buttons: ['好'],
            message: '阅卷助理  v' + app.getVersion(),
            detail: '刑事卷宗阅卷摘录工具\n数据全部保存在本机，不上传任何内容。\n\n数据位置：' + app.getPath('userData') +
                    '\n换新版或重装前，把这个文件夹拷走就能带走全部摘录。'
          });
        }
      }
    ]
  }
];

app.whenReady().then(async () => {
  try { appPort = await startServer(); }
  catch (e) { appPort = null; }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { app.quit(); });
app.on('will-quit', () => { if (server) { try { server.close(); } catch (e) {} } });

/* 另存为：桌面版走系统保存对话框，不再丢到浏览器下载目录 */
/* 数据位置：明确告诉用户摘录存在哪个文件夹，并能一键打开 */
ipcMain.handle('data-info', async () => {
  const dir = app.getPath('userData');
  return {
    dir,
    dbDir: path.join(dir, 'IndexedDB', 'http_127.0.0.1_' + appPort + '.indexeddb.leveldb'),
    port: appPort
  };
});
ipcMain.handle('open-data-dir', async () => {
  const dir = app.getPath('userData');
  const err = await shell.openPath(dir);
  return { ok: !err, error: err || '', dir };
});
/* 切卷时按记住的路径重读 PDF，用户不用为每一本再点一次「选择 PDF」 */
ipcMain.handle('read-file', async (e, p) => {
  try {
    if (!p || typeof p !== 'string') return { ok: false, error: '路径为空' };
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return { ok: false, error: '不是文件' };
    if (st.size > 800 * 1024 * 1024) return { ok: false, error: '文件超过 800MB' };
    const buf = await fs.promises.readFile(p);
    return { ok: true, data: buf, size: st.size };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('save-file', async (e, defaultName, bytes) => {  if (!win) return { ok: false };
  const r = await dialog.showSaveDialog(win, {
    title: '导出 Word 文档',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [
      { name: 'Word 文档', extensions: ['docx'] },
      { name: '备份数据', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePath) return { canceled: true };
  try {
    fs.writeFileSync(r.filePath, Buffer.from(bytes));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* 上传文档：选一份 docx 读进来，用来补上封面和目录（只读，不改原文件） */
ipcMain.handle('pick-docx', async () => {
  if (!win) return { ok: false, error: '窗口已关闭' };
  const r = await dialog.showOpenDialog(win, {
    title: '上传 Word 文档（自动补封面和目录）',
    properties: ['openFile'],
    filters: [{ name: 'Word 文档', extensions: ['docx'] }]
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const p = r.filePaths[0];
  try {
    const st = await fs.promises.stat(p);
    if (st.size > 400 * 1024 * 1024) return { ok: false, error: '文件超过 400MB' };
    const buf = await fs.promises.readFile(p);
    return { ok: true, path: p, name: path.basename(p), data: buf };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* OCR：调用 Windows 自带识别引擎（离线、不联网、不上传）。
   传进来的是一张 base64 PNG，写到临时文件后由 ocr.ps1 识别，返回纯文本。 */
ipcMain.handle('ocr', async (e, base64) => {
  let tmp = null;
  try {
    if (!base64 || typeof base64 !== 'string') return { ok: false, error: '没有图像数据' };
    tmp = path.join(app.getPath('temp'), 'zj_ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.png');
    fs.writeFileSync(tmp, Buffer.from(base64, 'base64'));

    const script = path.join(__dirname, 'ocr.ps1');
    if (!fs.existsSync(script)) return { ok: false, error: '缺少 ocr.ps1' };

    const run = await new Promise((resolve) => {
      execFile('powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', tmp],
        { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' })
      );
    });

    if (run.stdout && run.stdout.indexOf('[[OCR_ERR]]') === 0) {
      return { ok: false, error: run.stdout.replace('[[OCR_ERR]]', '').trim() };
    }
    if (run.err) {
      return { ok: false, error: String(run.stdout || run.stderr || run.err.message || run.err).slice(0, 300) };
    }
    return { ok: true, text: run.stdout };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch (e) { } }
  }
});
