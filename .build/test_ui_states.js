/* 弹窗与空状态观感检查：合成数据、随机端口，不碰真实卷宗
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/test_ui_states.js */
const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.pdf':'application/pdf'};
function handler(req,res){ let u=decodeURIComponent((req.url||'/').split('?')[0]); if(u==='/'||u==='') u='/阅卷助理.html';
  const fp=path.normalize(path.join(ROOT,u)); if(!fp.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('404');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(d); }); }

app.whenReady().then(async ()=>{
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const PORT=server.address().port;
  const win=new BrowserWindow({width:1440,height:900,show:false,webPreferences:{preload:path.join(ROOT,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  const errs=[];
  win.webContents.on('console-message',(e,l,m)=>{ if(l>=2 && !/Security Warning|unsafe-eval/.test(String(m))) errs.push(String(m).slice(0,200)); });
  win.webContents.on('page-error',(e)=>{ errs.push('PAGEERR:'+e.message); });
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2400));

  await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj; if(!z) return 'no __zj';
    window.confirm=function(){ return true; };
    var st=z.state();
    st.case='某某等人涉嫌诈骗罪案'; st.vols.length=0; st.trash=[]; st.cur=0;
    document.getElementById('fCase').value=st.case;
    st.vols.push({id:'s1',name:'诉讼文书卷',no:'第十六册',offset:0,items:[
      {id:'s1a',p1:'1',p2:'4',mat:'起诉意见书',mark:'【※】',text:'犯罪嫌疑人某某于2023年3月至2024年1月期间，以投资项目为由收取被害人钱款，数额巨大。',note:'',imgs:[]},
      {id:'s1b',p1:'6',p2:'9',mat:'讯问笔录',mark:'',text:'问：你上述所说是否属实？答：属实。',note:'',imgs:[]}
    ]});
    st.vols.push({id:'s2',name:'证据材料卷',no:'第十七册',offset:0,items:[
      {id:'s2a',p1:'25',p2:'27',mat:'企业电子回单',mark:'【？】',text:'上述书证经辨认，系涉案账户交易明细。',note:'',imgs:[]}
    ]});
    st.trash.push({vol:{id:'t1',name:'旧卷（已删）',no:'第十五册',offset:0,items:[{id:'t1a',p1:'1',p2:'2',mat:'旧摘录',mark:'',text:'回收站里的文字',note:'',imgs:[]}]},delAt:Date.now()});
    z.render(); await new Promise(function(r){ setTimeout(r,500); });
    return {case:st.case,vols:st.vols.length};
  })()`);

  function shot(name){
    return win.webContents.capturePage().then(img=>{
      fs.writeFileSync(path.join(ROOT,'.build',name), img.toPNG());
      console.log('SHOT=.build/'+name);
    });
  }

  win.showInactive();
  await new Promise(r=>setTimeout(r,900));
  /* 空 PDF 状态 */
  await shot('ui_empty_pdf.png');

  /* 回收站 */
  await win.webContents.executeJavaScript(`document.getElementById('btnTrash').click();`);
  await new Promise(r=>setTimeout(r,350)); await shot('ui_trash.png');
  await win.webContents.executeJavaScript(`document.getElementById('trashClose').click();`);

  /* 封面/目录 */
  await win.webContents.executeJavaScript(`document.getElementById('btnCoverDlg').click();`);
  await new Promise(r=>setTimeout(r,350)); await shot('ui_cover.png');
  await win.webContents.executeJavaScript(`document.getElementById('cCancel').click();`);

  /* 导出 */
  await win.webContents.executeJavaScript(`document.getElementById('btnExport').click();`);
  await new Promise(r=>setTimeout(r,350)); await shot('ui_export.png');
  await win.webContents.executeJavaScript(`document.getElementById('btnExpClose').click();`);

  /* 草稿箱（空） */
  await win.webContents.executeJavaScript(`document.getElementById('btnDrafts').click();`);
  await new Promise(r=>setTimeout(r,350)); await shot('ui_drafts_empty.png');

  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  server.close(); app.quit();
});
