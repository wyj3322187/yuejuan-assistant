/* UI 改版验证：多分辨率布局 / A4 自适应 / 自定义缩放（合成数据、独立端口）
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/test_ui.js */
const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); const PORT = 19070;
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.pdf':'application/pdf'};
function handler(req,res){ let u=decodeURIComponent((req.url||'/').split('?')[0]); if(u==='/'||u==='') u='/阅卷助理.html';
  const fp=path.normalize(path.join(ROOT,u)); if(!fp.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('404');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(d); }); }

app.whenReady().then(async ()=>{
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(PORT,'127.0.0.1',r));
  const win=new BrowserWindow({width:1366,height:768,show:false,webPreferences:{preload:path.join(ROOT,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  const errs=[];
  win.webContents.on('console-message',(e,l,m)=>{ if(l>=2 && !/Security Warning|unsafe-eval/.test(String(m))) errs.push(String(m).slice(0,200)); });
  win.webContents.on('page-error',(e)=>{ errs.push('PAGEERR:'+e.message); });
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2400));

  const b64=fs.readFileSync(path.join(ROOT,'.build','test5.pdf')).toString('base64');
  const seed=await win.webContents.executeJavaScript(`(async function(){
    var z=window.__zj; if(!z) return {err:'no __zj'};
    window.confirm=function(){ return true; };
    function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
    var st=z.state();
    st.case='某某等人涉嫌诈骗罪案'; st.trash=[]; st.vols.length=0; st.cur=0;

    /* 合成一张“书证扫描件”，只存在这个测试端口下 */
    var c=document.createElement('canvas'); c.width=820; c.height=560;
    var g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,820,560);
    g.strokeStyle='#c9ccd2'; g.lineWidth=2; g.strokeRect(24,24,772,512);
    g.fillStyle='#222'; g.font='bold 26px "Microsoft YaHei"'; g.fillText('XX银行 客户电子回单', 48, 72);
    g.font='16px "Microsoft YaHei"'; g.fillStyle='#444';
    for(var i=0;i<9;i++) g.fillText('交易流水 / 金额 / 日期 ................ '+(10086+i*137), 48, 122+i*36);
    g.fillStyle='#c8302a'; g.font='bold 18px "Microsoft YaHei"'; g.fillText('（测试占位图，非真实案件材料）', 48, 506);
    var blob=await new Promise(function(r){ c.toBlob(r,'image/png'); });
    await z.idbPut('imgs','ui-shot-1',blob);

    var t1='犯罪嫌疑人某某于2023年3月至2024年1月期间，以投资项目为由，先后在本市多处收取被害人钱款，数额巨大。案发后，公安机关依法调取相关书证、电子数据，并对涉案账户进行核查。';
    var t2='问：你上述所说是否属实？\\n答：属实。\\n问：收款后资金去向？\\n答：部分用于经营支出，部分用于归还个人债务。以上笔录我看过，与我所说相符。';
    var t3='2024年2月18日，侦查人员在本市某小区将犯罪嫌疑人某某抓获归案，到案过程中其未反抗，如实供述了主要犯罪事实。';
    var t4='经依法讯问，犯罪嫌疑人对起诉意见书指控的犯罪事实无异议，并自愿认罪认罚。讯问过程同步录音录像，程序合法。';
    var t5='上述书证经辨认，系涉案账户交易明细，能够与被害人陈述、银行流水相互印证，证实涉案资金往来情况。';
    st.vols.push({id:'u1',name:'诉讼文书卷',no:'第十六册',offset:0,pdfName:'test5.pdf',items:[
      {id:'i1',p1:'1',p2:'3',mat:'起诉意见书',mark:'【※】',text:t1,note:'',imgs:[]},
      {id:'i2',p1:'7',p2:'8',mat:'讯问笔录',mark:'',text:t2,note:'',imgs:[]},
      {id:'i3',p1:'12',p2:'12',mat:'到案经过',mark:'【！】',text:t3,note:'',imgs:[]}
    ]});
    st.vols.push({id:'u2',name:'讯问笔录卷',no:'第十七册',offset:0,items:[
      {id:'i4',p1:'137',p2:'140',mat:'讯问笔录（第三次）',mark:'',text:t4,note:'',imgs:[]}
    ]});
    st.vols.push({id:'u3',name:'书证材料卷',no:'第十八册',offset:0,items:[
      {id:'i5',p1:'25',p2:'27',mat:'企业电子回单',mark:'【？】',text:t5,note:'',
       imgs:[{id:'ui-shot-1',w:820,h:560,ext:'png',page:25,full:false}]}
    ]});
    z.render(); await wait(300);

    /* 先打开 PDF，便于同时检查三块预览 */
    var bin=atob('${b64}'), bytes=new Uint8Array(bin.length);
    for(var k=0;k<bin.length;k++) bytes[k]=bin.charCodeAt(k);
    await z.openPdfBytes(bytes,'test5.pdf'); await wait(900);
    document.getElementById('btnThumbs').click(); await wait(700);
    document.getElementById('btnNext').click(); await wait(400);
    z.setA4Mode('all'); z.buildA4(); await wait(1100);
    return {case:st.case, vols:st.vols.length, items:st.vols.reduce(function(a,v){return a+v.items.length;},0),
            pages:document.querySelectorAll('#a4Pages .a4-slot').length,
            pdfPage:z.pageNum()};
  })()`);
  console.log('SEED='+JSON.stringify(seed));

  async function metrics(label){
    return await win.webContents.executeJavaScript(`(function(){
      function box(id){ var el=document.getElementById(id); if(!el) return null; var r=el.getBoundingClientRect();
        return {w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.x)}; }
      function ov(id){ var el=document.getElementById(id); if(!el) return null;
        return {cw:el.clientWidth,sw:el.scrollWidth,ch:el.clientHeight,sh:el.scrollHeight}; }
      var main=document.querySelector('.main'), a4p=document.getElementById('a4Pages');
      var slot=a4p.querySelector('.a4-slot'), page=a4p.querySelector('.a4-page');
      var pdfp=document.querySelector('.pdfpane').getBoundingClientRect();
      return {label:${JSON.stringify(label)}, vw:innerWidth, vh:innerHeight,
        doc:{cw:document.documentElement.clientWidth,sw:document.documentElement.scrollWidth},
        topbar:{cw:document.querySelector('.topbar').clientWidth,sw:document.querySelector('.topbar').scrollWidth},
        side:box('sidebar'), pdf:box('pdfScroll'), pdfpane:{w:Math.round(pdfp.width),x:Math.round(pdfp.x)},
        a4:box('a4Box'), edit:box('editBox'),
        a4bar:{cw:document.querySelector('.a4-bar').clientWidth,sw:document.querySelector('.a4-bar').scrollWidth},
        pdfbar:{cw:document.querySelector('.pdf-bar').clientWidth,sw:document.querySelector('.pdf-bar').scrollWidth},
        epact:{cw:document.querySelector('.ep-act').clientWidth,sw:document.querySelector('.ep-act').scrollWidth},
        a4pages:{cw:a4p.clientWidth,sw:a4p.scrollWidth,ch:a4p.clientHeight,sh:a4p.scrollHeight,ox:getComputedStyle(a4p).overflowX},
        slots:a4p.querySelectorAll('.a4-slot').length,
        slotW:slot?Math.round(slot.getBoundingClientRect().width):0,
        pageW:page?Math.round(page.getBoundingClientRect().width):0,
        zoom:document.getElementById('a4Zoom').textContent,
        pageZoom:document.getElementById('zoomPct').textContent,
        pdfPage:document.getElementById('pgInput').value+' / '+document.getElementById('pgTotal').textContent,
        docmode:main.classList.contains('docmode'),
        dbg:window.__zj.uiDbg()
      };
    })()`);
  }
  function shot(name){
    return win.webContents.capturePage().then(img=>{
      fs.writeFileSync(path.join(ROOT,'.build',name), img.toPNG());
      console.log('SHOT=.build/'+name);
    });
  }

  const out=[];
  win.showInactive();
  for(const [w,h,name] of [[1366,768,'ui_1366.png'],[1440,900,'ui_1440.png'],[1536,864,'ui_1536.png'],[1920,1080,'ui_1920.png'],[2560,1440,'ui_2560.png'],[1100,680,'ui_1100.png']]){
    win.setContentSize(w,h);
    await new Promise(r=>setTimeout(r,1200));
    out.push(await metrics(w+'x'+h));
    await shot(name);
  }

  /* 自定义缩放：1366 下连点 3 次放大 → 页面变宽、出现横向滚动；再点「适应」还原 */
  win.setContentSize(1366,768); await new Promise(r=>setTimeout(r,1200));
  const zoom=await win.webContents.executeJavaScript(`(async function(){
    function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
    var p=document.getElementById('a4Pages');
    var base={label:document.getElementById('a4Zoom').textContent, cw:p.clientWidth, sw:p.scrollWidth,
              ox:getComputedStyle(p).overflowX, align:getComputedStyle(p).alignItems};
    document.getElementById('a4In').click(); await wait(180);
    document.getElementById('a4In').click(); await wait(180);
    document.getElementById('a4In').click(); await wait(250);
    var zin={label:document.getElementById('a4Zoom').textContent, cw:p.clientWidth, sw:p.scrollWidth,
             ox:getComputedStyle(p).overflowX, align:getComputedStyle(p).alignItems, scrollLeft:p.scrollLeft};
    /* Ctrl+滚轮缩小一次 */
    p.dispatchEvent(new WheelEvent('wheel',{deltaY:120,ctrlKey:true,bubbles:true,cancelable:true}));
    await wait(260);
    var wheel={label:document.getElementById('a4Zoom').textContent, cw:p.clientWidth, sw:p.scrollWidth};
    document.getElementById('a4Fit').click(); await wait(300);
    var back={label:document.getElementById('a4Zoom').textContent, cw:p.clientWidth, sw:p.scrollWidth,
              ox:getComputedStyle(p).overflowX, align:getComputedStyle(p).alignItems};
    return {base:base, zoomIn:zin, wheelOut:wheel, fit:back};
  })()`);
  win.showInactive(); await new Promise(r=>setTimeout(r,250));
  await shot('ui_zoom.png');

  /* 弹窗观感：设置 */
  await win.webContents.executeJavaScript(`document.getElementById('btnSet').click();`);
  await new Promise(r=>setTimeout(r,350));
  await shot('ui_dialog.png');
  /* 最小窗口下弹窗：底部按钮必须仍然可见 */
  win.setContentSize(1100,680); await new Promise(r=>setTimeout(r,900));
  await shot('ui_dialog_1100.png');
  await win.webContents.executeJavaScript(`document.getElementById('btnSetClose').click();`);

  console.log('METRICS='+JSON.stringify(out,null,1));
  console.log('ZOOM='+JSON.stringify(zoom,null,1));
  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  server.close(); app.quit();
});
