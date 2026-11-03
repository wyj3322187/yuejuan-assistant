/* 左栏底部控件移除后的回归：合成 PDF、随机端口，不碰真实卷宗
   验证：底部“选择 PDF 建卷 / 手填卷名 / 加卷 / 批量”已消失，且用 PDF 建第一本卷仍然可用
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/test_sidebar_clean.js */
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
  const win=new BrowserWindow({width:1100,height:680,show:false,webPreferences:{preload:path.join(ROOT,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  const errs=[];
  win.webContents.on('console-message',(e,l,m)=>{ if(l>=2 && !/Security Warning|unsafe-eval/.test(String(m))) errs.push(String(m).slice(0,200)); });
  win.webContents.on('page-error',(e)=>{ errs.push('PAGEERR:'+e.message); });
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2400));

  const clean = await win.webContents.executeJavaScript(`(function(){
    var st=window.__zj.state();
    return {
      vols:st.vols.length,
      footer:!!document.querySelector('.side-f'),
      pickVol:!!document.getElementById('btnPickVol'),
      addVol:!!document.getElementById('btnAddVol'),
      addVols:!!document.getElementById('btnAddVols'),
      newVol:!!document.getElementById('fNewVol'),
      sideText:document.getElementById('volList').textContent.trim(),
      pdfBig:(document.querySelector('#pdfEmpty .big')||{}).textContent||'',
      fatal:(document.getElementById('fatal').style.display||'none'),
      draftAtBottom:(function(){
        var d=document.getElementById('sideDraft').getBoundingClientRect();
        var s=document.getElementById('sidebar').getBoundingClientRect();
        return Math.round(s.bottom-d.bottom);
      })()
    };
  })()`);
  console.log('CLEAN='+JSON.stringify(clean));

  win.showInactive();
  await new Promise(r=>setTimeout(r,500));
  const img=await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT,'.build','sidebar_clean_1100.png'), img.toPNG());
  console.log('SHOT=.build/sidebar_clean_1100.png');

  /* 用真实的「选择 PDF」入口建第一本卷（不再依赖已删除的手工加卷控件） */
  const imported = await win.webContents.executeJavaScript(`(async function(){
    var resp=await fetch('/.build/test5.pdf');
    var blob=await resp.blob();
    var file=new File([blob],'合成测试卷.pdf',{type:'application/pdf'});
    var dt=new DataTransfer(); dt.items.add(file);
    var input=document.getElementById('filePick');
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(function(r){ setTimeout(r,2200); });
    var st=window.__zj.state();
    var rows=document.querySelectorAll('#volList .vol-item');
    return {
      vols:st.vols.length,
      name:st.vols[0]&&st.vols[0].name,
      pdfName:st.vols[0]&&st.vols[0].pdfName,
      rows:rows.length,
      pdfPages:document.getElementById('pgTotal').textContent,
      pdfVisible:document.getElementById('pdfStage').style.display!=='none'
    };
  })()`);
  console.log('IMPORTED='+JSON.stringify(imported));

  const checks={
    footerGone: !clean.footer && !clean.pickVol && !clean.addVol && !clean.addVols && !clean.newVol,
    hintsUpdated: clean.sideText.indexOf('点「选择 PDF」建卷')>=0 && clean.pdfBig.indexOf('选择 PDF')>=0,
    fatalHidden: clean.fatal==='none',
    draftNearBottom: clean.draftAtBottom>=0 && clean.draftAtBottom<40,
    pdfCreatesFirstVolume: imported.vols===1 && imported.rows===1 && imported.name==='合成测试卷.pdf' && imported.pdfName==='合成测试卷.pdf' && imported.pdfPages==='/ 5' && imported.pdfVisible
  };
  console.log('CHECKS='+JSON.stringify(checks));
  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  const ok=checks.footerGone && checks.hintsUpdated && checks.fatalHidden && checks.draftNearBottom && checks.pdfCreatesFirstVolume && errs.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  server.close(); app.quit();
  setTimeout(()=>process.exit(ok?0:1),300);
});
