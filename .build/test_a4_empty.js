/* 删空卷后 A4 预览必须跟着清空：合成数据、随机端口，不碰真实卷宗
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/test_a4_empty.js */
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

  const seed = await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj; if(!z) return {err:'no __zj'};
    window.confirm=function(){ return true; };
    var st=z.state();
    st.case='某某等人涉嫌诈骗罪案'; st.trash=[]; st.cur=0; st.vols.length=0;
    st.vols.push({id:'a4e1',name:'诉讼文书卷',no:'第一册',offset:0,items:[
      {id:'a4e1a',p1:'1',p2:'4',mat:'起诉意见书',mark:'【※】',text:'犯罪嫌疑人某某于2023年3月至2024年1月期间，以投资项目为由收取被害人钱款，数额巨大。',note:'',imgs:[]},
      {id:'a4e1b',p1:'6',p2:'9',mat:'讯问笔录',mark:'',text:'问：你上述所说是否属实？答：属实。',note:'',imgs:[]}
    ]});
    st.vols.push({id:'a4e2',name:'证据材料卷',no:'第二册',offset:0,items:[
      {id:'a4e2a',p1:'25',p2:'27',mat:'企业电子回单',mark:'【？】',text:'上述书证经辨认，系涉案账户交易明细。',note:'',imgs:[]}
    ]});
    document.getElementById('fCase').value=st.case;
    z.render();
    await z.buildA4();
    await new Promise(function(r){ setTimeout(r,120); });
    return {
      vols:st.vols.length,
      slots:document.querySelectorAll('#a4Pages .a4-slot').length,
      allSlots:document.querySelectorAll('.a4-slot').length,
      empty:!!document.querySelector('#a4Pages .empty'),
      plan:!!z.plan()
    };
  })()`);
  console.log('SEED='+JSON.stringify(seed));

  async function snap(){
    return await win.webContents.executeJavaScript(`(function(){
      var p=document.getElementById('a4Pages');
      return {
        vols:window.__zj.state().vols.length,
        slots:document.querySelectorAll('#a4Pages .a4-slot').length,
        allSlots:document.querySelectorAll('.a4-slot').length,
        empty:(p.querySelector('.empty')||{}).textContent||'',
        hasEmpty:!!p.querySelector('.empty'),
        tip:document.getElementById('a4Tip').textContent,
        hint:document.getElementById('a4Hint').textContent,
        plan:!!window.__zj.plan(),
        toolsHidden:document.getElementById('a4Tools').hidden
      };
    })()`);
  }

  /* 删第一本：还剩一本，预览应照常显示剩下的内容 */
  await win.webContents.executeJavaScript(`document.querySelector('[data-delv="0"]').click();`);
  await new Promise(r=>setTimeout(r,1400));
  const after1 = await snap();
  console.log('AFTER_DEL_1='+JSON.stringify(after1));

  /* 删最后一本：A4 必须立刻清空，不能卡着上一本的成品 */
  await win.webContents.executeJavaScript(`document.querySelector('[data-delv="0"]').click();`);
  await new Promise(r=>setTimeout(r,1600));
  const after = await snap();
  console.log('AFTER_DEL_ALL='+JSON.stringify(after));

  win.showInactive();
  await new Promise(r=>setTimeout(r,500));
  const img=await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT,'.build','a4_delete_all.png'), img.toPNG());
  console.log('SHOT=.build/a4_delete_all.png');

  /* 再加一本：空状态要能自动恢复成正常 A4 成品 */
  const recover = await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj, st=z.state();
    st.vols.push({id:'a4e3',name:'补充卷',no:'第三册',offset:0,items:[
      {id:'a4e3a',p1:'1',p2:'2',mat:'情况说明',mark:'',text:'某某案补充情况说明，特此出具。',note:'',imgs:[]}
    ]});
    st.cur=0; z.render(); await z.buildA4();
    return {slots:document.querySelectorAll('#a4Pages .a4-slot').length,
            hasEmpty:!!document.querySelector('#a4Pages .empty'),
            plan:!!z.plan()};
  })()`);
  console.log('RECOVER='+JSON.stringify(recover));

  /* 清空全部数据：同样不能留下旧 A4 */
  await win.webContents.executeJavaScript(`document.getElementById('btnWipe').click();`);
  await new Promise(r=>setTimeout(r,1800));
  console.log('AFTER_WIPE='+JSON.stringify(await snap()));

  const checks = {
    seedShowsA4: seed && seed.slots>0 && seed.allSlots===seed.slots && !seed.empty && seed.plan,
    oneLeftKeepsA4: after1.slots>0 && !after1.hasEmpty && after1.plan && after1.hint==='1 卷 · 1 条',
    deleteAllClears: after.slots===0 && after.allSlots===0 && after.hasEmpty && after.empty.indexOf('选择 PDF')>=0 &&
                     after.tip==='这里会显示 A4 排版成品' && after.hint==='' && !after.plan && after.toolsHidden,
    recoverWorks: recover.slots>0 && !recover.hasEmpty && recover.plan
  };
  console.log('CHECKS='+JSON.stringify(checks));
  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  const ok=checks.seedShowsA4 && checks.oneLeftKeepsA4 && checks.deleteAllClears && checks.recoverWorks && errs.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  server.close(); app.quit();
  setTimeout(()=>process.exit(ok?0:1),300);
});
