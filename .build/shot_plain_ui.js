/* 素颜配色落地后的真实渲染检查：合成数据 + 随机端口，不碰真实卷宗
   用法：env -u ELECTRON_RUN_AS_NODE npx electron .build/shot_plain_ui.js */
const { app, BrowserWindow } = require('electron');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css','.pdf':'application/pdf'};
function handler(req,res){ let u=decodeURIComponent((req.url||'/').split('?')[0]); if(u==='/'||u==='') u='/阅卷助理.html';
  const fp=path.normalize(path.join(ROOT,u)); if(!fp.startsWith(ROOT)){res.writeHead(403);res.end();return;}
  fs.readFile(fp,(e,d)=>{ if(e){res.writeHead(404);res.end('404');return;} res.writeHead(200,{'Content-Type':MIME[path.extname(fp).toLowerCase()]||'application/octet-stream'}); res.end(d); }); }

const SEED = `(async function(){
  var z=window.__zj, st=z.state();
  st.case='某某等人涉嫌诈骗罪案'; st.trash=[]; st.cur=0; st.vols.length=0;
  st.vols.push({id:'pl1',name:'诉讼文书卷',no:'第十六册',offset:0,items:[
    {id:'pl1a',p1:'1',p2:'3',mat:'起诉意见书',mark:'【※】',text:'犯罪嫌疑人某某，男，1985年3月生，因涉嫌诈骗罪于2023年6月被刑事拘留。',note:'',imgs:[]},
    {id:'pl1b',p1:'5',p2:'5',mat:'讯问笔录',mark:'',text:'问：你上述所说是否属实？答：属实。问：收款后资金去向？答：部分用于经营支出。',note:'与银行流水不符',imgs:[]},
    {id:'pl1c',p1:'12',p2:'14',mat:'到案经过',mark:'【※】',text:'2024年2月18日，侦查人员在本市某小区将犯罪嫌疑人某某抓获。',note:'',imgs:[]}
  ]});
  st.vols.push({id:'pl2',name:'讯问笔录卷',no:'第十七册',offset:0,items:[
    {id:'pl2a',p1:'2',p2:'4',mat:'讯问笔录',mark:'',text:'问：你是否申请回避？答：不申请。',note:'',imgs:[]}
  ]});
  st.vols.push({id:'pl3',name:'书证材料卷',no:'第十八册',offset:0,items:[]});
  document.getElementById('fCase').value=st.case;
  z.render();
  var resp=await fetch('/.build/demo_case.pdf');
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
  await win.loadURL('http://127.0.0.1:'+PORT+'/');
  await new Promise(r=>setTimeout(r,2200));
  const seeded=await win.webContents.executeJavaScript(SEED);
  await new Promise(r=>setTimeout(r,1200));
  await win.webContents.executeJavaScript(`(function(){
    var t=document.getElementById('fText'); t.value='经依法审查查明：2023年3月至2024年1月间，犯罪嫌疑人某某以投资项目为由，先后在本市多处收取被害人钱款，数额巨大。';
    document.querySelector('#volList .vol-item[data-v="0"]').click();
    return 'ok';
  })()`);
  await new Promise(r=>setTimeout(r,700));
  /* 演示图不留瞬时提示条：把 toast 收掉再截 */
  await win.webContents.executeJavaScript(`(function(){var t=document.getElementById('toast');if(t){t.className='';t.style.display='none';}return 1;})()`);
  win.showInactive();
  await new Promise(r=>setTimeout(r,600));
  const img=await win.webContents.capturePage();
  fs.writeFileSync(path.join(ROOT,'.build',out), img.toPNG());
  console.log(out+' @'+w+'x'+h+' '+JSON.stringify(seeded));
  win.destroy();
}

app.on('window-all-closed', e => e.preventDefault());
app.whenReady().then(async ()=>{
  const server=http.createServer(handler);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const PORT=server.address().port;
  const errs=[];
  await shoot(PORT,1920,1080,'plain_1920.png',errs);
  await shoot(PORT,1440,900,'plain_1440.png',errs);
  await shoot(PORT,1100,680,'plain_1100.png',errs);
  console.log('ERRS='+JSON.stringify(errs.slice(0,8)));
  server.close(); app.quit();
  setTimeout(()=>process.exit(errs.length?1:0),300);
});
