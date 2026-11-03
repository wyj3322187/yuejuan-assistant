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
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  saveFile: (name, bytes) => ipcRenderer.invoke('save-file', name, bytes),
  ocr: (base64png) => ipcRenderer.invoke('ocr', base64png),
  dataInfo: () => ipcRenderer.invoke('data-info'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  /* 选进来的 PDF 记住它的磁盘路径，切卷时按路径重新读，不用再选一遍 */
  pathOf: (file) => {
    try { return webUtils.getPathForFile(file) || (file && file.path) || ""; }
    catch (e) { return (file && file.path) || ""; }
  },
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  /* 上传文档：选一份 docx 读进来（补齐封面目录用） */
  pickDocx: () => ipcRenderer.invoke('pick-docx'),
  on: (channel, cb) => {
    const allowed = ['menu-open-pdf', 'menu-export', 'menu-backup', 'menu-toggle', 'menu-import', 'menu-cover'];
    if (allowed.indexOf(channel) < 0) return;
    ipcRenderer.on(channel, () => cb());
  }
});
