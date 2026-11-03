/* 草稿箱 + 删卷后 PDF 预览残留 回归测试（合成数据、独立端口，不碰真实卷宗）
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/test_drafts.js */
const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.pdf':'application/pdf'};
function handler(req,res){ let u=decodeURIComponent((req.url||'/').split('?')[0]); if(u==='/'||u==='') u='/阅卷助理.html';
  const fp=path.normalize(path.join(ROOT,u)); if(!fp.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('404');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(d); }); }

app.whenReady().then(async ()=>{
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));   // 每次随机端口 = 全新 IndexedDB，回归不受上次测试草稿影响
  const PORT=server.address().port;
  const win=new BrowserWindow({width:1500,height:950,show:false,webPreferences:{preload:path.join(ROOT,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  const errs=[];
  win.webContents.on('console-message',(e,l,m)=>{ if(l>=2 && !/Security Warning|unsafe-eval/.test(String(m))) errs.push(String(m).slice(0,200)); });
  win.webContents.on('page-error',(e)=>{ errs.push('PAGEERR:'+e.message); });
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2600));

  const b64=fs.readFileSync(path.join(ROOT,'.build','test5.pdf')).toString('base64');
  const out=await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj; if(!z) return {err:'no __zj'};
    var out={}; window.__step='start';
    window.confirm=function(){ return true; };          // 自动化：确认框一律通过
    function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
    function input(id,v){ var el=document.getElementById(id); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
    function clickVol(i){ var el=document.querySelector('#volList [data-v="'+i+'"]'); if(el) el.click(); }
    function badge(){ return document.getElementById('draftCnt').textContent; }
    function dsum(){ return z.drafts().map(function(d){ return { key:d.key, vol:d.volId, p1:d.p1, p2:d.p2, text:d.text, imgs:(d.imgs||[]).length, saved:(d.imgs||[]).map(function(x){return !!x.saved;}) }; }); }
    var st=z.state();
    st.case='草稿箱测试案'; st.vols.length=0; st.trash=[]; st.cur=0;
    st.vols.push({id:'va',name:'第1册 诉讼文书卷',no:'1',offset:0,items:[]});
    st.vols.push({id:'vb',name:'第2册 证据材料卷',no:'2',offset:0,items:[]});
    z.render(); await wait(150);

    window.__step='①type'; /* ① 打字 0.7 秒后自动成草稿 */
    input('fP1','1'); input('fP2','3'); input('fMat','讯问笔录'); input('fText','A卷没提交的正文');
    document.getElementById('fMark').value='【※】';
    document.getElementById('fMark').dispatchEvent(new Event('change',{bubbles:true}));
    await wait(1100);
    out.draftsAfterType=dsum(); out.badgeAfterType=badge();

    window.__step='②shot'; /* ② 加一张还没提交的截图：草稿要连图一起记 */
    var c=document.createElement('canvas'); c.width=60; c.height=80;
    var g=c.getContext('2d'); g.fillStyle='#eef2ff'; g.fillRect(0,0,60,80);
    var blob=await new Promise(function(r){ c.toBlob(r,'image/png'); });
    await z.addShot(blob,2,'test'); await wait(500);
    out.pendingAfterShot=z.pending().length;
    var myDraft=z.drafts().filter(function(d){ return d.volId==='va'; })[0]||{imgs:[]};
    out.draftImgCount=(myDraft.imgs||[]).length;
    var draftImgId=((myDraft.imgs||[])[0]||{}).id;
    out.draftImgInDb=draftImgId?!!(await z.idbGet('imgs',draftImgId)):false;

    window.__step='③switch'; /* ③ 切卷：A 的草稿和图都留着，表单清空 */
    clickVol(1); await wait(600);
    out.afterSwitch={cur:st.cur, p1:document.getElementById('fP1').value, pText:document.getElementById('fText').value,
                     drafts:z.drafts().length, badge:badge(), imgStill:!!(await z.idbGet('imgs',draftImgId))};

    window.__step='④typeB'; /* ② 在 B 卷再写一条 */
    input('fP1','5'); input('fText','B卷没提交的正文'); await wait(1100);
    out.badgeB=badge();

    window.__step='⑤drafts'; /* ④ 打开草稿箱：两条、新的在前 */
    document.getElementById('btnDrafts').click(); await wait(150);
    out.dialogOpen=document.getElementById('dlgDrafts').classList.contains('on');
    out.rows=[].map.call(document.querySelectorAll('#draftList .trash-item'), function(r){ return r.querySelector('b').textContent; });

    window.__step='⑥restore'; /* ⑤ 恢复 A 的那条 */
    var rows=document.querySelectorAll('#draftList .trash-item'), rowA=null;
    for(var i=0;i<rows.length;i++) if(rows[i].textContent.indexOf('第1册')>=0) rowA=rows[i];
    out.foundA=!!rowA;
    if(rowA){ rowA.querySelector('[data-drestore]').click(); await wait(900); }
    out.restored={cur:st.cur, p1:document.getElementById('fP1').value, p2:document.getElementById('fP2').value,
                  mat:document.getElementById('fMat').value, text:document.getElementById('fText').value,
                  mark:document.getElementById('fMark').value, pending:z.pending().length,
                  dialogOpen:document.getElementById('dlgDrafts').classList.contains('on')};

    window.__step='⑦submit'; /* ⑥ 提交 */ 
    document.getElementById('btnAdd').click(); await wait(600);
    out.afterSubmit={items:st.vols[0].items.length,
                     itemImgs:((st.vols[0].items[0]||{}).imgs||[]).length,
                     drafts:z.drafts().length, badge:badge(), pending:z.pending().length,
                     imgInDb:!!(await z.idbGet('imgs',draftImgId))};

    window.__step='⑧editCancel'; /* ⑦ 改一条没保存 */
    await z.editItem(0); await wait(250);
    input('fText','改了但点了取消'); await wait(1100);
    out.editDraft={n:z.drafts().length, key:(z.drafts()[0]||{}).key};
    document.getElementById('btnCancel').click(); await wait(300);
    out.afterCancel={n:z.drafts().length, text:document.getElementById('fText').value};

    window.__step='⑨delDraft'; /* ⑧ 删除 B 的草稿 */
    document.getElementById('btnDrafts').click(); await wait(150);
    var rows2=document.querySelectorAll('#draftList .trash-item'), rowB=null;
    for(var j=0;j<rows2.length;j++) if(rows2[j].textContent.indexOf('第2册')>=0) rowB=rows2[j];
    out.foundB=!!rowB;
    if(rowB){ rowB.querySelector('[data-ddel]').click(); await wait(400); }
    out.afterDeleteDraft={n:z.drafts().length, badge:badge()};
    document.getElementById('draftClose').click(); await wait(100);

    window.__step='⑩delVol'; /* ⑨ 删卷后 PDF 预览必须收掉 */
    function bin(bytes){ var s='',CH=8192; for(var k=0;k<bytes.length;k+=CH) s+=String.fromCharCode.apply(null,bytes.subarray(k,k+CH)); return s; }
    var pdf=atob('${b64}'), bytes=new Uint8Array(pdf.length);
    for(var q=0;q<pdf.length;q++) bytes[q]=pdf.charCodeAt(q);

    st.case='预览测试案'; st.vols.length=0; st.trash=[]; st.cur=0;
    st.vols.push({id:'vp',name:'第1册 预览卷',no:'1',offset:0,items:[]});
    z.render(); await wait(150);
    var r1=await z.openPdfBytes(bytes,'test5.pdf'); await wait(900);
    out.pdfOpen={pages:r1.pages, stage:document.getElementById('pdfStage').style.display,
                 name:document.getElementById('pdfName').textContent, total:document.getElementById('pgTotal').textContent};
    document.querySelector('#volList [data-delv="0"]').click(); await wait(1400);
    out.afterDel={vols:st.vols.length, stage:document.getElementById('pdfStage').style.display,
                  stageHTML:document.getElementById('pdfStage').innerHTML.length,
                  name:document.getElementById('pdfName').textContent,
                  total:document.getElementById('pgTotal').textContent,
                  emptyShown:document.getElementById('pdfEmpty').style.display!=='none'};

    window.__step='⑪import'; /* ⑩ 上传文档替换卷之后 */
    st.vols.push({id:'vp2',name:'第1册 旧预览卷',no:'1',offset:0,items:[]}); st.cur=0; z.render(); await wait(150);
    var r2=await z.openPdfBytes(bytes,'test5.pdf'); await wait(800);
    out.pdfOpen2={pages:r2.pages, stage:document.getElementById('pdfStage').style.display};
    var got={case:'导入替换测试案', vols:[{id:'vi1',name:'第1册 导入卷',no:'1',offset:0,items:[]}], items:0, pics:0, cover:{}};
    await z.applyImport(got,'导入测试.docx'); await wait(1000);
    out.afterImport={vols:st.vols.length, stage:document.getElementById('pdfStage').style.display,
                     stageHTML:document.getElementById('pdfStage').innerHTML.length,
                     name:document.getElementById('pdfName').textContent};
    return out;
  })()`).catch(e=>({evalErr:String(e)}));

  if(out.evalErr){ const step=await win.webContents.executeJavaScript('window.__step').catch(()=>'?'); console.log('EVAL ERR '+out.evalErr+' STEP='+step); }
  console.log(JSON.stringify(out,null,1));
  console.log('ERRS='+JSON.stringify(errs.slice(0,6)));

  /* 第二阶段：重启后草稿还在，并自动恢复上次没写完的内容 */
  const seed=await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj;
    function input(id,v){ var el=document.getElementById(id); el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); }
    input('fP1','12'); input('fP2','14'); input('fMat','到案经过'); input('fText','重启前没提交的正文');
    await new Promise(function(r){ setTimeout(r,1100); });
    return { case:z.state().case, drafts:z.drafts().length, badge:document.getElementById('draftCnt').textContent };
  })()`);
  console.log('SEED='+JSON.stringify(seed));
  await win.webContents.reload();
  await new Promise(r=>setTimeout(r,3600));
  const out2=await win.webContents.executeJavaScript(`(function(){
    var z=window.__zj, st=z.state();
    window.confirm=function(){ return true; };
    var o={ case:st.case, vols:st.vols.length, cur:st.cur,
            p1:document.getElementById('fP1').value, p2:document.getElementById('fP2').value,
            mat:document.getElementById('fMat').value, text:document.getElementById('fText').value,
            badge:document.getElementById('draftCnt').textContent, drafts:z.drafts().length };
    document.getElementById('btnDrafts').click();
    o.dialogOpen=document.getElementById('dlgDrafts').classList.contains('on');
    o.rows=[].map.call(document.querySelectorAll('#draftList .trash-item'), function(r){ return r.querySelector('b').textContent; });
    return o;
  })()`);
  console.log('AFTER_RELOAD='+JSON.stringify(out2));
  win.showInactive();
  await new Promise(r=>setTimeout(r,500));
  const img=await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT,'.build','drafts_ui.png'), img.toPNG());
  console.log('SHOT=.build/drafts_ui.png');
  server.close(); app.quit();
});
