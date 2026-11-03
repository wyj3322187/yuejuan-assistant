/* 打包目录里的资源是否真的渲染成素颜配色：serve release/.../resources/app，合成数据 + 随机端口，不碰真实卷宗
   用法：env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe --no-sandbox --disable-gpu .build/verify_release_ui.js */
const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..', 'release', '阅卷助理-win32-x64', 'resources', 'app');
const PDF = path.join(__dirname, 'test5.pdf');
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.pdf':'application/pdf','.wasm':'application/wasm'};
function handler(req,res){
  const u=decodeURIComponent((req.url||'/').split('?')[0]);
  if(u==='/.build/test5.pdf'){ res.writeHead(200,{'Content-Type':'application/pdf'}); res.end(fs.readFileSync(PDF)); return; }
  let p=u; if(p==='/'||p==='') p='/阅卷助理.html';
  const fp=path.normalize(path.join(ROOT,p));
  if(!fp.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('404');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(d); });
}

const SEED = `(async function(){
  var z=window.__zj, st=z.state();
  st.case='某某等人涉嫌诈骗罪案'; st.trash=[]; st.cur=0; st.vols.length=0;
  st.vols.push({id:'rl1',name:'诉讼文书卷',no:'第十六册',offset:0,items:[
    {id:'rl1a',p1:'1',p2:'3',mat:'起诉意见书',mark:'【※】',text:'犯罪嫌疑人某某，男，1985年3月生，因涉嫌诈骗罪于2023年6月被刑事拘留。',note:'',imgs:[]},
    {id:'rl1b',p1:'5',p2:'5',mat:'讯问笔录',mark:'',text:'问：你上述所说是否属实？答：属实。',note:'',imgs:[]}
  ]});
  st.vols.push({id:'rl2',name:'讯问笔录卷',no:'第十七册',offset:0,items:[
    {id:'rl2a',p1:'2',p2:'4',mat:'讯问笔录',mark:'',text:'问：你是否申请回避？答：不申请。',note:'',imgs:[]}
  ]});
  document.getElementById('fCase').value=st.case;
  z.render();
  var resp=await fetch('/.build/test5.pdf');
  var blob=await resp.blob();
  var file=new File([blob],'诉讼文书卷.pdf',{type:'application/pdf'});
  var dt=new DataTransfer(); dt.items.add(file);
  var input=document.getElementById('filePick');
  input.files=dt.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(function(r){ setTimeout(r,2600); });
  await z.buildA4();
  await new Promise(function(r){ setTimeout(r,400); });
  return {vols:z.state().vols.length, slots:document.querySelectorAll('#a4Pages .a4-slot').length,
          pdfPages:document.getElementById('pgTotal').textContent};
})()`;

async function shoot(PORT, w, h, out, errs){
  const win=new BrowserWindow({width:w,height:h,show:false,webPreferences:{preload:path.join(ROOT,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(e,l,m)=>{ if(l>=2 && !/Security Warning|unsafe-eval/.test(String(m))) errs.push(String(m).slice(0,200)); });
  win.webContents.on('page-error',(e)=>{ errs.push('PAGEERR:'+e.message); });
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2200));
  const seeded=await win.webContents.executeJavaScript(SEED);
  await new Promise(r=>setTimeout(r,1000));
  const look = await win.webContents.executeJavaScript(`(function(){
    var g=function(s){ return getComputedStyle(document.querySelector(s)); };
    var bodyBg=g('body').backgroundColor, top=g('.topbar').backgroundColor;
    var solid=document.querySelector('.tbtn.solid');
    var a4=document.querySelector('.a4-pane');
    var on=document.querySelector('.vol-item.on');
    var bodyH=document.querySelector('.a4-body')?getComputedStyle(document.querySelector('.a4-body')).height:'';
    return {
      bodyBg:bodyBg, topbarBg:top,
      solidBg: solid?g('.tbtn.solid').backgroundColor:'',
      solidFg: solid?g('.tbtn.solid').color:'',
      a4Bg: a4?g('.a4-pane').backgroundColor:'',
      onBar: on?g('.vol-item.on').boxShadow:'',
      a4BodyHeight: bodyH,
      themeBlock: !!document.getElementById('theme-plain'),
      brand: document.querySelector('.brand-txt b')?document.querySelector('.brand-txt b').textContent:''
    };
  })()`);
  win.showInactive();
  await new Promise(r=>setTimeout(r,600));
  const img=await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname,out), img.toPNG());
  console.log(out+' @'+w+'x'+h+' SEED='+JSON.stringify(seeded));
  console.log(out+' LOOK='+JSON.stringify(look));
  win.destroy();
  return Object.assign({seeded:seeded}, look);
}

app.on('window-all-closed', e => e.preventDefault());
app.whenReady().then(async ()=>{
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const PORT=server.address().port;
  const errs=[];
  const a=await shoot(PORT,1920,1080,'rel_1920.png',errs);
  const b=await shoot(PORT,1366,768,'rel_1366.png',errs);
  const checks={
    themeInPackage: a.themeBlock && b.themeBlock,
    warmCanvas: a.a4Bg==='rgb(237, 234, 227)',
    inkButton: a.solidBg==='rgb(51, 71, 79)' && a.solidFg==='rgb(255, 255, 255)',
    lightTopbar: a.topbarBg==='rgb(252, 251, 248)',
    paginationIntact: Math.abs(parseFloat(a.a4BodyHeight)-930.5)<1.5,
    a4Built: a.seeded.slots>0 && a.seeded.vols===2 && a.seeded.pdfPages==='/ 5',
    nameOk: a.brand==='阅卷助理'
  };
  console.log('CHECKS='+JSON.stringify(checks));
  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  const ok=Object.keys(checks).every(k=>checks[k]) && errs.length===0;
  console.log('RESULT='+(ok?'PASS':'FAIL'));
  server.close(); app.quit();
  setTimeout(()=>process.exit(ok?0:1),300);
});
