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
(function(){
"use strict";
var $ = function(id){ return document.getElementById(id); };
var PAGE_W=11906, MARGIN=1800, PAGE_H=16838, MARGIN_V=1440;
var MAXW_EMU=(PAGE_W-MARGIN*2)*635, MAXH_EMU=(PAGE_H-MARGIN_V*2)*635, EMU_PER_PX=9525;
/* 附图统一铺满 A4 版心满宽（MAXW_EMU≈146.65mm）：左右不再留空白，整页扫描件也按满宽等比放大。
   高度按原图比例走，超高（竖图）才等比缩小并居中。 */
var IMG_W_EMU=MAXW_EMU;
/* 图上那行小页码（P3）实际占多高：13 磅行高换算成屏幕像素。
   预览给这块留的高度必须和导出 PGNO 的 13 磅完全一致，否则每张图都会差一点。 */
var PGNH=Math.round(13*(96/72)*100)/100;

/* ============ 基础 ============ */
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
var tt=null, busyTimer=null;
function toast(m, ms){ var t=$("toast"); t.textContent=m; t.classList.add("on"); clearTimeout(tt); tt=setTimeout(function(){t.classList.remove("on");}, ms||2400); }
function busy(on){
  clearTimeout(busyTimer);
  $("busy").classList.toggle("on", !!on);
  // 看门狗：万一某次异步操作异常没走到 finally，25 秒后强制解除遮罩，避免整个界面卡死
  if(on) busyTimer=setTimeout(function(){ $("busy").classList.remove("on"); }, 25000);
}
function cnNum(n){ var d=["零","一","二","三","四","五","六","七","八","九"];
  if(n<10) return d[n]; if(n<20) return "十"+(n%10?d[n%10]:""); if(n<100) return d[Math.floor(n/10)]+"十"+(n%10?d[n%10]:""); return String(n); }

/* ============ 存储（IndexedDB） ============ */
var dbp=null;
function idb(){
  if(dbp) return dbp;
  dbp=new Promise(function(res,rej){
    var r=indexedDB.open("zhai-juan-v3",1);
    r.onupgradeneeded=function(){ var d=r.result;
      if(!d.objectStoreNames.contains("imgs")) d.createObjectStore("imgs");
      if(!d.objectStoreNames.contains("meta")) d.createObjectStore("meta"); };
    r.onsuccess=function(){ res(r.result); }; r.onerror=function(){ rej(r.error); };
  });
  return dbp;
}
function idbPut(s,k,v){ return idb().then(function(d){ return new Promise(function(res,rej){
  var t=d.transaction(s,"readwrite"); t.objectStore(s).put(v,k); t.oncomplete=res; t.onerror=function(){rej(t.error);}; });});}
function idbGet(s,k){ return idb().then(function(d){ return new Promise(function(res,rej){
  var t=d.transaction(s,"readonly"), q=t.objectStore(s).get(k);
  q.onsuccess=function(){res(q.result);}; q.onerror=function(){rej(q.error);}; });});}
function idbDel(s,k){ return idb().then(function(d){ return new Promise(function(res){
  var t=d.transaction(s,"readwrite"); t.objectStore(s).delete(k); t.oncomplete=res; t.onerror=res; });});}
/* ============ 撤销（后退一步）：操作前拍状态快照，被删的附图也备份，撤回即可恢复 ============ */
var undoStack=[], redoStack=[];
function collectImgIds(st){
  var ids={}, out=[];
  (st.vols||[]).forEach(function(v){ (v.items||[]).forEach(function(it){ (it.imgs||[]).forEach(function(im){ if(im&&im.id&&!ids[im.id]) ids[im.id]=1; }); }); });
  (st.trash||[]).forEach(function(rec){ var v=rec.vol||{}; (v.items||[]).forEach(function(it){ (it.imgs||[]).forEach(function(im){ if(im&&im.id&&!ids[im.id]) ids[im.id]=1; }); }); });
  for(var k in ids) out.push(k);
  return out;
}
async function collectImgBlobs(ids){
  var map={};
  for(var i=0;i<ids.length;i++){
    try{ var b=await idbGet("imgs", ids[i]); if(b) map[ids[i]]={ data:new Uint8Array(await b.arrayBuffer()), type:b.type||"image/jpeg" }; }catch(e){}
  }
  return map;
}
/* label：操作名（撤回时提示用）；delIds：本次操作会删掉的图片 id，只备份这些，省内存 */
function pushUndo(label, delIds){
  var snap={ label:label||"上一步", state:JSON.parse(JSON.stringify(state)), cur:state.cur, imgs:null, pending:true, delIds:delIds||[] };
  undoStack.push(snap);
  if(undoStack.length>80) undoStack.shift();
  redoStack.length=0;               // 有了新操作，原来的"重做"就接不上了
  updateUndoBtn();
  if(snap.delIds.length) collectImgBlobs(snap.delIds).then(function(m){ snap.imgs=m; snap.pending=false; });
  else { snap.imgs={}; snap.pending=false; }
}
/* 撤回：把操作前的快照装回去；同时把"现在"拍一张推进重做栈，右回退才有得回 */
async function undo(){
  if(!undoStack.length){ toast("没有可撤回的操作"); return; }
  var snap=undoStack.pop();
  if(snap.pending) snap.imgs=await collectImgBlobs(snap.delIds||[]);   // 极少见：撤回太快图片还没备完，现读
  redoStack.push({ label:snap.label, state:JSON.parse(JSON.stringify(state)), cur:state.cur, imgs:null, pending:false, delIds:[] });
  if(redoStack.length>80) redoStack.shift();
  busy(true);
  try{
    if(snap.imgs) for(var id in snap.imgs){
      try{ var ex=await idbGet("imgs", id); if(!ex) await idbPut("imgs", id, new Blob([snap.imgs[id].data], {type:snap.imgs[id].type})); }catch(e){}
    }
    state=snap.state;
    state.cur=Math.max(0, Math.min((snap.cur||0), (state.vols?state.vols.length:0)-1));
    if(state.cur<0) state.cur=0;
    editing=null; if($("btnAdd")){ $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; }
    dropPending(true); resetFormFields(); saveDraft();
    save(); render(); scheduleA4(); updatePageTip(); updateUndoBtn();
    toast("已撤回：" + snap.label);
  }catch(e){ console.error(e); toast("撤回失败："+(e&&e.message||e)); }
  finally{ busy(false); }
}
/* 重做（右回退）：把撤回时拍下的那张再装回去，并把当前状态压回撤回栈，左右可以来回走 */
async function redo(){
  if(!redoStack.length){ toast("没有可重做的操作"); return; }
  var snap=redoStack.pop();
  undoStack.push({ label:snap.label, state:JSON.parse(JSON.stringify(state)), cur:state.cur, imgs:null, pending:false, delIds:[] });
  if(undoStack.length>80) undoStack.shift();
  busy(true);
  try{
    state=snap.state;
    state.cur=Math.max(0, Math.min((snap.cur||0), (state.vols?state.vols.length:0)-1));
    if(state.cur<0) state.cur=0;
    editing=null; if($("btnAdd")){ $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; }
    dropPending(true); resetFormFields(); saveDraft();
    save(); render(); scheduleA4(); updatePageTip(); updateUndoBtn();
    toast("已重做：" + snap.label);
  }catch(e){ console.error(e); toast("重做失败："+(e&&e.message||e)); }
  finally{ busy(false); }
}
function updateUndoBtn(){
  var b=$("btnUndo"); if(b) b.disabled=!undoStack.length;
  var r=$("btnRedo"); if(r) r.disabled=!redoStack.length;
}
/* 取图片的 objectURL（带缓存）：同一张图反复显示不要重复创建 */
function imgUrl(id){
  if(!id) return Promise.resolve("");
  if(urlCache[id]) return Promise.resolve(urlCache[id]);
  return idbGet("imgs", id).then(function(b){
    if(!b) return "";
    var u=URL.createObjectURL(b); urlCache[id]=u; return u;
  }).catch(function(){ return ""; });
}

var opt = { lawyer:"", by:"", cover:true, toc:true, note:true, inline:true, sep:"、", max:1600,
            font:"仿宋", size:32, repTitle:false, imgPage:true, a4w:0, a4wMig:1, pz:null,
            /* 封面 / 目录上那几个字允许自己改：改完预览和导出同时生效 */
            coverSub:"阅卷摘录", coverUnit:"", coverDate:"", tocTitle:"目　录" };
var state = { case:"", vols:[], cur:0, trash:[] };
var pending = [];      // 本条待加入的截图（含编辑时载入的原图，saved=true）
var removedIds = [];   // 编辑时被删掉的原图，点「保存修改」才真正删
var editing = null;    // {v,i}
var shotView = null;   // {list:[{url,cap}], i, del:function(k), re:function(k)} 大图核对状态
var urlCache = {};

function save(){
  idbPut("meta","state", JSON.stringify({case:state.case, vols:state.vols, cur:state.cur, trash:state.trash||[]}))
   .then(function(){ $("topStat").textContent = "已保存 "+stamp(); })
   .catch(function(){ toast("保存失败：本机存储不足"); });
  idbPut("meta","opt", JSON.stringify(opt)).catch(function(){});
}
async function load(){
  try{
    var o=await idbGet("meta","opt");
    if(o){
      var op=JSON.parse(o);
      /* 旧版默认 A4 栏死宽 520；升级后改成按窗口自适应，只迁移一次 */
      if(op && op.a4wMig===undefined && op.a4w===520){ op.a4w=0; op.a4wMig=1; }
      opt=Object.assign(opt, op);
    }
  }catch(e){}
  try{ var s=await idbGet("meta","state"); if(s){ var st=JSON.parse(s); if(st&&st.vols){ state=st; if(!state.trash) state.trash=[]; return; } } }catch(e){}
  state={case:"",vols:[],cur:0,trash:[]};
}

/* ============ PDF ============ */
var pdfDoc=null, pdfBytes=null, pageNum=1, pageCount=0, scale=1.0, pdfVolId=null;
var lastTextItems=[];   // 当前页文字块及其视口坐标（用于按区域取字）
var pageItems={};       // 滚动模式下：pageNum -> 该页文字块数组
var pageRendered={};    // pageNum -> 该页 canvas 是否已渲染
var pageBusy={};        // pageNum -> 该页是否正在渲染（防并发重复渲染同一 canvas）
var renderGen=0;        // 渲染代次：buildStage 重建时 +1，旧代次的异步渲染作废，防串页/空白
var pageIO=null;        // 懒渲染 IntersectionObserver
var scrollTick=null;    // 滚动节流
var pgBaseW=0, pgBaseH=0;  // 第 1 页在 scale=1 时的尺寸：用来给「还没渲染的页」先占好位置
                           // （占位高度不稳，翻页时 offsetTop 就会算错，页面落到半截上去）
try{
  var wc=document.getElementById("pdfWorkerSrc").textContent;
  if(location.protocol==="http:" || location.protocol==="https:"){
    // 桌面版（本地 http 源）：直接用真实 worker 文件，最稳
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("lib/pdf.worker.min.js", location.href).href;
  }else{
    // 网页演示（file:// 源）：退回内联 blob
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wc],{type:"application/javascript"}));
  }
}catch(e){ console.error("worker 初始化失败", e); }

/* ============ 选 PDF = 自动建卷（一步到位） ============
   以前要「填卷名 → 加卷 → 再选 PDF 绑上去」，三步；现在选 PDF 就建卷，
   一次能选多本（49 本卷一次导进来），切到哪本自动打开哪本。 */
function baseName(n){ return String(n||"").replace(/\.pdf$/i,"").trim() || "未命名卷"; }
/* 卷名默认就是 PDF 原文件名，不改字、不加后缀——所见即所得；要改点卷名后的 ✎ */
/* 提取卷的「序号」用于自动排序：优先看卷名里的数字（第20册/第21册/卷3），再看卷号 no */
function volSeq(v){
  var s=String((v&&v.name)||"");
  var m=s.match(/第\s*(\d+)\s*[册卷]/) || s.match(/(\d+)/);
  if(m) return parseInt(m[1],10);
  var m2=String((v&&v.no)||"").match(/(\d+)/);
  return m2 ? parseInt(m2[1],10) : null;
}
/* 比较两本卷：数字序号升序；序号相同或没有序号时按卷名字符串（自然序，数字按数值）比较 */
function volCmp(a, b){
  var na=volSeq(a), nb=volSeq(b);
  if(na!==null && nb!==null && na!==nb) return na-nb;
  if(na!==null && nb===null) return -1;
  if(na===null && nb!==null) return 1;
  var A=String(a&&a.name||""), B=String(b&&b.name||"");
  if(A===B){ A=String(a&&a.no||""); B=String(b&&b.no||""); }
  return A.localeCompare(B, "zh", {numeric:true});
}
function newVolFor(name, no){
  var v={id:uid(), name:name, no:no||"", offset:0, items:[]};
  var i=0;
  for(; i<state.vols.length; i++){ if(volCmp(v, state.vols[i])<0) break; }
  state.vols.splice(i, 0, v);            // 按名称序号插到对应位置，删了再重加能排回原位
  return i;
}
/* 只有「没名字没绑 PDF 的空卷」才复用，避免把已经绑好的卷覆盖掉 */
function reusableVolIdx(){
  var cur=state.vols[state.cur];
  return (cur && !cur.pdfName && !cur.items.length) ? state.cur : -1;
}
/* 比较卷名/文件名：去 .pdf、去空格、不分大小写 —— 「第20册.pdf」「第20册 」「第20册.PDF」算同一本 */
function volKey(s){ return String(s||"").replace(/\.pdf$/i,"").replace(/\s+/g,"").toLowerCase(); }
/* 给一个 PDF 找它该落哪一卷。顺序很重要（左栏已经建好 49 个卷位的老用户全靠这个）：
   ① 卷名跟文件名一模一样 → 覆盖绑回去，摘录原样留着
   ② 这卷原来绑的就是这个 PDF → 重新绑一次，摘录不动
   ③ 空卷位（没绑 PDF、没摘录）按顺序填进去 → 老习惯：先建 49 个卷位再一次性选 PDF
   ④ 都没有 → 新建一卷，卷名 = PDF 文件名 */
function takeVolFor(fileName, used){
  var k=volKey(fileName), i, v;
  for(i=0;i<state.vols.length;i++){
    v=state.vols[i]; if(used[i]) continue;
    if(volKey(v.name)===k) return i;
  }
  for(i=0;i<state.vols.length;i++){
    v=state.vols[i]; if(used[i]) continue;
    if(v.pdfName && volKey(v.pdfName)===k) return i;
  }
  for(i=0;i<state.vols.length;i++){
    v=state.vols[i]; if(used[i]) continue;
    if(!v.pdfName && !v.items.length) return i;
  }
  return -1;
}
async function readPdfBytes(v, file){
  if(file){
    return await new Promise(function(res,rej){
      var fr=new FileReader();
      fr.onload=function(){ res(fr.result); };
      fr.onerror=rej;
      fr.readAsArrayBuffer(file);
    });
  }
  if(v && v.pdfPath && window.desktop && window.desktop.readFile){
    var r=await window.desktop.readFile(v.pdfPath);
    if(r && r.ok) return r.data;
    throw new Error(r && r.error ? r.error : "读取失败");
  }
  throw new Error("没有记住文件位置，请重新点「选择 PDF」");
}
/* 打开某一卷绑定的 PDF：已经打开就不重复读；file 传了就直接用它（刚选的） */
async function openPdfOfVol(idx, file){
  var v=state.vols[idx]; if(!v) return;
  if(pdfClosing) await pdfClosing;              // 上一次关预览还没收完，等它结束
  if(!v.pdfName && !v.pdfPath){ await closePdf(); return; }
  if(pdfVolId===v.id && pdfDoc && !file) return;
  if(!file && !v.pdfPath){
    // 网页版拿不到路径，只能请用户再选一次；桌面版不会走到这里
    await closePdf();
    $("pdfName").textContent = v.pdfName + "（已绑定，重新点「选择 PDF」可打开）";
    setPdfEmpty("《"+v.name+"》已经绑着「"+v.pdfName+"」，但没记住它在哪",
                "点上面的「选择 PDF」，把这个文件再选一次就能打开；摘录一条都不会动");
    return;
  }
  busy(true);
  try{
    var bytes=await readPdfBytes(v, file);
    if(pdfDoc){ try{ await pdfDoc.destroy(); }catch(e){} pdfDoc=null; }
    pdfBytes=bytes;
    pdfDoc=await pdfjsLib.getDocument({data:bytes}).promise;
    pageCount=pdfDoc.numPages; pageNum=1; pdfVolId=v.id;
    $("pdfName").textContent = v.pdfName + "（已绑到《" + v.name + "》）";
    if(document.querySelector(".main").classList.contains("docmode")) setDocMode(false);   // 有 PDF 了，把那栏放回来
    $("pgTotal").textContent = "/ " + pageCount;
    $("pdfEmpty").style.display="none"; $("pdfStage").style.display="";
    await fitScale();                        // 先定缩放（手动调过的以手动值为准，见 fitScale）
    buildStage();                            // 建好所有页的容器，从上到下连续滚动
    scrollToPage(1);
    if($("thumbs").style.display!=="none") buildThumbs();
  }catch(err){
    console.error(err);
    pdfVolId=null; pdfDoc=null;
    $("pdfName").textContent = v.pdfName+" 打不开："+(err && err.message ? err.message : err);
    $("pdfEmpty").style.display=""; $("pdfStage").style.display="none";
    toast("《"+v.name+"》的 PDF 打不开："+(err && err.message ? err.message : err), 6000);
  }finally{ busy(false); }
}
async function importPdfs(files){
  var pdfs=(files||[]).filter(function(f){ return /\.pdf$/i.test(f.name||""); });
  if(!pdfs.length){ toast("只支持 PDF 文件"); return; }
  var used={}, start=-1, startFile=null;
  var nNew=0, nBack=0;                      // nBack = 绑回已有卷（摘录保留）
  for(var i=0;i<pdfs.length;i++){
    var f=pdfs[i];
    var idx=takeVolFor(f.name, used);
    if(idx<0){ idx=newVolFor(f.name); nNew++; }             // 真没有对应卷，才新建；卷名 = 原文件名，1:1 不改
    else nBack++;
    used[idx]=1;
    var v=state.vols[idx];
    /* 占位空卷（「卷3」这种自动名）绑上 PDF 后，名字跟着文件名走，不让人再改一遍 */
    if(!v.items.length && /^(未命名卷|卷\d+)?$/.test(String(v.name||"").trim())) v.name=f.name;
    v.pdfName=f.name;
    v.pdfPath=(window.desktop && window.desktop.pathOf) ? (window.desktop.pathOf(f)||"") : "";
    if(start<0){ start=idx; startFile=f; }
  }
  state.cur=start;
  showOffsetInput();                                   // 显示成「前置页」
  if(editing){ editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; }
  dropPending(true); resetFormFields();
  save(); render(); updatePageTip();
  await openPdfOfVol(start, startFile);     // 用刚选的文件直接读，少走一次磁盘
  var msg=[];
  if(nBack) msg.push("绑回已有卷 "+nBack+" 本（摘录、附图原样保留）");
  if(nNew) msg.push("新建 "+nNew+" 本");
  if(nBack) toast("已"+msg.join("，")+"；点左栏任意一本就自动打开它的 PDF", 6000);
  else if(pdfs.length>1) toast("已导入 "+pdfs.length+" 本卷，点左栏任意一本就自动打开它的 PDF", 5200);
}
$("btnPick").onclick=function(){ $("filePick").click(); };
$("filePick").onchange=function(e){
  var files=Array.prototype.slice.call(e.target.files||[]);
  e.target.value="";                        // 清掉，同一本还能再选
  if(files.length) importPdfs(files);
};
async function fitScale(){
  var box=$("pdfScroll");
  if(!pdfDoc) return;
  var p=await pdfDoc.getPage(pageNum||1);
  var v=p.getViewport({scale:1});
  pgBaseW=v.width; pgBaseH=v.height;           // 记下 1:1 尺寸，后面给未渲染的页占位
  if(opt.pz){ scale=opt.pz; updateZoomLabel(); return; }   // 手动调过缩放：以手动值为准，别再改
  var w=box.clientWidth-36, h=box.clientHeight-36;
  if(w<=0||h<=0) return;
  // 宽高都要装得下才算"整页适应"，再留一成边，别让页面顶到框线上
  var s=Math.min(w/v.width, h/v.height)*0.92;
  scale=Math.min(1.4, Math.max(0.3, s));
  updateZoomLabel();
}
/* ---------- 滚动浏览：所有页从上到下连续排列，滚轮直接看，不再左右翻页 ---------- */
function pageEl(n){ return document.querySelector('#pdfStage .pdf-wrap[data-p="'+n+'"]'); }
function createPageEl(n){
  var wrap=document.createElement("div");
  wrap.className="pdf-wrap"; wrap.setAttribute("data-p", n);
  var cv=document.createElement("canvas");
  var layer=document.createElement("div"); layer.className="textlayer";
  var rb=document.createElement("div"); rb.className="rectbox";
  wrap.appendChild(cv); wrap.appendChild(layer); wrap.appendChild(rb);
  return wrap;
}
/* 建好所有页的骨架，用 IntersectionObserver 懒渲染：滚到哪渲染到哪 */
function buildStage(){
  var stage=$("pdfStage"); if(!stage) return;
  stage.innerHTML="";
  pageItems={}; pageRendered={}; pageBusy={};
  renderGen++;                             // 换代：之前所有还在飞的渲染全部作废
  /* 关键：还没渲染的页如果高度是 0，整列撑不起来，offsetTop 全错，
     翻页就会落到前一页的尾巴上。先按第 1 页的比例给每页占好位置。 */
  var hw=Math.round(pgBaseW*scale), hh=Math.round(pgBaseH*scale);
  for(var i=1;i<=pageCount;i++){
    var el=createPageEl(i);
    if(hw>0&&hh>0){ el.style.width=hw+"px"; el.style.height=hh+"px"; }
    stage.appendChild(el);
  }
  if(pageIO){ try{ pageIO.disconnect(); }catch(e){} }
  pageIO=new IntersectionObserver(function(es){
    es.forEach(function(en){
      if(en.isIntersecting) renderPageTo(parseInt(en.target.getAttribute("data-p"),10));
    });
  },{root:$("pdfScroll"), rootMargin:"800px 0px"});
  Array.prototype.forEach.call(stage.children, function(el){ pageIO.observe(el); });
}
var curTask=null;
async function renderPageTo(n){
  if(!pdfDoc || !n || pageRendered[n] || pageBusy[n]) return;
  var myGen=renderGen;                 // 记下本次渲染属于哪一代
  var el=pageEl(n); if(!el) return;
  pageBusy[n]=true;
  try{
    var page=await pdfDoc.getPage(n);
    if(myGen!==renderGen || !pdfDoc) return;   // 期间重建/换卷了，作废
    var vp=page.getViewport({scale:scale});
    if(!pgBaseW){ var vb=page.getViewport({scale:1}); pgBaseW=vb.width; pgBaseH=vb.height; }
    var cv=el.querySelector("canvas"), ctx=cv.getContext("2d");
    /* 高清渲染：canvas 位图按设备像素比放大，CSS 尺寸保持逻辑像素——高 DPI 屏不模糊，
       且 pdf.js 用 transform 缩放坐标系，画面与原件所见即所得、无任何拉伸 */
    var dpr=(typeof window!=="undefined" && window.devicePixelRatio)||1;
    cv.width=Math.floor(vp.width*dpr); cv.height=Math.floor(vp.height*dpr);
    cv.style.width=vp.width+"px"; cv.style.height=vp.height+"px";
    el.style.width=vp.width+"px"; el.style.height=vp.height+"px";
    await page.render({canvasContext:ctx, viewport:vp,
      transform: (dpr!==1) ? [dpr,0,0,dpr,0,0] : null}).promise;
    if(myGen!==renderGen || !pdfDoc) return;   // 渲染完发现换代了，不算数
    pageRendered[n]=true;
  }catch(e){ return; }
  finally{ pageBusy[n]=false; }
  // 文本层（供选中复制/按区域取字）；纯 HTML、color 透明，不影响画面
  try{
    if(myGen!==renderGen || !pdfDoc) return;
    var page2=await pdfDoc.getPage(n);
    var vp2=page2.getViewport({scale:scale});
    var layer=el.querySelector(".textlayer"); layer.innerHTML="";
    layer.style.width=vp2.width+"px"; layer.style.height=vp2.height+"px";
    var tc=await page2.getTextContent();
    var frag=document.createDocumentFragment();
    var pairs=[], items=[];
    tc.items.forEach(function(it){
      if(!it.str) return;
      var tx=pdfjsLib.Util.transform(vp2.transform, it.transform);
      var fs=Math.sqrt(tx[2]*tx[2]+tx[3]*tx[3]);
      var d=document.createElement("div");
      d.textContent=it.str;
      d.style.cssText="position:absolute;left:"+tx[4]+"px;top:"+(tx[5]-fs)+"px;font-size:"+fs+
        "px;font-family:sans-serif;white-space:pre;transform-origin:0% 0%;color:transparent;";
      pairs.push({d:d, it:it});
      items.push({str:it.str, x:tx[4], y:tx[5]-fs, w:(it.width||0)*vp2.scale, h:fs});
      frag.appendChild(d);
    });
    layer.appendChild(frag);
    pageItems[n]=items;
    if(n===pageNum) lastTextItems=items;
    var ws=[];
    for(var q=0;q<pairs.length;q++) ws.push(pairs[q].d.getBoundingClientRect().width);
    for(var q2=0;q2<pairs.length;q2++){
      if(ws[q2]>0.5) pairs[q2].d.style.transform="scaleX("+((pairs[q2].it.width*vp2.scale)/ws[q2])+")";
    }
  }catch(e){ console.warn("文本层跳过", e); }
}
/* 把第 n 页摆到视口正中：整页装得下就上下居中，装不下就顶对齐；左右始终居中 */
function scrollToPage(n){
  if(!pdfDoc) return;
  n=Math.max(1, Math.min(pageCount, parseInt(n,10)||1));
  var el=pageEl(n);
  if(!el) return;
  var sc=$("pdfScroll");
  centerInScroll(el, sc);
  pageNum=n;
  $("pgInput").value=n;
  updatePageTip();
  markThumb(n);
  renderPageTo(n);
}
/* 让 el 在 sc 里居中：横向永远居中（内容比视口宽时居中露中间），纵向能整页装下就居中 */
function centerInScroll(el, sc){
  var sr=sc.getBoundingClientRect(), er=el.getBoundingClientRect();
  var cs=getComputedStyle(sc);
  var padT=parseFloat(cs.paddingTop)||0, padB=parseFloat(cs.paddingBottom)||0;
  centerPdfX(sc);                                     // 横向：翻页后绝不卡在偏左的位置
  /* 纵向：元素在内容坐标系里的位置（用 rect 差值算，不受 offsetParent 影响） */
  var elTop = er.top - sr.top + sc.scrollTop - padT;   // 页面顶相对内容起点
  var availH = sc.clientHeight - padT - padB;
  var target;
  if(er.height>0 && er.height<=availH){
    target = elTop - Math.round((availH-er.height)/2);  // 整页装得下 → 垂直居中
  }else{
    target = elTop;                                    // 比视口还长 → 从页顶开始看
  }
  sc.scrollTop = Math.max(0, target);
}
/* 只调横向：页面比栏宽时露中间，不宽时归零。改窗口大小/缩放后调用，防页面贴左 */
function centerPdfX(sc){
  sc = sc || $("pdfScroll"); if(!sc) return;
  var overX = sc.scrollWidth - sc.clientWidth;
  sc.scrollLeft = overX>0 ? Math.round(overX/2) : 0;
}
function gotoPage(n){ scrollToPage(n); }
/* 缩放/窗口尺寸变了，所有页按新比例重来一遍 */
function refreshPdfPages(){
  if(!pdfDoc) return;
  var cur=pageNum; pageRendered={}; buildStage(); scrollToPage(cur);
}
/* 滚动时判定「当前页」：视口上部 1/3 处落在哪页，哪页就是当前页（截图/取字/取页码都用它） */
function updateCurrentPage(){
  if(!pdfDoc || !pageCount) return;
  var sc=$("pdfScroll"), r=sc.getBoundingClientRect();
  var cy=r.top + r.height*0.33;
  var pages=sc.querySelectorAll(".pdf-wrap");
  var cur=pageNum;
  for(var i=0;i<pages.length;i++){
    var b=pages[i].getBoundingClientRect();
    if(b.top<=cy && b.bottom>=cy){ cur=parseInt(pages[i].getAttribute("data-p"),10); break; }
  }
  if(cur===pageNum) return;
  pageNum=cur; lastTextItems=pageItems[cur]||[];
  $("pgInput").value=cur; updatePageTip(); markThumb(cur);
}
function onPdfScroll(){
  if(scrollTick) return;
  scrollTick=setTimeout(function(){ scrollTick=null; updateCurrentPage(); }, 60);
}
$("pdfScroll").addEventListener("scroll", onPdfScroll, {passive:true});
$("btnPrev").onclick=function(){ gotoPage(pageNum-1); };
$("btnNext").onclick=function(){ gotoPage(pageNum+1); };
$("pgInput").onchange=function(){ gotoPage(this.value); };
function updateZoomLabel(){
  var b=$("zoomPct"); if(!b) return;
  var pct=Math.round(scale*100);
  b.textContent=pct+"%";
  b.classList.toggle("on", !!opt.pz);
  b.title = opt.pz ? ("手动缩放 "+pct+"%；点一下恢复「整页适应窗口」") : ("整页适应窗口（"+pct+"%）；点一下可重置");
}
function zoomTo(s, manual){
  if(!pdfDoc) return;
  scale=Math.max(0.3, Math.min(4, s));
  if(manual!==false){ opt.pz=scale; save(); }        // 手动调过就记住，下次打开还这么大
  updateZoomLabel();
  /* 缩放变了，所有页尺寸都要重来：清掉已渲染标记，重排骨架并重新懒渲染 */
  var cur=pageNum;
  pageRendered={};
  buildStage();
  scrollToPage(cur);
}
$("btnIn").onclick=function(){ zoomTo(scale*1.15); };
$("btnOut").onclick=function(){ zoomTo(scale/1.15); };
$("zoomPct").onclick=async function(){
  opt.pz=null; save();
  await fitScale(); updateZoomLabel();
  var cur=pageNum; pageRendered={}; buildStage(); scrollToPage(cur);
  toast("已恢复整页适应（"+Math.round(scale*100)+"%）");
};
$("btnShot").onclick=function(){ shotOnly(null, true, ""); };

/* ---------- 缩略图导航：49 本卷靠翻页找材料太慢，点缩略图直接跳 ---------- */
var thumbIO=null, thumbQ=Promise.resolve();
$("btnThumbs").onclick=function(){
  var box=$("thumbs"), on=(box.style.display==="none");
  box.style.display = on ? "" : "none";
  $("btnThumbs").classList.toggle("on", on);
  if(on){ buildThumbs(); }
};
function buildThumbs(){
  var box=$("thumbs"); if(!box) return;
  if(!pdfDoc){ box.innerHTML='<div class="tip-line" style="padding:6px">先打开 PDF</div>'; return; }
  var html="";
  for(var i=1;i<=pageCount;i++){
    html+='<div class="th" data-p="'+i+'"><div class="tc" style="height:128px">'+i+'</div><div class="tn">'+i+'</div></div>';
  }
  box.innerHTML=html;
  if(thumbIO){ try{ thumbIO.disconnect(); }catch(e){} }
  thumbIO=new IntersectionObserver(function(es){
    es.forEach(function(en){ if(en.isIntersecting){ renderThumb(en.target); } });
  },{root:box, rootMargin:"400px 0px"});
  Array.prototype.forEach.call(box.querySelectorAll(".th"),function(el){ thumbIO.observe(el); });
  markThumb(pageNum);
}
function renderThumb(el){
  if(!el || el.getAttribute("data-done")) return;
  el.setAttribute("data-done","1");
  var pno=parseInt(el.getAttribute("data-p"),10);
  thumbQ = thumbQ.then(function(){
    if(!pdfDoc) return null;
    return pdfDoc.getPage(pno).then(function(p){
      var v1=p.getViewport({scale:1});
      var sc=104/v1.width;
      var vp=p.getViewport({scale:sc});
      var cv=document.createElement("canvas");
      cv.width=Math.floor(vp.width); cv.height=Math.floor(vp.height);
      cv.style.width="100%"; cv.style.display="block";
      return p.render({canvasContext:cv.getContext("2d"), viewport:vp}).promise.then(function(){
        var tc=el.querySelector(".tc");
        if(tc){ tc.innerHTML=""; tc.style.height="auto"; tc.appendChild(cv); }
      });
    });
  }).catch(function(){ el.removeAttribute("data-done"); });
}
function markThumb(n){
  var box=$("thumbs"); if(!box || box.style.display==="none") return;
  Array.prototype.forEach.call(box.querySelectorAll(".th"),function(el){
    var on=(parseInt(el.getAttribute("data-p"),10)===n);
    el.classList.toggle("on",on);
    if(on){ try{ el.scrollIntoView({block:"nearest"}); }catch(e){} }
  });
}
$("thumbs").onclick=function(e){
  var el=e.target.closest("[data-p]"); if(!el) return;
  gotoPage(parseInt(el.getAttribute("data-p"),10));
};

/* ---------- 键盘翻页 / Ctrl+滚轮缩放（在输入框里打字时不抢键） ---------- */
document.addEventListener("keydown", function(e){
  var t=e.target, tag=(t.tagName||"").toLowerCase();
  if(tag==="input"||tag==="textarea"||tag==="select"||t.isContentEditable) return;
  if(e.ctrlKey||e.metaKey||e.altKey) return;
  if(!pdfDoc) return;
  if(e.key==="PageDown"||e.key==="ArrowRight"){ e.preventDefault(); gotoPage(pageNum+1); }
  else if(e.key==="PageUp"||e.key==="ArrowLeft"){ e.preventDefault(); gotoPage(pageNum-1); }
  else if(e.key==="Home"){ e.preventDefault(); gotoPage(1); }
  else if(e.key==="End"){ e.preventDefault(); gotoPage(pageCount); }
});
document.addEventListener("wheel", function(e){
  if(!e.ctrlKey || !pdfDoc) return;
  if(!e.target.closest(".pdfpane")) return;
  e.preventDefault();
  zoomTo(e.deltaY<0 ? scale*1.1 : scale/1.1);
}, {passive:false});

/* ============ 矩形截图（框选局部） ============ */
var rectMode=false, rectDragging=false, rectStart=null, rectWrap=null, rectPage=0;
function setRectMode(on){
  rectMode=on;
  var stage=$("pdfStage"); if(stage) stage.classList.toggle("rectmode", on);
  $("btnRectShot").classList.toggle("on", on);
  document.querySelectorAll("#pdfStage .rectbox").forEach(function(b){ b.style.display="none"; });
  if(on) toast("矩形截图：按住鼠标拖动框选，松开即截；可以接着框下一段，Esc 退出", 4200);
}
$("btnRectShot").onclick=function(){
  if(!pdfDoc){ toast("先打开 PDF"); return; }
  setRectMode(!rectMode);
};
$("pdfStage").addEventListener("mousedown", function(e){
  if(!rectMode) return;
  var wrap=e.target.closest(".pdf-wrap"); if(!wrap) return;
  e.preventDefault();
  rectWrap=wrap;
  rectPage=parseInt(wrap.getAttribute("data-p"),10)||pageNum;
  var r=wrap.getBoundingClientRect();
  rectStart={x:e.clientX-r.left, y:e.clientY-r.top};
  rectDragging=true;
  var b=wrap.querySelector(".rectbox");
  b.style.display="block";
  b.style.left=rectStart.x+"px"; b.style.top=rectStart.y+"px";
  b.style.width="0px"; b.style.height="0px";
});
$("pdfStage").addEventListener("mousemove", function(e){
  if(!rectDragging || !rectWrap) return;
  var r=rectWrap.getBoundingClientRect();
  var x=e.clientX-r.left, y=e.clientY-r.top, b=rectWrap.querySelector(".rectbox");
  b.style.left=Math.min(x,rectStart.x)+"px";
  b.style.top=Math.min(y,rectStart.y)+"px";
  b.style.width=Math.abs(x-rectStart.x)+"px";
  b.style.height=Math.abs(y-rectStart.y)+"px";
});
document.addEventListener("mouseup", async function(e){
  if(!rectDragging) return;
  rectDragging=false;
  var wrap=rectWrap, b=wrap.querySelector(".rectbox");
  var x=parseFloat(b.style.left)||0, y=parseFloat(b.style.top)||0;
  var w=parseFloat(b.style.width)||0, h=parseFloat(b.style.height)||0;
  b.style.display="none";
  var pno=rectPage;
  if(w<12||h<12) return;                 // 误点，忽略
  await shotOnly({x:x, y:y, w:w, h:h}, true, " 区域", pno);
});
document.addEventListener("keydown", function(e){
  if(e.key!=="Escape") return;
  if($("dlgShot") && $("dlgShot").classList.contains("on")){ openShotClose(); return; }
  if($("dlgVol") && $("dlgVol").classList.contains("on")){ $("dlgVol").classList.remove("on"); volEdit=-1; return; }
  if($("dlgTrash") && $("dlgTrash").classList.contains("on")){ $("dlgTrash").classList.remove("on"); return; }
  if($("dlgDrafts") && $("dlgDrafts").classList.contains("on")){ closeDrafts(); return; }
  if(rectMode){ setRectMode(false); return; }
  if(editing){ $("btnCancel").click(); return; }     // 预览里点错了，Esc 就退出修改
});
/* ============ 截图后取字：文字层优先，扫描件走 OCR ============ */
function blobToBase64(blob){
  return new Promise(function(res,rej){
    var fr=new FileReader();
    fr.onload=function(){ var s=String(fr.result||""); res(s.slice(s.indexOf(",")+1)); };
    fr.onerror=rej; fr.readAsDataURL(blob);
  });
}
/* Windows OCR 会把每个汉字用空格隔开，这里去掉汉字之间的空格 */
function cleanOcr(t){
  if(!t) return "";
  t=t.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  for(var i=0;i<4;i++) t=t.replace(/([\u3000-\u9fff\uff00-\uffef])\s+(?=[\u3000-\u9fff\uff00-\uffef])/g,"$1");
  t=t.replace(/[ \t]+$/gm,"").replace(/\n{3,}/g,"\n\n").replace(/^\n+|\n+$/g,"");
  return t;
}
/* 从文字层按矩形取字；rect 为 null 表示整页 */
function textFromLayer(rect){
  if(!lastTextItems.length) return "";
  var sel=lastTextItems.filter(function(it){
    if(!rect) return true;
    return it.x < rect.x+rect.w && it.x+it.w > rect.x && it.y < rect.y+rect.h && it.y+it.h > rect.y;
  });
  if(!sel.length) return "";
  sel.sort(function(a,b){ if(Math.abs(a.y-b.y)>3) return a.y-b.y; return a.x-b.x; });
  var lines=[], cur="", lineY=null, lastRight=null, hRef=12;
  sel.forEach(function(it){
    var tol=Math.max(4,(it.h||12)*0.6);
    if(lineY===null || Math.abs(it.y-lineY)>tol){
      if(cur) lines.push(cur);
      cur=it.str; lineY=it.y; lastRight=it.x+(it.w||0); hRef=it.h||12;
    }else{
      var gap=it.x-lastRight;
      // 只在英文/数字之间补空格，中文直接连写
      if(gap>(hRef*0.5) && /[A-Za-z0-9]$/.test(cur) && /^[A-Za-z0-9]/.test(it.str)) cur+=" ";
      cur+=it.str; lastRight=it.x+(it.w||0);
    }
  });
  if(cur) lines.push(cur);
  return lines.join("\n");
}
/* 把指定区域（或整页）按 2 倍分辨率渲染成 PNG；pno 可指定页（重截时用） */
async function renderRegion(rect, pno){
  if(!pdfDoc) return null;
  var page=await pdfDoc.getPage(pno||pageNum);
  var hi=Math.max(2, scale*2);
  var vp=page.getViewport({scale:hi});
  var c2=document.createElement("canvas");
  c2.width=Math.floor(vp.width); c2.height=Math.floor(vp.height);
  await page.render({canvasContext:c2.getContext("2d"), viewport:vp}).promise;
  var k=hi/scale;
  var sx=0, sy=0, sw=c2.width, sh=c2.height;
  if(rect){
    sx=Math.max(0,Math.round(rect.x*k)); sy=Math.max(0,Math.round(rect.y*k));
    sw=Math.min(c2.width-sx, Math.round(rect.w*k));
    sh=Math.min(c2.height-sy, Math.round(rect.h*k));
    if(sw<=0||sh<=0) return null;
  }
  var c3=document.createElement("canvas"); c3.width=sw; c3.height=sh;
  c3.getContext("2d").drawImage(c2, sx, sy, sw, sh, 0, 0, sw, sh);
  return await new Promise(function(r){ c3.toBlob(function(b){ r(b); }, "image/png"); });
}
/* 取文字：文字层优先（准确），没有文字层再 OCR（扫描件）。只在用户手动点「识别文字」时才调用 */
async function ocrBlob(blob){
  if(!blob) return {text:"", src:"none"};
  if(!(window.desktop && window.desktop.ocr)) return {text:"", src:"nobridge"};
  busy(true);
  try{
    var b64=await blobToBase64(blob);
    var r=await window.desktop.ocr(b64);
    if(r && r.ok) return {text:cleanOcr(r.text), src:"ocr"};
    return {text:"", src:"ocrfail", error:(r&&r.error)||""};
  }catch(e){ return {text:"", src:"ocrfail", error:String(e&&e.message||e)}; }
  finally{ busy(false); }
}
function regionText(rect, blob){
  var t=textFromLayer(rect);
  if(t && t.trim()) return Promise.resolve({text:t, src:"layer"});
  return ocrBlob(blob);
}
function appendText(t){
  if(!t) return;
  var el=$("fText");
  var cur=el.value.replace(/\s+$/,"");
  el.value = cur ? (cur+"\n"+t) : t;
  scheduleDraft();
}
/* 截图就只是截图：所点即所得，不自动识别文字。
   要文字时手动点「识别文字」（PDF 工具条）或在大图里点「识别这张」 */
async function shotOnly(rect, fromPage, label, pno){
  if(!pdfDoc){ toast("先打开 PDF"); return; }
  applyOffsetNow();                            // 截图前先把偏移框里的值落实，P 页码才算对
  var sp = pno || pageNum;                     // 框选可能发生在非当前页，按实际页截图/记页码
  busy(true);
  try{
    var blob=await renderRegion(rect, sp);
    if(!blob){ toast("截取失败"); return; }
    await addShot(blob, sp, label, {rect:rect, page:sp});
    // 页码还没填就自动带上当前卷宗页码，少点一次「取当前页」
    var vp=sp+curOffset();
    if(!$("fP1").value.trim() && !$("fP2").value.trim()){
      if(vp>0){ $("fP1").value = vp; scheduleDraft(); }
      else toast("这一页在前置页里（封面/目录），不算卷宗页码；翻到正文再截", 5000);
    }
  }catch(e){ console.error(e); toast("截取失败"); }
  finally{ busy(false); }
}
/* 手动取字：当前页整页（文字层优先，扫描件走 OCR） */
async function readPage(){
  if(!pdfDoc){ toast("先打开 PDF"); return; }
  busy(true);
  try{
    var t=textFromLayer(null);
    if(t && t.trim()){
      appendText(t);
      toast("已取本页文字（PDF 文字层，准确）", 4000);
      return;
    }
    var blob=await renderRegion(null);
    var res=await ocrBlob(blob);
    if(res.text && res.text.trim()){ appendText(res.text); toast("已用 OCR 识别本页，可能有误，请核对", 5000); }
    else if(res.src==="nobridge") toast("当前环境不支持 OCR", 4000);
    else toast("本页没识别出文字"+(res.error?("："+res.error):""), 5000);
  }catch(e){ console.error(e); toast("识别失败"); }
  finally{ busy(false); }
}
/* 手动取字：识别某一张已截的图（原样走 OCR，不看文字层） */
async function readShot(k){
  var p=pending[k]; if(!p){ toast("没有这张图"); return; }
  busy(true);
  try{
    var b=await idbGet("imgs", p.id);
    if(!b){ toast("图片读取失败"); return; }
    var res=await ocrBlob(b);
    if(res.text && res.text.trim()){ appendText(res.text); toast("已识别这张图的文字，可能有误，请核对", 5000); }
    else if(res.src==="nobridge") toast("当前环境不支持 OCR", 4000);
    else toast("这张图没识别出文字"+(res.error?("："+res.error):""), 5000);
  }catch(e){ console.error(e); toast("识别失败"); }
  finally{ busy(false); }
}

/* 中间那块空白提示：能说清「这卷怎么了」，比一句通用提示强 */
function setPdfEmpty(big, sub){
  var e=$("pdfEmpty"); if(!e) return;
  var none=!state.vols.length;
  var b=e.querySelector(".big");
  var ds=e.querySelectorAll("div");
  if(b) b.textContent = big || (none ? "点上方「选择 PDF」，选一本或多本电子卷建卷" : "先在左边选一卷，再点「选择 PDF」");
  if(ds[1]) ds[1].textContent = sub || (none ? "选好后自动按文件名建卷，可以一次选多本" : "选中后：翻到划线所在页 → 在 PDF 上选中文字复制 → 到右边粘贴");
  if(ds[2]) ds[2].textContent = sub ? "" : "扫描件复制不了时，点「截取本页为图」直接存成图片";
  e.style.display="";
}
/* 关闭/卸载 PDF：取消渲染任务、销毁文档、复位视图。
   删除卷、清空数据、PDF 文件被移走时都要走这里，否则会留下卡死的预览页。
   并发调用共用同一个收尾 Promise，避免"前一次清空把后一次刚打开的新文档抹掉"。 */
var pdfClosing=null;
function closePdf(){
  if(pdfClosing) return pdfClosing;
  var work=(async function(){
    try{
      if(curTask){ try{ curTask.cancel(); }catch(e){} curTask=null; }
      if(pdfDoc){ try{ await pdfDoc.destroy(); }catch(e){} }
      pdfDoc=null; pdfBytes=null; pageNum=1; pageCount=0; pdfVolId=null;
      pageItems={}; pageRendered={}; lastTextItems=[];
      if(pageIO){ try{ pageIO.disconnect(); }catch(e){} pageIO=null; }
      var stage=$("pdfStage"); if(stage){ stage.innerHTML=""; stage.style.display="none"; }
      setPdfEmpty();
      $("pdfName").textContent="未选择文件"; $("pgTotal").textContent="/ 0"; $("pgInput").value="1";
      $("pageTip").textContent="";
      var tb=$("thumbs"); if(tb){ tb.innerHTML=""; tb.style.display="none"; }
      if($("btnThumbs")) $("btnThumbs").classList.remove("on");
      setRectMode(false);
      busy(false);
    }catch(e){ console.error(e); }
  })();
  pdfClosing=work.then(function(){ pdfClosing=null; }, function(){ pdfClosing=null; });
  return pdfClosing;
}

/* 当前卷的页码偏移 */
function curOffset(){
  var v=state.vols[state.cur];
  return v ? (parseInt(v.offset,10)||0) : 0;
}
function curVolPage(){
  return pageNum + curOffset();
}
/* 输入框里让人填的是「前置页」：PDF 开头要跳过的页数（封面、目录）。
   正数 = 跳过前 N 页；内部仍存 offset（卷宗页码 = PDF 页码 + offset），所以 N == offset -N。 */
function skipOf(v){ var o=parseInt(v && v.offset,10)||0; return o ? -o : 0; }
function showOffsetInput(){
  var v=state.vols[state.cur]; if(!v) return;
  var n=-curOffset();
  $("fOffset").value = n ? String(n) : "0";
}
/* 偏移输入框：一边输一边生效（不等失焦）——不然输完直接去截图，偏移还没存上，
   截出来的 P 页码就还是没减封面/目录的 PDF 页码 */
function applyOffsetNow(){
  var v=state.vols[state.cur]; if(!v) return;
  var n=parseInt($("fOffset").value,10); if(isNaN(n)) n=0;
  var off=-n;                                  // 填 2 = 跳过前面 2 页（封面/目录）
  if(v.offset!==off){ v.offset=off; save(); }
  updatePageTip();
}
$("fOffset").addEventListener("input", applyOffsetNow);
$("fOffset").onchange=applyOffsetNow;
function updatePageTip(){
  if(!pdfDoc){ $("pageTip").textContent=""; return; }
  var off=curOffset();
  if(!off){ $("pageTip").textContent = "当前 PDF 第 "+pageNum+" 页"; return; }
  $("pageTip").textContent = "当前 PDF 第 "+pageNum+" 页　→　"+
    (curVolPage()>0 ? ("卷宗第 "+curVolPage()+" 页") : "前置页（封面/目录），不算卷宗页");
}
$("btnTakePage").onclick=function(){
  if(!pdfDoc){ toast("先打开 PDF"); return; }
  applyOffsetNow();                       // 偏移框里刚输的数字也算数
  if(curVolPage()<=0){ toast("这一页在前置页里（封面/目录），不算卷宗页码", 5000); return; }
  $("fP1").value = curVolPage(); $("fP2").value="";
  toast("已取卷宗第 "+curVolPage()+" 页");
};

/* ============ 截图 ============ */
/* 统一缩放到最长边 max 像素、转 jpg（体积可控，A4 上仍清晰） */
async function shrink(blob, max){
  var im=await new Promise(function(res,rej){
    var u=URL.createObjectURL(blob), g=new Image();
    g.onload=function(){ res(g); }; g.onerror=function(){ rej(new Error("bad")); }; g.src=u;
  });
  var w=im.naturalWidth||im.width, h=im.naturalHeight||im.height;
  var s=Math.min(1, max/Math.max(w,h));
  var tw=Math.max(1,Math.round(w*s)), th=Math.max(1,Math.round(h*s));
  var cv=document.createElement("canvas"); cv.width=tw; cv.height=th;
  var c=cv.getContext("2d"); c.fillStyle="#fff"; c.fillRect(0,0,tw,th); c.drawImage(im,0,0,tw,th);
  var out=await new Promise(function(r){ cv.toBlob(function(b){ r(b||blob); }, "image/jpeg", 0.9); });
  return {blob:out, w:tw, h:th};
}
async function addShot(blob, fromPage, extra, meta){
  var max=parseInt((($("sMax")&&$("sMax").value)||1600),10)||1600;
  var sh=await shrink(blob, max);
  var id=uid(); await idbPut("imgs", id, sh.blob);
  var p={ id:id, w:sh.w, h:sh.h, ext:"jpg", url:URL.createObjectURL(sh.blob),
          page:(meta&&meta.page)||pageNum, rect:(meta&&meta.rect)||null,
          tag:(meta&&meta.tag)||"", saved:false };
  pending.push(p);
  renderShots();
  flashShot(pending.length-1);      // 让刚截的这张一眼就看见
  saveDraft();
  /* 截完要"看得见"：让 A4 预览自动滚到这张新图（图顶对齐视口顶）。
     以前重建只是原地不动，新图排在下面，得自己往下拖才找得到。 */
  a4Follow={ v:(editing?editing.v:state.cur), i:(editing?editing.i:-1),
             part:"img", k:pending.length-1, align:"top" };
  scheduleA4();                     // 截一张立刻排进右栏 A4 预览，实时看还剩多少空间
  toast("已加入 1 张截图，本条共 "+pending.length+" 张");
  return p;
}

/* ---------- 截图预览条 ---------- */
function shotCap(p){
  if(p.rect) return "第"+p.page+"页 局部";
  return "第"+p.page+"页 整页";
}
function renderShots(){
  var box=$("shotList"), fld=$("shotFld");
  if(!box) return;
  if(!pending.length){
    box.innerHTML=""; if(fld) fld.style.display="none";
    if($("shotTip")) $("shotTip").textContent="";
    return;
  }
  if(fld) fld.style.display="";
  box.innerHTML = pending.map(function(p,k){
    return '<div class="shot" data-k="'+k+'" title="点击放大核对">'+
      '<span class="sn">'+(k+1)+'</span>'+
      '<img src="'+p.url+'" alt="">'+
      '<button class="sx" data-act="del" title="删除这张">×</button>'+
      '<div class="smv"><button data-act="left" title="前移">◀</button>'+
      '<button data-act="right" title="后移">▶</button></div>'+
      '<div class="sc">'+esc(shotCap(p))+(p.saved?" 已存":"")+'</div></div>';
  }).join("") + '<span class="hint">按 1→'+pending.length+' 顺序插入 Word，每张单占一行<br>点图放大核对；× 删除，◀▶ 调序</span>';
  if($("shotTip")) $("shotTip").textContent="已附 "+pending.length+" 张截图";
}
function flashShot(k){
  var el=$("shotList") && $("shotList").querySelector('[data-k="'+k+'"]');
  if(!el) return;
  el.classList.add("new");
  try{ el.scrollIntoView({block:"nearest", inline:"nearest"}); }catch(e){}
  setTimeout(function(){ el.classList.remove("new"); }, 2200);
}
function delPending(k){
  var p=pending[k]; if(!p) return;
  pending.splice(k,1);
  try{ URL.revokeObjectURL(p.url); }catch(e){}
  if(p.saved) removedIds.push(p.id);   // 原图先记账，点「保存修改」才真删
  else idbDel("imgs", p.id);
  renderShots(); saveDraft(); scheduleA4();
  toast("已删除这张截图");
}
function movePending(k, d){
  var j=k+d; if(j<0||j>=pending.length) return;
  var t=pending[k]; pending[k]=pending[j]; pending[j]=t;
  renderShots(); flashShot(j); saveDraft(); scheduleA4();
}
/* 重截：按上次的页码和框选范围重新渲染一次（截歪了不用整条重来） */
async function retakeShot(k){
  var p=pending[k]; if(!p) return;
  if(!pdfDoc){ toast("PDF 已关闭，无法重截"); return; }
  if(!p.rect){
    toast(p.saved ? "这张是早先截的，没记录框选范围；重新框选一次截图，再把这张删掉"
                  : "整页截图没法重截，请直接再点「本页截图」", 5000);
    return;
  }
  busy(true);
  try{
    var blob=await renderRegion(p.rect, p.page);
    if(!blob){ toast("重截失败"); return; }
    var max=parseInt((($("sMax")&&$("sMax").value)||1600),10)||1600;
    var sh=await shrink(blob, max);
    await idbPut("imgs", p.id, sh.blob);
    try{ URL.revokeObjectURL(p.url); }catch(e){}
    p.url=URL.createObjectURL(sh.blob); p.w=sh.w; p.h=sh.h;
    renderShots(); flashShot(k); saveDraft(); scheduleA4();
    toast("已按原位置重截第 "+p.page+" 页");
  }catch(e){ console.error(e); toast("重截失败"); }
  finally{ busy(false); }
}
$("shotList").onclick=function(e){
  var card=e.target.closest("[data-k]"); if(!card) return;
  var k=parseInt(card.getAttribute("data-k"),10);
  var act=e.target.getAttribute("data-act");
  if(act==="del"){ e.stopPropagation(); delPending(k); return; }
  if(act==="left"){ e.stopPropagation(); movePending(k,-1); return; }
  if(act==="right"){ e.stopPropagation(); movePending(k,1); return; }
  openShotView({
    title:"本条截图（共 "+pending.length+" 张）",
    list: pending.map(function(p){ return {url:p.url, cap:shotCap(p)}; }),
    i:k,
    ocr: function(i){ readShot(i); },
    del: function(i){ openShotClose(); delPending(i); },
    re:  function(i){ openShotClose(); retakeShot(i); }
  });
};

/* ---------- 大图核对 ---------- */
function openShotView(v){
  shotView=v;
  $("vwTitle").textContent=v.title||"截图核对";
  $("vwDel").style.display=v.del?"":"none";
  $("vwRe").style.display =v.re ?"":"none";
  $("vwOcr").style.display=v.ocr?"":"none";
  $("dlgShot").classList.add("on");
  renderShotView();
}
function openShotClose(){ $("dlgShot").classList.remove("on"); $("vwImg").src=""; shotView=null; }
function renderShotView(){
  if(!shotView) return;
  var v=shotView, n=v.list.length;
  if(!n){ openShotClose(); return; }
  if(v.i>=n) v.i=n-1; if(v.i<0) v.i=0;
  var it=v.list[v.i];
  $("vwImg").src=it.url;
  $("vwMeta").textContent=it.cap||"";
  $("vwIdx").textContent=(v.i+1)+" / "+n;
  $("vwPrev").disabled = v.i<=0;
  $("vwNext").disabled = v.i>=n-1;
}
$("vwClose").onclick=openShotClose;
$("vwPrev").onclick=function(){ if(shotView&&shotView.i>0){ shotView.i--; renderShotView(); } };
$("vwNext").onclick=function(){ if(shotView&&shotView.i<shotView.list.length-1){ shotView.i++; renderShotView(); } };
$("vwDel").onclick=function(){ if(shotView&&shotView.del) shotView.del(shotView.i); };
$("vwRe").onclick=function(){ if(shotView&&shotView.re) shotView.re(shotView.i); };
$("vwOcr").onclick=function(){ if(shotView&&shotView.ocr) shotView.ocr(shotView.i); };
$("btnOcr").onclick=readPage;
$("dlgShot").onclick=function(e){ if(e.target===this) openShotClose(); };
/* 已加入条目的附图：回看顺序和内容（只读，要改就点开条目） */
async function openItemShots(i, start){
  var v=state.vols[state.cur]; if(!v) return;
  var it=v.items[i]; if(!it||!it.imgs||!it.imgs.length){ toast("这条没有附图"); return; }
  var list=[];
  for(var k=0;k<it.imgs.length;k++){
    var u=await imgUrl(it.imgs[k].id);
    if(u) list.push({url:u, cap:"第 "+(k+1)+" 张"+(it.imgs[k].page?("（原第"+it.imgs[k].page+"页）"):"")});
  }
  if(!list.length){ toast("附图读取失败"); return; }
  openShotView({title:label(it,0)+"　共 "+list.length+" 张", list:list, i:Math.min(start||0, list.length-1)});
}
document.addEventListener("paste", function(e){
  var its=e.clipboardData&&e.clipboardData.items; if(!its) return;
  var got=false;
  for(var i=0;i<its.length;i++){
    if(its[i].type&&its[i].type.indexOf("image/")===0){
      var f=its[i].getAsFile(); if(f){ addShot(f,false); got=true; }
    }
  }
  if(got && e.preventDefault) e.preventDefault();
});

/* ============ 标注行 ============ */
function pageSeg(it){
  var a=(it.p1||"").trim(), b=(it.p2||"").trim();
  if(a&&b&&a!==b) return "P"+a+"-"+b;
  if(a) return "P"+a;
  if(b) return "P"+b;
  return "";
}
function label(it, num){
  var s=pageSeg(it)+((it.mat||"").trim()? opt.sep+it.mat.trim() : "");
  if(it.mark) s+=it.mark;
  if(num) s=num+opt.sep+s;
  return s;
}
function blocks(it, num){
  var lab=label(it,num);
  var lines=(it.text||"").split(/\r?\n/).filter(function(s){return s.trim();});
  if(opt.inline && !(it.mat||"").trim() && lines.length) lab=lab+" "+lines.shift();
  /* 截图后文字：排在截图之后（原来的「疑点矛盾」），可多行 */
  var after=(it.note||"").split(/\r?\n/).filter(function(s){return s.trim();});
  return {lab:lab, lines:lines, after:after};
}
/* 一条摘录里的图最多能占多高（EMU）= 版心高 − 标注行 − 图下页码小字 − 卷首标题。
   以前整页扫描件正好等于版心高，上面再加一行标注就永远放不进一页，于是被切成两片、
   或者把整条挤到下一页留出一整页空白。这里永远先给标注行让出位置，图自动等比缩一点点，
   保证「标注行 + 图」落在同一页。 */
function imgMaxH(reservePt){
  /* 一条摘录的图最多占：版心 − 标注行 − 图前后间距 − 图上方页码小字 − 网格余量 − 卷首标题让位。
     图宽固定 12.7cm、高按比例，只有超出这个上限才等比缩小，保证「标注行 + 页码 + 图」落在同一页。 */
  var pt = (LINE()/20) + 6 + (opt.imgPage===false?0:14) + 25 + 16;
  pt += (reservePt||0);            // 卷首第一条额外让出卷名/总标题高度
  return Math.max(1200000, MAXH_EMU - Math.round(pt*12700));
}
/* 卷首那条还要给「卷名标题（+ 可选的总标题）」让位，否则第一页只有标题、图全跑下一页 */
function volHeadPt(withTitle){
  var pt = 26 + 8;                 // 卷名（16pt 行高 26pt）+ 段后
  if(withTitle) pt += 34 + 6;      // 总标题（22pt 行高 34pt）+ 段后
  return pt;
}
function calcSize(im, reservePt){
  var w=im.w||1000, h=im.h||1000, cx, cy, maxH=imgMaxH(reservePt);
  cx=IMG_W_EMU; cy=Math.round(cx*h/w);
  if(cy>maxH){ cy=maxH; cx=Math.round(cy*w/h); }
  return {cx:cx, cy:cy, center: cx<IMG_W_EMU*0.9};
}
/* 这张截图来自卷宗第几页：存的是 PDF 页号，加上这一卷的页码偏移才是卷宗页码 */
function shotPageNo(im, v){
  var p=parseInt(im && im.page, 10);
  if(!p || isNaN(p)) return "";
  var off=parseInt(v && v.offset, 10) || 0;
  var n=p+off;
  return n>0 ? String(n) : "";          // 落在前置页（封面/目录）里的，不标卷宗页码
}

/* ============ 左栏卷列表：搜索 + 总进度 ============ */
var volQ="";
function volMatch(v){
  if(!volQ) return true;
  var q=volQ.toLowerCase();
  return ((v.name||"")+" "+(v.no||"")+" "+(v.pdfName||"")).toLowerCase().indexOf(q)>=0;
}
function renderVols(){
  var total=state.vols.length;
  var done=state.vols.filter(function(x){ return x.items&&x.items.length; }).length;
  var arts=state.vols.reduce(function(a,x){ return a+((x.items&&x.items.length)||0); },0);
  $("volCnt").textContent = total? (total+" 本") : "";
  $("volProgBar").style.width = (total? Math.round(done*100/total) : 0)+"%";
  $("volProgTxt").textContent = done+" / "+total+" 卷";
  $("volProgBox").title = "已摘录 "+done+" 卷 / 共 "+total+" 卷，累计 "+arts+" 条摘录";
  if(!total){ $("volList").innerHTML='<div class="empty">还没有卷，点「选择 PDF」建卷</div>'; return; }
  var list=state.vols.map(function(v,i){ return {v:v,i:i}; }).filter(function(o){ return volMatch(o.v); });
  if(!list.length){
    $("volList").innerHTML='<div class="empty">没有匹配“'+esc(volQ)+'”的卷<br>'+
      '<a href="javascript:;" class="lnkq">清空搜索</a></div>';
    return;
  }
  $("volList").innerHTML = list.map(function(o){
    var v=o.v, i=o.i;
    var vlabel=esc(v.name)+(v.no?'（'+esc(v.no)+'）':'');
    return '<div class="vol-item'+(i===state.cur?' on':'')+'" data-v="'+i+'" title="'+vlabel+'">'+
      '<button class="vx ed" data-editv="'+i+'" title="修改卷名 / 卷号">✎</button>'+
      '<button class="vx" data-delv="'+i+'" title="删除这本卷">×</button>'+
      '<div class="vn"><span class="dot'+(v.pdfName?' ok':'')+'"></span><b>'+vlabel+'</b></div>'+
      '<div class="vm"><span>'+v.items.length+' 条</span>'+
      (v.pdfName && v.pdfName!==v.name ? '<span>'+esc(v.pdfName.slice(0,18))+'</span>'
                                        : (v.pdfName ? '' : '<span>未绑 PDF</span>'))+'</div></div>';
  }).join("");
  updateTrashBadge();
}
function setVolQ(q){
  volQ=String(q||"").trim();
  if($("fSearchVol").value!==volQ) $("fSearchVol").value=volQ;
  renderVols();
}

/* ============ 渲染 ============ */
function render(){
  renderVols();
  updateDraftBadge();
  /* PDF 预览必须跟着卷走：卷被删光、上传文档 / 恢复备份整批换了卷，
     预览不能留在原地（否则左边 0 卷、中间还挂着一份旧 PDF） */
  if(pdfDoc && !state.vols.some(function(x){ return x.id===pdfVolId; })) closePdf();

  var names={}; state.vols.forEach(function(v){ v.items.forEach(function(it){ if(it.mat) names[it.mat]=1; }); });
  ["起诉意见书","起诉书","讯问笔录","询问笔录","到案经过","受案登记表","立案决定书","拘留证","逮捕证",
   "批准逮捕决定书","变更羁押期限通知书","提请批准逮捕书","移送审查起诉告知书","指定管辖决定书","鉴定意见书",
   "请款单","客户电子回单","记账凭证","采购合同","中标通知书","企业代缴协议","证明","谈话笔录","情况说明"]
   .forEach(function(n){ names[n]=1; });
  $("matList").innerHTML = Object.keys(names).sort().map(function(n){ return '<option value="'+esc(n)+'"></option>'; }).join("");

  var v=state.vols[state.cur];
  $("epSub").textContent = v ? (v.name+(v.no?'（'+v.no+'）':'')+'　'+v.items.length+' 条') : "未选卷";
  $("topStat").textContent = state.vols.reduce(function(a,x){return a+x.items.length;},0)+" 条 / "+state.vols.length+" 卷";

  // 条目列表
  var box=$("itemList");
  if(!v || !v.items.length){ box.innerHTML='<div class="empty">本卷还没有摘录</div>'; }
  else{
    box.innerHTML = v.items.map(function(it,i){
      var b=blocks(it,0);
      return '<div class="it'+(editing&&editing.i===i?' on':'')+'" data-i="'+i+'" draggable="true">'+
        '<div class="iact">'+
          '<button class="mv" data-act="move" title="移到别的卷">移卷</button>'+
          '<button data-act="up" title="上移一位">↑</button>'+
          '<button data-act="down" title="下移一位">↓</button>'+
          '<button class="dgr" data-act="del" title="删除这一条">×</button>'+
        '</div>'+
        '<div class="l1">'+esc(b.lab)+'</div>'+
        (b.lines.length?'<div class="l2">'+esc(b.lines.join(" "))+'</div>':'')+
        ((it.imgs&&it.imgs.length)
          ? '<div class="ithumb" data-i="'+i+'" data-ids="'+it.imgs.map(function(im){return im.id;}).join(",")+'">'+
              '<span class="ph">附图 '+it.imgs.length+' 张</span></div>'
          : '')+
        /* 截图后文字是正文的延续，不是备注：字号、颜色跟正文一致（同 .l2），只是排在附图下面 */
        (b.after.length?'<div class="l2">'+esc(b.after.join(" "))+'</div>':'')+
        '</div>';
    }).join("");
  }
  observeItemThumbs();
  scheduleA4();
}

/* ---------- 条目里的附图缩略图：加入本卷之后也要看得见图，而不是一行文字 ---------- */
var itIO=null;
function observeItemThumbs(){
  var box=$("itemList"); if(!box) return;
  var rows=box.querySelectorAll(".ithumb[data-ids]");
  if(itIO){ try{ itIO.disconnect(); }catch(e){} }
  if(!rows.length) return;
  itIO=new IntersectionObserver(function(es){
    es.forEach(function(en){ if(en.isIntersecting) fillItemThumbs(en.target); });
  },{root:box, rootMargin:"240px 0px"});
  Array.prototype.forEach.call(rows, function(r){ itIO.observe(r); });
}
function fillItemThumbs(row){
  if(!row || row.getAttribute("data-done")) return;
  row.setAttribute("data-done","1");
  var ids=(row.getAttribute("data-ids")||"").split(",").filter(Boolean);
  var MAX=4, show=ids.slice(0,MAX);
  Promise.all(show.map(imgUrl)).then(function(us){
    var html="";
    us.forEach(function(u,k){ if(u) html+='<img src="'+u+'" data-k="'+k+'" alt="">'; });
    if(ids.length>MAX) html+='<span class="more">+'+(ids.length-MAX)+'</span>';
    row.innerHTML = html || '<span class="ph">附图读取失败</span>';
  }).catch(function(){
    row.innerHTML='<span class="ph">附图读取失败</span>';
  });
}
/* ---------- 搜索框：输入即过滤，Esc 清空，Ctrl+F 定位 ---------- */
$("fSearchVol").oninput=function(){ volQ=this.value.trim(); renderVols(); };
$("fSearchVol").addEventListener("keydown", function(e){
  if(e.key==="Escape"){ e.preventDefault(); e.stopPropagation(); setVolQ(""); this.blur(); }
  if(e.key==="Enter"){ e.preventDefault(); this.blur(); }
});
$("btnClearSearch").onclick=function(){ setVolQ(""); $("fSearchVol").focus(); };
document.addEventListener("keydown", function(e){
  if((e.ctrlKey||e.metaKey) && (e.key==="f"||e.key==="F")){
    if($("dlgShot") && $("dlgShot").classList.contains("on")) return;
    e.preventDefault();
    if($("sidebar").classList.contains("hide")) $("btnToggle").click();
    $("fSearchVol").focus(); $("fSearchVol").select();
  }
});

/* 切卷：左栏点卷、预览里点别的卷的正文，都走这里，保证行为一致 */
function selectVol(i){
  var v=state.vols[i]; if(!v) return;
  if(i===state.cur){ openPdfOfVol(i); return; }     // 点当前卷：不把正在写的表单清掉
  saveDraft();                                     // 切卷前先把没提交的内容存进草稿箱
  state.cur=i;
  $("fOffset").value = String(skipOf(v));          // 输入框显示「前置页」
  if(editing){ editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; }
  dropPending(false); resetFormFields();           // 图片留给草稿，不再直接删
  save(); render(); updatePageTip();
  openPdfOfVol(i);          // 这一卷绑了 PDF 就自动打开，切来切去不用再选一次
}
$("volList").onclick=function(e){
  if(e.target.closest(".lnkq")){ e.preventDefault(); setVolQ(""); return; }
  var ed=e.target.closest("[data-editv]");
  if(ed){ e.stopPropagation(); openVolDlg(parseInt(ed.getAttribute("data-editv"),10)); return; }
  var x=e.target.closest("[data-delv]");
  if(x){ e.stopPropagation(); delVolume(parseInt(x.getAttribute("data-delv"),10)); return; }
  var d=e.target.closest("[data-v]"); if(!d) return;
  selectVol(parseInt(d.getAttribute("data-v"),10));
};
/* ---------- 修改卷宗信息（名称 / 卷号 / 页码偏移） ---------- */
var volEdit=-1;
function openVolDlg(i){
  var v=state.vols[i]; if(!v) return;
  volEdit=i;
  $("volName").value=v.name||"";
  $("volNo").value=v.no||"";
  $("volOffset").value = String(skipOf(v));
  $("volHint").textContent = (v.pdfName? ("已绑 PDF："+v.pdfName) : "这本卷还没绑 PDF")
    + "　现有 "+v.items.length+" 条摘录";
  $("dlgVol").classList.add("on");
  setTimeout(function(){ $("volName").focus(); $("volName").select(); }, 30);
}
$("volCancel").onclick=function(){ $("dlgVol").classList.remove("on"); volEdit=-1; };
$("dlgVol").onclick=function(e){ if(e.target===this){ $("dlgVol").classList.remove("on"); volEdit=-1; } };
$("volOk").onclick=function(){
  var v=state.vols[volEdit]; if(!v){ $("dlgVol").classList.remove("on"); return; }
  var n=$("volName").value.trim();
  if(!n){ toast("卷名称不能为空"); $("volName").focus(); return; }
  v.name=n;
  v.no=$("volNo").value.trim();
  v.offset=-(parseInt($("volOffset").value,10)||0);   // 填写「前置页」，内部存 -N
  if(volEdit===state.cur) showOffsetInput();
  $("dlgVol").classList.remove("on"); volEdit=-1;
  save(); render(); updatePageTip(); scheduleA4();
  toast("已保存：《"+v.name+"》");
};
$("volName").addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); $("volOk").click(); } });
$("volNo").addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); $("volOk").click(); } });

$("volList").ondblclick=function(e){
  var d=e.target.closest("[data-v]"); if(!d) return;
  openVolDlg(parseInt(d.getAttribute("data-v"),10));
};
/* ============ A4 排版预览 ============
   跟导出 Word 用同一套参数：A4 210×297mm、上下边距 25.4mm、左右 31.7mm、版心 146.6mm、
   标题宋体 2 号、正文仿宋 3 号。按内容实际高度分页，看到的换页位置就是 Word 里的换页位置。 */
var a4On=false, a4Mode="cur", a4Timer=null;
var a4Scale=0;          // 0 = 适应宽度；>0 = 手动放大倍数（可超过 100%）
var a4Follow=null;      // 摘录后自动滚到这一条 {v,i}
/* 预览分页结果：导出 Word 时按它写死每页分页点和每张图的最终尺寸，
   保证「预览怎么排、Word 就怎么排」，不会一边压缩、一边又留白。 */
var layoutPlan=null;
var a4BuildSeq=0;       // 每次重建递增：旧的异步排版回来时发现序号变了就作废，别覆盖新结果
function fmtFont(){ return '"仿宋","FangSong","SimSun",serif'; }
function bodyCss(){
  return "font-family:"+fmtFont()+";font-size:"+((parseInt(SZ(),10)||32)/2)+"pt;line-height:"+(LINE()/20)+"pt;";
}
function a4Page(pages, n){
  var slot=document.createElement("div"); slot.className="a4-slot";
  var p=document.createElement("div"); p.className="a4-page";
  var b=document.createElement("div"); b.className="a4-body"; b.setAttribute("style", bodyCss());
  p.appendChild(b);
  var f=document.createElement("div"); f.className="a4-foot"; f.textContent=String(n); p.appendChild(f);
  slot.appendChild(p); pages.appendChild(slot);
  return b;
}
/* 右栏不一定有 21cm 宽，页面按容器宽度等比缩小，保证整页都能看见 */
function fitA4Pages(pages){
  if(!pages) return 1;
  var host=$("a4Box");
  var w=pages.clientWidth || (host&&host.clientWidth) || 360;
  var cs=window.getComputedStyle(pages);
  var pad=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);
  var avail=Math.floor(w-pad);
  if(!(avail>60)) avail=300;                    // 容器还没布局好时的兜底
  var fit=Math.min(1, avail/793.7);
  var s=(a4Scale>0)?a4Scale:fit;               // 0 = 适应宽度；手动放大可超过 100%
  Array.prototype.forEach.call(pages.querySelectorAll(".a4-slot"), function(slot){
    var p=slot.querySelector(".a4-page");
    if(!p) return;
    p.style.transform="scale("+s+")";
    slot.style.width=Math.round(793.7*s)+"px";
    slot.style.height=Math.round(1122.5*s)+"px";
  });
  // 放大超过适应宽度时，允许横向滚动，避免被裁掉
  if(793.7*s > avail+1){ pages.style.overflowX="auto"; pages.style.alignItems="flex-start"; }
  else { pages.style.overflowX="hidden"; pages.style.alignItems="center"; }
  updateA4ZoomLabel();
  return s;
}
function blk(cls, txt, style){
  var d=document.createElement("div");
  if(cls) d.className=cls;
  if(txt!=null) d.textContent=txt;
  if(style) d.setAttribute("style", style);
  return d;
}
function scheduleA4(){ clearTimeout(a4Timer); a4BuildSeq++; a4Timer=setTimeout(buildA4, 350); }
/* 重建预览时保住滚动位置：记下"视口顶部压着哪一页、页顶被切掉多少"，
   重建后照锚点还原。不然每截一张图预览就跳回第一页，每次都得重新往下拉。 */
function a4Anchor(){
  var box=$("a4Pages"); if(!box) return null;
  var slots=box.querySelectorAll(".a4-slot");
  if(!slots.length) return null;
  var br=box.getBoundingClientRect();
  for(var i=0;i<slots.length;i++){
    var r=slots[i].getBoundingClientRect();
    if(r.bottom>br.top+1) return { i:i, off:Math.round(br.top-r.top) };
  }
  return { i:slots.length-1, off:0 };
}
function a4Restore(pos){
  if(!pos) return;
  var box=$("a4Pages"); if(!box) return;
  var slots=box.querySelectorAll(".a4-slot"); if(!slots.length) return;
  var el=slots[Math.min(pos.i, slots.length-1)];
  var br=box.getBoundingClientRect(), r=el.getBoundingClientRect();
  var elTop=r.top-br.top+box.scrollTop;      // 这一页在内容坐标里的 y
  box.scrollTop=Math.max(0, elTop+pos.off);  // 还原成"同样被切掉这么多"
}
/* 把预览滚到某一条（条目块在缩放过的页里，用 rect 差值算位置，别用 offsetTop）
   align="top"：把这块的顶边贴到视口顶（刚截的图这样最直观，从图的开头看起） */
function a4ScrollTo(el, align){
  var box=$("a4Pages"); if(!box||!el) return;
  var br=box.getBoundingClientRect(), r=el.getBoundingClientRect();
  var elTop=r.top-br.top+box.scrollTop;
  if(align==="top") box.scrollTop=Math.max(0, elTop-10);
  else box.scrollTop=Math.max(0, elTop-(box.clientHeight-r.height)/2);
}
/* 找「刚才点的那一块」：优先精确到第几张截图（part=img 时配 data-k），
   找不到再退回这一条的第一个块。 */
function a4FollowEl(f){
  var box=$("a4Pages"); if(!box||!f) return null;
  var base='[data-v="'+f.v+'"][data-i="'+f.i+'"]';
  if(f.part){
    var list=box.querySelectorAll(base+'[data-part="'+f.part+'"]');
    if(f.k!=null){
      for(var i=0;i<list.length;i++){
        if(list[i].getAttribute("data-k")===String(f.k)) return list[i];
      }
    }
    if(list.length) return list[0];
  }
  return box.querySelector(base);
}
/* 只做最小位移：已经看得见就一点不动（点截图时视线绝不乱跳） */
function a4Nudge(el){
  var box=$("a4Pages"); if(!box||!el) return;
  var br=box.getBoundingClientRect(), r=el.getBoundingClientRect();
  var pad=8;
  if(r.height >= box.clientHeight-2*pad){       // 比视口还高的整页图：把顶边对齐就行
    if(r.top < br.top || r.top > br.bottom-40) box.scrollTop += (r.top-br.top)-pad;
    return;
  }
  if(r.top < br.top+pad) box.scrollTop -= (br.top+pad-r.top);
  else if(r.bottom > br.bottom-pad) box.scrollTop += (r.bottom-(br.bottom-pad));
}
/* 正在编辑、还没「加入本卷」的这条：表单填了字或截了图就算有 */
function hasDraftEntry(){
  if(pending && pending.length) return true;
  if(($("fP1").value||"").trim()||($("fP2").value||"").trim()) return true;
  if(($("fMat").value||"").trim()||($("fText").value||"").trim()||($("fNote").value||"").trim()) return true;
  return false;
}
/* 把正在编辑的内容拼成一条临时条目，塞进预览末尾，实时看排版还剩多少空间 */
function draftEntry(){
  return {
    p1:$("fP1").value, p2:$("fP2").value, mat:$("fMat").value, mark:$("fMark").value,
    text:$("fText").value, note:$("fNote").value,
    imgs: pending.map(function(p){ return {id:p.id, w:p.w, h:p.h, ext:p.ext, page:p.page, full:(p.full!==undefined?p.full:!p.rect)}; })
  };
}
async function buildA4(){
  var pages=$("a4Pages"); if(!pages) return;
  var seq=++a4BuildSeq;
  var vols = (a4Mode==="all") ? state.vols : (state.vols[state.cur]?[state.vols[state.cur]]:[]);
  var total = vols.reduce(function(a,v){ return a+v.items.length; },0);
  /* 记下这次分页结果，导出 Word 时照着写死（含每一处"从这里开始新的一页"） */
  var plan={ mode:a4Mode, items:{}, order:[], volPB:{}, titlePB:{} };
  var keep = (a4Follow && !a4Follow.keepView) ? null : a4Anchor();      // 要跟随新条目就跟随，否则原地不动
  /* 新内容先在屏外的 stage 里排好，最后一次换进来。
     以前是先把 #a4Pages 清空再一页页填，而这中间要 await 取图、浏览器会重绘——
     滚动位置被清成 0，用户看到的就是"点一下截图，画面跑回开头"。 */
  var stage=document.createElement("div");
  stage.setAttribute("style","position:absolute;left:-99999px;top:0;display:flex;flex-direction:column;"+
    "align-items:center;gap:10px;width:"+((pages.clientWidth||400))+"px;");
  document.body.appendChild(stage);
  if(!vols.length){
    $("a4Hint").textContent="";
    $("a4Hint").title="";
    $("a4Tip").textContent="这里会显示 A4 排版成品";
    if(stage.parentNode) stage.parentNode.removeChild(stage);
    layoutPlan=null;               // 内容都没了，导出不能再照旧分页
    a4Sel=null;
    placeA4Tools();                // 收起截图操作条
    pages.innerHTML='<div class="empty" style="background:#fff;padding:30px 40px;border-radius:8px">先点「选择 PDF」建一卷、摘几条，这里就是 A4 成品的样子</div>';
    pages.scrollTop=0; pages.scrollLeft=0;
    fitA4Pages(pages);
    return;
  }
  $("a4Hint").textContent = vols.length+" 卷 · "+total+" 条";
  $("a4Tip").textContent = editing
    ? ("正在改：第 "+(editing.i+1)+" 条　改完点「保存修改」或 Ctrl+Enter，预览会自动更新")
    : "点预览里的正文，可直接改这一条";
  $("a4Hint").title = "A4 210×297mm，上下页边距 25.4mm、左右 31.7mm，版心宽 146.6mm；"+
    "标题 宋体 2 号（22pt）、正文 仿宋 3 号（16pt），行距 "+(LINE()/20)+" 磅。预览里的换页位置就是导出 Word 的换页位置。";

  var meas=document.createElement("div");
  meas.setAttribute("style","position:absolute;left:-99999px;top:0;width:146.6mm;visibility:hidden;"+bodyCss());
  document.body.appendChild(meas);

  var pageNo=1, body=a4Page(stage, pageNo), used=0;
  var linePx = Math.round((LINE()/20)*(96/72));
  /* 每页少排一行的安全余量：Word 里每个段落会按 1/20 磅取整、图片行还有一点点下沉，
     整页累积下来能多出一两磅。不留余量时，预览里"刚好放下"的那一块到了 Word 就放不下，
     整条被挤到下一页（用户看到的就是"有的截图页跑了"）。
     留一行之后，Word 的实际余量永远够，导出的分页就和预览一模一样。 */
  var limit = (body.clientHeight || 930);

  /* 整页图独占一页后，body 置空；下一次放内容时再起新页，
     保证整页图之后的条目一定排在整页图后面，顺序绝不乱 */
  function ensureBody(){
    if(!body){ pageNo++; body=a4Page(stage, pageNo); used=0; }
  }
  /* 块的实际占位高度：offsetHeight 不含外边距，而且会四舍五入到整数像素——
     一行 25.33px 被记成 25px，几十行就差出半页，导出的页就和预览错开了。
     所以这里用 getBoundingClientRect 的精确高度，再加上上下外边距（标题有 6 磅段后）。 */
  function elH(el){
    var h=0;
    try{ h=el.getBoundingClientRect().height; }catch(e){}
    if(!h) h=el.offsetHeight||0;
    try{
      var cs=window.getComputedStyle(el);
      h += (parseFloat(cs.marginTop)||0) + (parseFloat(cs.marginBottom)||0);
    }catch(e){}
    return h;
  }
  function add(el){
    ensureBody();
    meas.appendChild(el);
    var h=elH(el);
    if(used>0 && used+h>limit){ pageNo++; body=a4Page(stage, pageNo); used=0; }
    body.appendChild(el);
    used+=h;
  }
  function newPage(){ pageNo++; body=a4Page(stage, pageNo); used=0; }
  function gap(n){ var d=blk("","", "height:"+(linePx*(n||1))+"px"); meas.appendChild(d); add(d); }
  /* 一条摘录（标注行 + 正文 + 附图 + 备注）当成一个整体：
     先量整条高度，当前页放不下就整条挪到下一页，绝不让标注行留在页底、图跑到下一页。
     ★ 图的高度不用 offsetHeight：图片是异步解码的，量的时候经常还是 0，
       于是整条被当成"只有一行标注"，塞在页底，等图加载完它只能自己跑到下一页——
       这就是"标题孤零零掉在页尾"的真正原因。高度直接取自算好的 EMU，量一次就准。 */
  function blockH(el){
    var dh=el.getAttribute && el.getAttribute("data-h");
    if(dh) return parseFloat(dh)||0;
    return elH(el);
  }
  function addItem(parts, keepTail){
    var hs=[], sum=0, i, j, starts=[];   /* starts[j]=1：第 j 块是从新的一页开始排的（导出时按它插分页） */
    for(i=0;i<parts.length;i++){
      meas.appendChild(parts[i]);
      var h=blockH(parts[i]);
      hs.push(h); sum+=h;
    }
    /* 头部 = 标注行 + 正文 + 第一张图（含它上方的页码小字）。头部必须同页：标注行不能孤页。
       之后的图（第二张起）各自独立：放得下就接着放，放不下才单独换页——
       不能因为后面有张大图，就把前面已经能放下的图和标注行一起挤到后面去。 */
    var headEnd=parts.length;
    for(i=0;i<parts.length;i++){
      if(parts[i].getAttribute && parts[i].getAttribute("data-part")==="img"){ headEnd=i+1; break; }
    }
    var headSum=0;
    for(i=0;i<headEnd;i++) headSum+=hs[i];
    ensureBody();
    /* 「截图 + 紧跟它的文字」是一件事，整条不能拆：
       带截图后文字的条目，只要整条高度不超过一页，就整条一起放（当前页放不下就整条挪页），
       标注行/正文/截图/紧跟文字永远同页——绝不会把文字甩到下一页开头当正文。
       整条比一页还高（文字特别长）时才退回下面的逐块排法，让文字从图下面接着往下续。 */
    if(keepTail && sum<=limit){
      if(used>0 && used+sum>limit){ newPage(); starts[0]=1; }
      for(j=0;j<parts.length;j++){
        var e2=parts[j];
        if(e2.parentNode===meas) meas.removeChild(e2);
        body.appendChild(e2);
      }
      used+=sum;
      return starts;
    }
    /* 只有「头部」放不下当前页剩余空间时，才整条从头换页（保住标注行+第一张图同页） */
    if(used>0 && used+headSum>limit){ newPage(); starts[0]=1; }
    /* 逐块排布：头部已保证放得下；头部之后的图放不下就单独换页，不影响前面 */
    for(j=0;j<parts.length;j++){
      var el=parts[j], eh=hs[j];
      if(el.parentNode===meas) meas.removeChild(el);
      if(used>0 && used+eh>limit){ newPage(); starts[j]=1; }
      body.appendChild(el); used+=eh;
    }
    return starts;
  }
  /* 标题后面至少留两行位置，别出现"标题孤零零挂在页底" */
  function ensureRoom(px){
    ensureBody();
    if(used>0 && limit-used < (px||linePx*2)) newPage();
  }

  try{
    /* ---- 封面 ---- */
    /* 封面/目录：单册导出时导出对话框承诺的也是"封面 + 目录 + 正文"，
       所以「当前卷」预览同样排出来，预览和导出才对得上。 */
    if(opt.cover){
      /* 封面版式只有一份清单（coverSpec），预览和导出 Word 都照它排，
         所以"预览看到的封面"和"导出的封面"永远一模一样。 */
      coverSpec(vols, total).forEach(function(L){
        var css="font-family:"+(L.fs?"仿宋,FangSong,serif":"宋体,SimSun,serif")+";"+
                "font-size:"+L.sz+"pt;line-height:"+headLinePt(L.sz)+"pt;";
        if(L.center) css+="text-align:center;";
        if(L.ind) css+="text-indent:"+L.ind+"em;";
        if(L.bold) css+="font-weight:700;";
        if(L.spc) css+="letter-spacing:"+(L.spc/20)+"pt;";
        /* 空行必须给死高度：浏览器里一个空的 div 没有行盒，高度是 0，
           而 Word 里每个空段落都占一整行——不写死，封面在预览里就会挤成一团。 */
        if(!L.t) css+="height:"+headLinePt(L.sz)+"pt;";
        add(blk("", L.t, css));
      });
      newPage();
    }
    /* ---- 目录 ---- */
    if(opt.toc){
      /* 六列表：序号 / 原卷 / 原页码 / 标题 / 页码 / 备注（版式见 TOCW 上方注释）。
         ★ 「原卷」只在"同一册、同一页"里合并：翻页就重新起一组。
         ★ 每页都是「目录」标题 + 一张独立表；原卷格用 rowspan 跨行，字在整格正中。
         ★ 行高按 TOCLH 固定，标题折两行才加高；原卷字竖排三行，若这一页
           这一册的行数不够高，就把组首行抬到三行高，保证字放得下。 */
      function tocTitleEl(){
        return blk("", tocTitle(), "text-align:center;font-family:宋体,SimSun,serif;font-size:"+
                   TOCTITLE_PT+"pt;line-height:"+headLinePt(TOCTITLE_PT)+"pt;margin-bottom:6pt;");
      }
      /* ① 每一行先只按标题折行数算高度；页码列等正文排完再回填 */
      var trows=[], tseq=0;
      vols.forEach(function(v,vi){
        var vl=tocVolLines(v, vi);
        v.items.forEach(function(it,ii){
          tseq++;
          var ml=tocLines(tocMat(it, ii===0), TOCW[3], TOCFS, 2);
          trows.push({ vi:vi, ii:ii, seq:tseq, vol:tocVolCell(v,vi), volLines:vl,
                       seg:tocLines(tocSeg(it), TOCW[2], TOCNUMFS, 1),
                       title:ml, hLines:Math.max(ml.length,1),
                       note:tocLines(tocNote(it), TOCW[5], TOCFS, 1),
                       h:0, pg:"" });
        });
      });
      /* ② 按"行"分页：标题 + 表头 + 数据行，留 4 磅余量。
            卷名可能翻页后才出现；新页首段若不够三行高，就把组首行加高，
            加高后重新分页，直到每页每册都放得下三行册名。 */
      var titleH=headLinePt(TOCTITLE_PT)+6;
      var pagePt=Math.round(limit*0.75)-4;
      var capLines=Math.max(1, Math.floor((pagePt-titleH)/TOCLH)-1);  // 减 1 = 表头
      var tpages=[];
      function splitTocPages(){
        var pages=[], cur=[], used=0;
        trows.forEach(function(r){
          if(cur.length && used+r.hLines>capLines){ pages.push(cur); cur=[]; used=0; }
          cur.push(r); used+=r.hLines;
        });
        if(cur.length) pages.push(cur);
        return pages;
      }
      for(var guard=0; guard<30; guard++){
        tpages=splitTocPages();
        var bumped=false;
        tpages.forEach(function(page){
          for(var a=0; a<page.length; a++){
            var b=a;
            while(b<page.length-1 && page[b+1].vi===page[a].vi) b++;
            var have=0;
            for(var k=a;k<=b;k++) have+=page[k].hLines;
            var need=page[a].volLines.length;
            if(have<need){ page[a].hLines+=need-have; bumped=true; }
            a=b;
          }
        });
        if(!bumped) break;
      }
      trows.forEach(function(r){ r.h=r.hLines*TOCLH; });
      /* ③ 逐页排：一张表 + 表头重复 + 原卷 rowspan */
      tpages.forEach(function(rows,pi){
        if(pi>0) newPage();
        add(tocTitleEl());
        var n=rows.length, startOf={}, spanOf={};
        for(var a=0;a<n;a++){
          var b=a;
          while(b<n-1 && rows[b+1].vi===rows[a].vi) b++;
          startOf[a]=1; spanOf[a]=b-a+1;
          a=b;
        }
        var tbl=document.createElement("table");
        tbl.style.cssText="width:100%;table-layout:fixed;border-collapse:collapse;margin:0;";
        var cg=document.createElement("colgroup");
        TOCW.forEach(function(w){
          var c=document.createElement("col");
          c.style.width=(w/8306*100).toFixed(4)+"%";
          cg.appendChild(c);
        });
        tbl.appendChild(cg);
        function tCell(tag, lines, sz, pgk, rowSpan){
          var td=document.createElement(tag);
          td.style.cssText="border:1px solid #000;padding:0 2.85pt;text-align:center;font-weight:400;"+
            "vertical-align:middle;box-sizing:border-box;overflow:hidden;"+
            "font-family:仿宋,FangSong,serif;font-size:"+sz+"pt;line-height:"+TOCLH+"pt;";
          if(rowSpan) td.rowSpan=rowSpan;
          (lines&&lines.length?lines:[""]).forEach(function(ln){
            var d=document.createElement("div"); d.style.whiteSpace="nowrap"; d.textContent=ln; td.appendChild(d);
          });
          if(pgk) td.setAttribute("data-pgk", pgk);    // 页码列先留空，正文排完再回填
          return td;
        }
        var thead=document.createElement("thead");
        var hr=document.createElement("tr");
        hr.style.height=TOCLH+"pt";
        TOCHEAD.forEach(function(t,k){
          hr.appendChild(tCell("th", [t], k===0||k===2||k===4 ? TOCNUMFS : TOCFS, null, 0));
        });
        thead.appendChild(hr); tbl.appendChild(thead);
        var tb=document.createElement("tbody");
        rows.forEach(function(r,ri){
          var tr=document.createElement("tr");
          tr.style.height=(r.hLines*TOCLH)+"pt";
          tr.appendChild(tCell("td", [String(r.seq)], TOCNUMFS, null, 0));
          if(startOf[ri]) tr.appendChild(tCell("td", r.volLines, TOCVOLFS, null, spanOf[ri]));
          tr.appendChild(tCell("td", r.seg, TOCNUMFS, null, 0));
          tr.appendChild(tCell("td", r.title, TOCFS, null, 0));
          tr.appendChild(tCell("td", [""], TOCNUMFS,
                               (a4Mode==="all" ? r.vi : state.cur)+":"+r.ii, 0));
          tr.appendChild(tCell("td", r.note, TOCFS, null, 0));
          tb.appendChild(tr);
        });
        tbl.appendChild(tb);
        ensureBody();
        body.appendChild(tbl);
        used+=elH(tbl);
      });
      plan.toc=tpages;               // 导出 Word 照这份分页一页一张表
      newPage();
    }
    /* ---- 正文 ---- */
    /* 封面/目录占了几页：它们不印页码、不计入编号。注意封面/目录末尾的 newPage()
       已经把「正文第一页」建出来了（空页），这页算正文的第 1 页，所以减 1。 */
    var frontSlots = stage.querySelectorAll(".a4-slot").length;
    var frontPages = frontSlots>0 ? frontSlots-1 : 0;
    for(var vi=0; vi<vols.length; vi++){
      var v=vols[vi];
      var rvi=(a4Mode==="all") ? vi : state.cur;      // 真实卷下标：点预览时靠它定位
      if(vi>0) newPage();
      /* 先把本卷清单备好，用于预判「第一条是不是纯整页扫描」 */
      var items = v.items.slice();
      var hasDraft = (rvi===state.cur && !editing && hasDraftEntry());
      if(hasDraft) items.push(draftEntry());
      /* 标题照常排：整页截图现在也按普通截图排进版心（P 页码落在版心内），
         不再铺满整页、也不再把标题压到图上。
         标题的行高/段后要与导出 Word 的 HEAD() 完全一致（行高 max(28, 字号*1.6) 磅、段后 6 磅），
         否则 Word 那里高一点点就会先把内容顶到下一页，导出的分页就跟预览对不上。 */
      var hasTitle = !!(opt.repTitle || vi===0);
      var pgT0=pageNo;
      if(hasTitle){
        ensureRoom(linePx*4);
        add(blk("h1", (state.case||"")+"阅卷摘录", "font-family:宋体,SimSun,serif;font-size:22pt;line-height:"+headLinePt(22)+"pt;margin-bottom:6pt;"));
      }
      var pgH1=pageNo;                       // 大标题排完之后在第几页
      var pgV0=pageNo;
      ensureRoom(linePx*3);
      var h2=blk("h2", v.name+(v.no?"（"+v.no+"）":""), "font-family:宋体,SimSun,serif;font-size:16pt;line-height:"+headLinePt(16)+"pt;margin-bottom:6pt;");
      h2.setAttribute("data-voltitle", rvi);             // 点卷名标题 = 改卷名/卷号/页码偏移
      h2.setAttribute("title", "点一下：改卷名 / 卷号 / 页码偏移");
      h2.classList.add("a4-voltitle");
      add(h2);
      /* 分页点挂在"真正起新页的那一段"上：
         · 第 2 卷起预览一开头就 newPage()，这页要挂在大标题（有的话）上，否则大标题会留在上一卷页底；
         · 第一卷里如果标题/卷名自己撑出了新页，也照实挂上去。 */
      plan.titlePB[rvi] = hasTitle && (vi>0 || pgH1>pgT0);
      plan.volPB[rvi]   = !plan.titlePB[rvi] && (vi>0 || pageNo>pgV0);
      for(var ii=0; ii<items.length; ii++){
        var isDraft = hasDraft && ii===items.length-1;
        var di = isDraft ? -1 : ii;                    // draft 条目 data-i=-1：点了不跳转，只聚焦表单
        var it=items[ii];
        /* 正在修改的这条：用表单里的实时数据（含 pending 截图）替换，预览就跟正常摘录一样实时更新，
           改着图就能看到 A4 成品怎么排 */
        if(editing && editing.v===rvi && editing.i===ii){ it = draftEntry(); }
        var b=blocks(it,0);
        var isEdit = isDraft || !!(editing && editing.v===rvi && editing.i===ii);
        // 每个文字块都挂上「哪一卷第几条」，点一下就能跳到右边改（见 a4Pages.onclick）
        function tag(el, part){
          el.setAttribute("data-v", rvi); el.setAttribute("data-i", di);
          if(part) el.setAttribute("data-part", part);   // lab/body/img/note：决定右边光标落在哪个框
          el.classList.add("a4-blk");
          if(isEdit) el.classList.add("a4-on");
          else el.setAttribute("title", isDraft ? "正在编辑的这条（还没加入本卷）" : "点一下：把这一条载入右边表单修改");
          return el;
        }
        var list=it.imgs||[];
        /* 卷首那条：首图按「当前页剩余空间」动态缩小，保证一定落在第 1 页（不把首图顶到下一页，
           也不让第一页只剩标题）。used 已是本页被标题占掉的高度（px），转成 pt 再加上标注行+
           页码小字+余量，就是这张图最多能占的高度。 */
        var resv = 0;
        if(ii===0){
          var usedPt = used * EMU_PER_PX / 12700;       // 已被标题占掉的高度(pt)
          resv = usedPt + (LINE()/20) + 14 + 6;         // 再给标注行+页码小字+余量让位
        }
        /* 截图后文字是正文的延续，必须紧跟着它那张截图：
           给这段文字预留位置，图自动等比缩一点点，让「截图 + 紧跟的正文」装得进一页。
           但最多把图压到版心高的 45%——再长的文字就让它在后面自然续页，
           不能为了塞字把整页扫描件缩成小图。 */
        var afterPt = 0;
        if(opt.note && b.after.length && list.length){
          var wantPt = b.after.length * (LINE()/20) + 6;
          var minH = MAXH_EMU * 0.45;
          var roomPt = Math.max(0, (imgMaxH(resv) - minH) / 12700);   // 这张图还能让出多少高度
          afterPt = Math.min(wantPt, roomPt);
        }
        var parts=[], szList=[];
        function pushText(){
          parts.push(tag(blk("lab", b.lab), "lab"));
          for(var li=0; li<b.lines.length; li++) parts.push(tag(blk("", b.lines[li]), "body"));
        }
        /* 截图后文字：它和上面那张截图是一起的（同一件事），直接接在 parts 末尾，
           由 addItem(…, keepTail=true) 保证「图 + 紧跟的文字」整体同页、绝不拆开 */
        function pushAfter(){
          if(!opt.note || !b.after.length) return;
          b.after.forEach(function(ln, ni){
            var el=tag(blk("", ln), "note"); el.setAttribute("data-note", String(ni)); parts.push(el);
          });
        }
        /* 顺序固定：标注行 → 正文 → 每张截图（整页扫描件也是这个排法，P 页码在图上方） */
        pushText();
        for(var k=0;k<list.length;k++){
          var u=await imgUrl(list[k].id);
          if(!u){ szList.push(null); continue; }
          var sz=calcSize(list[k], resv + (k===list.length-1 ? afterPt : 0));
          var wpx=sz.cx/EMU_PER_PX;                    // EMU → 屏幕像素，1:1 对应 Word 里的尺寸
          var hpx=sz.cy/EMU_PER_PX;
          /* 把「页码小字 + 截图」绑成一个整体(.imgcap)，保证 P 页码永远紧跟它对应的那张图，
             绝不会和图分在两页、或对到别的图上；整块高度一起参与分页 */
          var cap=blk("imgcap");
          var pn=shotPageNo(list[k], v);
          if(opt.imgPage!==false && pn){
            var pl=blk("imgpage","P"+pn);
            pl.setAttribute("data-h", String(PGNH));   // 与导出 PGNO 的 13 磅行高一致
            cap.appendChild(pl);
          }
          var wrap=blk("imgline");
          wrap.style.height=hpx+"px";                  // 高度先写死：量页面时不等图片解码
          if(sz.center) wrap.style.textAlign="center"; // 被限高的大图（竖图）居中，不顶左边留空白
          var im=document.createElement("img");
          im.src=u; im.style.width=wpx+"px"; im.style.height=hpx+"px"; im.style.maxWidth="none";
          wrap.appendChild(im);
          wrap.setAttribute("data-h", hpx);
          if(list[k].full) wrap.setAttribute("data-full", "1");   // 整页截图：允许拉伸铺满
          cap.appendChild(wrap);
          cap.setAttribute("data-h", (PGNH + hpx));     // 页码 + 图，整块按此高度分页
          cap.setAttribute("data-k", String(k));        // 第几张图：导出时按它对齐分页
          parts.push(tag(cap, "img"));
          szList.push({cx:Math.round(wpx*EMU_PER_PX), cy:Math.round(hpx*EMU_PER_PX)});
          resv=0;                                      // 只有首图按卷首剩余空间缩，其后用常规高度
        }
        pushAfter();                                 // 截图后文字：接在最后一张截图之后（同一整体）
        /* keepTail：最后一张截图 + 紧跟它的文字当成一个整体，永远同页 */
        var pgBefore=pageNo;              // 这条排下去之前在成稿第几页（1 基，含封面目录）
        var starts=addItem(parts, opt.note && b.after.length>0 && list.length>0);
        /* 记录：这条是不是新起了一页、哪张图/哪段文字换页了、每张图的最终尺寸（EMU）
           ——导出 Word 时照抄，预览怎么分页，Word 就怎么分页（所见即所得）。
           draft 那条不算，还没加入本卷。 */
        if(isDraft) continue;
        var imgPB={}, notePB={}, itemPB=false;
        for(var sp=0; sp<parts.length; sp++){
          if(!starts || !starts[sp]) continue;
          if(sp===0) itemPB=true;
          else if(parts[sp].getAttribute("data-part")==="img") imgPB[parts[sp].getAttribute("data-k")]=1;
          else if(parts[sp].getAttribute("data-part")==="note") notePB[parseInt(parts[sp].getAttribute("data-note"),10)||0]=1;
        }
        /* page：这一条从成稿第几页开始（1 基，含封面目录）。
           addItem 只可能在"这条开头"处换一次页（used>0 且放不下），所以 itemPB 为真就是下一页。
           目录的「页码」列填的就是它减去封面目录页数后的正文页码。 */
        var rec={ vi:rvi, ii:ii, newPage:itemPB, page:(itemPB ? pgBefore+1 : pgBefore),
                  pageEnd:pageNo,        // 这一条最后一行落在第几页（目录的「页码」要印 P起-P止）
                  imgPB:imgPB, notePB:notePB, imgs:szList };
        plan.items[rvi+":"+ii]=rec; plan.order.push(rec);
      }
    }
    /* 封面/目录不印页码、不计入编号：正文从第 1 页重新数（和导出 Word 的页码一致） */
    var allSlots=stage.querySelectorAll(".a4-slot");
    for(var s2=0;s2<allSlots.length;s2++){
      var ff=allSlots[s2].querySelector(".a4-foot"); if(!ff) continue;
      ff.textContent = (s2<frontPages) ? "" : String(s2-frontPages+1);
    }
    /* 目录「页码」列回填：正文已经排完，每条落在第几页现在才知道。
       「页码段」是卷宗 PDF 的页，「页码」是本文件成稿的第几页——两列不同的东西。
       行高是钉死的，只改格子里的字，不会把目录撑高、不会影响分页。 */
    var pgCells=stage.querySelectorAll("[data-pgk]");
    var tocFlat=[]; (plan.toc||[]).forEach(function(pp){ pp.forEach(function(r){ tocFlat.push(r); }); });
    for(var g=0; g<pgCells.length; g++){
      var rk=pgCells[g].getAttribute("data-pgk");
      var pgTxt=tocPage(plan.items[rk], frontPages);
      pgCells[g].textContent = pgTxt;
      if(tocFlat[g]) tocFlat[g].pg = pgTxt;     // 导出 Word 的页码列直接用这份
    }
    plan.front=frontPages;      // 导出 Word 算目录页码要用同一个偏移
    layoutPlan=plan;   // 预览刚排完，导出就用这份
  }catch(e){ console.error(e); }
  finally{
    if(meas.parentNode) meas.parentNode.removeChild(meas);
    if(seq!==a4BuildSeq){                    // 期间又重建过：这份旧结果直接作废
      if(stage.parentNode) stage.parentNode.removeChild(stage);
      return;
    }
    var follow=a4Follow; a4Follow=null;      // 一次性消费，别让两次重建都抢着跟随
    /* 同步一次性换入：清空 + 搬入 + 量尺寸 + 回位都在同一个任务里做完，
       中间不会重绘出一张空白页，滚动位置也就不会被"清成 0"。 */
    pages.innerHTML="";
    while(stage.firstChild) pages.appendChild(stage.firstChild);
    if(stage.parentNode) stage.parentNode.removeChild(stage);
    fitA4Pages(pages);
    /* 视线归位：点预览某一块（keepView）→ 以那一块为锚点，位置一点不动；
       新加/从左栏点某条 → 滚到那条；其他重建（改字、截图）→ 原地不动。 */
    function applyView(withFlash){
      var el=null;
      if(follow){
        el=a4FollowEl(follow);
        if(follow.keepView){
          if(el && follow.off!=null){
            var br0=pages.getBoundingClientRect(), r0=el.getBoundingClientRect();
            pages.scrollTop += (r0.top-br0.top)-follow.off;
          }else{
            a4Restore(keep);
          }
          if(el) a4Nudge(el);              // 万一排版微调了，也保证它还在视野里
        }else if(el){
          a4ScrollTo(el, follow.align);
        }
        if(el && withFlash){
          el.classList.add("a4-flash");
          setTimeout(function(){ try{ el.classList.remove("a4-flash"); }catch(e){} }, 1400);
        }
      }else{
        a4Restore(keep);
      }
      return el;
    }
    applyView(false);                  // 同一帧先归位，避免"换进来的一瞬间"闪到顶部
    // 竖向滚动条出现后容器会再窄十几像素，下一帧按新宽度再量一次，免得页面被右边裁掉
    requestAnimationFrame(function(){
      fitA4Pages(pages);
      applyView(true);
      if(a4Sel) placeA4Tools();     // 选中那张图换成了新元素，操作条重新贴上去
    });
  }
}
a4On=true;                       // 预览常驻在右栏下半部分，不再是标签页
$("a4Cur").onclick=function(){ a4Mode="cur"; $("a4Cur").classList.add("on"); $("a4All").classList.remove("on"); buildA4(); };
$("a4All").onclick=function(){ a4Mode="all"; $("a4All").classList.add("on"); $("a4Cur").classList.remove("on"); buildA4(); };
$("a4Re").onclick=function(){ buildA4(); };
/* ---------- A4 预览缩放：适应宽度 / 放大 / 缩小（像 PDF 那边一样） ---------- */
function a4FitVal(){
  var p=$("a4Pages"), host=$("a4Box");
  var w=p.clientWidth || (host&&host.clientWidth) || 360;
  var cs=window.getComputedStyle(p);
  var pad=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);
  var avail=Math.floor(w-pad); if(!(avail>60)) avail=300;
  return Math.min(1, avail/793.7);
}
function updateA4ZoomLabel(){
  var z=$("a4Zoom"); if(z) z.textContent = (a4Scale>0? Math.round(a4Scale*100)+"%" : "适应");
}
function setA4Scale(s){
  a4Scale=Math.max(0.2, Math.min(3, s));
  fitA4Pages($("a4Pages"));
}
$("a4Fit").onclick=function(){ a4Scale=0; fitA4Pages($("a4Pages")); };
$("a4In").onclick=function(){ setA4Scale((a4Scale>0?a4Scale:a4FitVal())*1.15); };
$("a4Out").onclick=function(){ setA4Scale((a4Scale>0?a4Scale:a4FitVal())*0.87); };
$("a4Zoom").onclick=function(){ a4Scale=0; fitA4Pages($("a4Pages")); };
/* 鼠标停在 A4 预览上，按住 Ctrl 滚轮直接缩放；放大超过栏宽后自动出现横向滚动条 */
$("a4Pages").addEventListener("wheel", function(e){
  if(!(e.ctrlKey||e.metaKey)) return;
  e.preventDefault();
  var base=(a4Scale>0 ? a4Scale : a4FitVal());
  setA4Scale(base*(e.deltaY<0 ? 1.1 : 0.9));
}, {passive:false});

/* ---------- 预览里选中一张截图：直接浮出「编辑 / OCR / 删除这张」 ----------
   以前想删一张图、或识别它的文字，都得跑到右边截图条里找。现在点中哪张图，
   就在那张图上弹出操作条：编辑（右边定位过去）、OCR 识别（文字追加到正文）、删除这张。 */
var a4Sel=null;    // {v,i,k}：预览里当前选中的是第几卷第几条的第几张图
function a4ShotEl(sel){
  if(!sel) return null;
  var box=$("a4Pages"); if(!box) return null;
  var list=box.querySelectorAll('[data-v="'+sel.v+'"][data-i="'+sel.i+'"][data-part="img"]');
  for(var i=0;i<list.length;i++){
    if(list[i].getAttribute("data-k")===String(sel.k)) return list[i];
  }
  return list.length ? list[0] : null;
}
/* 定位（重建后也调它：元素是新换的，靠 data-v/i/k 重新找回来） */
function placeA4Tools(){
  var t=$("a4Tools"); if(!t) return;
  var box=$("a4Pages"), pane=$("a4Box");
  if(box) Array.prototype.forEach.call(box.querySelectorAll(".a4-pick"), function(x){ x.classList.remove("a4-pick"); });
  var el=a4ShotEl(a4Sel);
  if(!el || !pane){ t.hidden=true; return; }
  el.classList.add("a4-pick");
  var pr=pane.getBoundingClientRect(), r=el.getBoundingClientRect();
  var vb=box?box.getBoundingClientRect():pr;
  /* 这张图被滚出视野了就别让按钮悬在半空 */
  if(r.bottom<vb.top+4 || r.top>vb.bottom-4){ t.hidden=true; return; }
  var lab=$("a4ToolsT");
  if(lab){
    var pgn=el.querySelector(".imgpage");
    var n=(parseInt(a4Sel.k,10)||0)+1;
    lab.textContent=(pgn&&pgn.textContent?pgn.textContent+" · ":"")+"第 "+n+" 张截图";
  }
  t.hidden=false;
  var tw=t.offsetWidth, th=t.offsetHeight;
  var left=Math.max(6, Math.min(pane.clientWidth-tw-6, r.left-pr.left));
  var top=r.top-pr.top-th-8;                              // 先放图上方
  if(top<6) top=Math.min(pane.clientHeight-th-6, r.bottom-pr.top+8);   // 上面放不下就放图下方
  top=Math.max(6, top);
  t.style.left=Math.round(left)+"px";
  t.style.top=Math.round(top)+"px";
}
function selectA4Shot(v,i,k){
  a4Sel={v:v, i:i, k:(k==null?-1:parseInt(k,10))};
  placeA4Tools();
}
function clearA4Shot(){ a4Sel=null; placeA4Tools(); }

/* 编辑：把右边定位到这一条的截图区（这条已经载入时就不再重复载入） */
function a4EditShot(s){
  if(s.i<0){ focusByPart("img"); return; }        // 还没加入本卷的草稿：直接聚焦右边截图区
  if(editing && editing.v===s.v && editing.i===s.i){ focusByPart("img"); return; }
  editItem(s.i, {part:"img", k:s.k, keepView:true}).then(function(){
    markA4Editing(s.v, s.i);
    focusByPart("img");
  }).catch(function(e){ console.error(e); });
}
/* OCR：识别这张图的文字，接到正文末尾（和右边「识别文字」是同一套逻辑） */
async function ocrA4Shot(s){
  var id=null;
  if(s.i===-1){ id=pending[s.k] && pending[s.k].id; }
  else if(editing && editing.v===s.v && editing.i===s.i){ id=pending[s.k] && pending[s.k].id; }
  if(!id){
    var it=state.vols[s.v] && state.vols[s.v].items[s.i];
    id=it && it.imgs && it.imgs[s.k] && it.imgs[s.k].id;
  }
  if(!id){ toast("找不到这张截图"); return; }
  busy(true);
  try{
    var b=await idbGet("imgs", id);
    if(!b){ toast("图片读取失败"); return; }
    var res=await ocrBlob(b);
    if(res.text && res.text.trim()){ appendText(res.text); toast("已识别这张图的文字，可能有误，请核对", 5000); }
    else if(res.src==="nobridge") toast("当前环境不支持 OCR", 4000);
    else toast("这张图没识别出文字"+(res.error?("："+res.error):"") , 5000);
  }catch(e){ console.error(e); toast("识别失败"); }
  finally{ busy(false); }
}
/* 删除：正在编辑这条 → 从待保存的截图里去掉；否则直接改数据并保存 */
function delA4Shot(s){
  var k=s.k;
  if(s.i===-1 || (editing && editing.v===s.v && editing.i===s.i)){
    if(k<0 || k>=pending.length){ toast("找不到这张截图"); return; }
    var wasSaved=!!pending[k].saved;
    delPending(k);
    clearA4Shot();
    if(wasSaved) toast("已从这条里移除这张截图（点「保存修改」生效，取消则恢复）", 4200);
    return;
  }
  var it=state.vols[s.v] && state.vols[s.v].items[s.i];
  if(!it || !it.imgs || !it.imgs[k]){ toast("找不到这张截图"); return; }
  pushUndo("删除截图", [it.imgs[k].id]);
  it.imgs.splice(k,1);
  save(); render(); scheduleA4();
  clearA4Shot();
  toast("已删除这张截图（Ctrl+Z 可撤回）");
}
$("a4Tools").onclick=function(e){
  var b=e.target.closest("[data-act]"); if(!b) return;
  e.preventDefault(); e.stopPropagation();
  var act=b.getAttribute("data-act");
  if(act==="close"){ clearA4Shot(); return; }
  if(!a4Sel) return;
  var s={v:a4Sel.v, i:a4Sel.i, k:a4Sel.k};
  if(act==="edit") a4EditShot(s);
  else if(act==="ocr") ocrA4Shot(s);
  else if(act==="del") delA4Shot(s);
};
/* 预览滚动 / 窗口变化时，操作条跟着那张图走 */
(function(){
  var box=$("a4Pages");
  if(box) box.addEventListener("scroll", function(){ if(a4Sel) placeA4Tools(); }, {passive:true});
  window.addEventListener("resize", function(){ if(a4Sel) placeA4Tools(); });
})();

/* ---------- 预览里点正文 = 直接改这一条 ----------
   预览是"照 Word 样子排的"，只读会很难受：点段落到右边表单里改，
   改完「保存修改」，预览马上跟着变。框选文字时不触发，免得想复制却跳走。 */
function markA4Editing(vi, ii){
  var box=$("a4Pages"); if(!box) return null;
  var hit=null;
  Array.prototype.forEach.call(box.querySelectorAll("[data-i]"), function(el){
    var same = (+el.getAttribute("data-v")===vi) && (+el.getAttribute("data-i")===ii);
    el.classList.toggle("a4-on", same);
    if(same && !hit) hit=el;
  });
  return hit;
}
function scrollA4To(el){
  if(!el) return;
  try{ el.scrollIntoView({block:"nearest", inline:"nearest"}); }catch(e){}
}
/* 在预览里点的是哪一块，右边就把光标放到对应的框：
   标题行→材料名称、正文→正文、备注→疑点、图→截图区。之前一律跳正文，点标题很别扭。 */
function focusByPart(part){
  var el=null;
  if(part==="lab") el=$("fMat");
  else if(part==="note") el=$("fNote");
  else if(part==="body") el=$("fText");
  else if(part==="img"||part==="imgpage") el=$("shotList");
  if(!el) el=$("fText");
  try{ el.scrollIntoView({block:"nearest"}); }catch(e){}
  if(el===document.body || !el.focus) return;
  if(el.tagName==="INPUT" || el.tagName==="TEXTAREA"){
    try{ el.focus({preventScroll:true}); }catch(e){ el.focus(); }
    var n=(el.value||"").length;
    try{ el.setSelectionRange(n,n); }catch(e){}     // 光标放末尾，别整段选中被一次误删
  }else{
    el.classList.add("flash");                       // 截图区：闪一下，告诉用户在哪
    setTimeout(function(){ el.classList.remove("flash"); }, 900);
  }
}
$("a4Pages").onclick=function(e){
  var sel=window.getSelection && String(window.getSelection());
  if(sel && sel.length) return;                    // 正在选文字准备复制，别抢
  /* 点卷名标题 → 改卷名（这也是"标题"，别让点上去没反应） */
  var vt=e.target.closest("[data-voltitle]");
  if(vt && this.contains(vt)){ openVolDlg(parseInt(vt.getAttribute("data-voltitle"),10)); return; }
  var d=e.target.closest("[data-i]");
  if(!d || !this.contains(d)){ clearA4Shot(); return; }   // 点到页边空白：收起操作条
  var vi=parseInt(d.getAttribute("data-v"),10), ii=parseInt(d.getAttribute("data-i"),10);
  if(isNaN(vi)||isNaN(ii)) return;
  var part=d.getAttribute("data-part")||"body";
  /* 点中一张截图 → 在它上面浮出「编辑 / OCR 识别 / 删除这张」，
     删除和 OCR 不用再跑到右边截图条里找按钮 */
  if(part==="img") selectA4Shot(vi, ii, d.getAttribute("data-k"));
  else clearA4Shot();
  /* 点的是「正在编辑、还没加入」的那条（data-i=-1）→ 直接聚焦右边对应输入框，不做跳转 */
  if(ii===-1){
    if(part!=="img") focusByPart(part);
    return;
  }
  var v=state.vols[vi]; if(!v||!v.items[ii]) return;
  if(vi!==state.cur){
    selectVol(vi);
    toast("已切到《"+v.name+(v.no?"（"+v.no+"）":"")+"》", 2000);
  }
  /* 点的是哪一块（标注行/正文/某张截图），就牢牢停在那一块：keepView 让预览一味不滚，
     只把这一块闪一下。以前这里会滚到"这一条的第一个块"，点第三张图会一下跳回这条开头。 */
  var a4box=$("a4Pages"), off=null;
  if(a4box){
    var brA=a4box.getBoundingClientRect(), rA=d.getBoundingClientRect();
    off=Math.round(rA.top-brA.top);            // 点中的这块现在离视口顶多远
  }
  editItem(ii, {part:part, k:d.getAttribute("data-k"), keepView:true, off:off}).then(function(){
    markA4Editing(vi, ii);
    var row=$("itemList").querySelector('.it[data-i="'+ii+'"]');
    if(row){ row.classList.add("on"); try{ row.scrollIntoView({block:"nearest"}); }catch(e){} }
    focusByPart(part);                             // 点哪块，光标就落在对应框里
  }).catch(function(err){ console.error(err); });
};

/* 中间两块预览之间的竖分隔条：左右拖，PDF 和 A4 谁宽谁窄自己定（双击回默认） */
(function(){
  var dragging=false;
  /* 窄窗口里 PDF 至少要留出的宽度；再小就两边都用不了 */
  function minPdfW(total){ return total<680 ? 260 : 340; }
  /* 自适应默认宽度：A4 尽量大，但不把 PDF 挤没；大屏封顶 680，避免一页占满 */
  function defaultW(){
    var host=$("previews");
    var total=(host.clientWidth || 900)-7;      // 减掉中间那条竖分隔条
    return Math.min(680, Math.max(300, total-minPdfW(total)));
  }
  window.__a4DefaultW=defaultW;
  function clampW(px){
    var host=$("previews");
    var total=(host.clientWidth || 900)-7;
    return Math.max(200, Math.min(total-minPdfW(total), px));
  }
  function setW(px){
    var w=clampW(px);
    $("a4Box").style.flex="0 0 "+w+"px";
    fitA4Pages($("a4Pages"));
    return w;
  }
  window.__setA4W=setW;
  function startDrag(e){
    dragging=true; e.preventDefault();
    document.body.style.cursor="col-resize";
    $("vspl").classList.add("drag");
  }
  $("vspl").addEventListener("mousedown", startDrag);
  $("vspl").addEventListener("dblclick", function(){
    opt.a4w=0; save();                 // 双击 = 回到「按窗口自适应」
    setW(defaultW());
    buildA4();
  });
  document.addEventListener("mousemove", function(e){
    if(!dragging) return;
    var host=$("previews").getBoundingClientRect();
    setW(Math.round(host.right - e.clientX));
  });
  document.addEventListener("mouseup", function(){
    if(!dragging) return;
    dragging=false; document.body.style.cursor=""; $("vspl").classList.remove("drag");
    opt.a4w=parseInt($("a4Box").style.flex.replace(/[^0-9]/g,""),10)||0;
    save();
    buildA4();                            // 宽度变了，A4 要按新宽度重排缩放
    if(pdfDoc && !opt.pz){ fitScale().then(refreshPdfPages).catch(function(){}); }   // PDF 也跟着重新适应
  });
})();

$("itemList").onclick=function(e){  var card=e.target.closest("[data-i]");
  var act=e.target.getAttribute("data-act");
  if(act && card){
    e.stopPropagation();
    var i=parseInt(card.getAttribute("data-i"),10);
    if(act==="del") delItem(i);
    else if(act==="up") moveItem(i,-1);
    else if(act==="down") moveItem(i,1);
    else if(act==="move") openMoveDialog(i);
    return;
  }
  // 点条目里的小缩略图 → 直接看大图，并定位到点的那一张
  var th=e.target.closest(".ithumb");
  if(th && (e.target.tagName||"").toLowerCase()==="img"){
    e.stopPropagation();
    openItemShots(parseInt(th.getAttribute("data-i"),10), parseInt(e.target.getAttribute("data-k"),10)||0);
    return;
  }
  if(!card) return;
  editItem(parseInt(card.getAttribute("data-i"),10)).catch(function(err){ console.error(err); toast("打开失败"); });
};

/* ---------- 条目：删除 / 上下移 / 拖拽排序 / 移到别的卷 ---------- */
function fixEditingAfter(from, to){
  if(!editing) return;
  if(editing.i===from){ editing.i=to; return; }
  if(from<editing.i && to>=editing.i) editing.i--;
  else if(from>editing.i && to<=editing.i) editing.i++;
}
function delItem(i){
  var v=state.vols[state.cur]; if(!v||!v.items[i]) return;
  var it=v.items[i], lab=blocks(it,0).lab || "这一条";
  var diIds=(it.imgs||[]).map(function(im){return im.id;});
  pushUndo("删除一条摘录", diIds);
  if(!confirm("删除「"+lab+"」"+(it.imgs&&it.imgs.length?("（含 "+it.imgs.length+" 张附图）"):"")+"？\n\n删了可用顶部「撤回」恢复（Ctrl+Z）。")) return;
  (it.imgs||[]).forEach(function(im){ idbDel("imgs", im.id); });
  v.items.splice(i,1);
  if(editing){
    if(editing.i===i){ editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; }
    else if(editing.i>i) editing.i--;
  }
  save(); render(); saveDraft(); toast("已删除该条");
}
function moveItem(i,d){
  var v=state.vols[state.cur]; if(!v) return;
  var j=i+d; if(j<0||j>=v.items.length) return;
  var t=v.items[i]; v.items[i]=v.items[j]; v.items[j]=t;
  fixEditingAfter(i,j);
  save(); render(); saveDraft();
}
function reorderItem(from, to, before){
  var v=state.vols[state.cur]; if(!v) return;
  if(from===to) return;
  var it=v.items.splice(from,1)[0];
  var idx = to + (before?0:1);
  if(from < idx) idx--;
  idx=Math.max(0, Math.min(v.items.length, idx));
  v.items.splice(idx,0,it);
  fixEditingAfter(from, idx);
  save(); render(); saveDraft();
  toast("已调整到第 "+(idx+1)+" 条");
}
function clearDropMarks(){
  Array.prototype.forEach.call($("itemList").querySelectorAll(".it"), function(el){
    el.classList.remove("dropbefore"); el.classList.remove("dropafter"); el.classList.remove("dragging");
  });
}
var dragFrom=-1;
$("itemList").addEventListener("dragstart", function(e){
  var c=e.target.closest("[data-i]"); if(!c) return;
  dragFrom=parseInt(c.getAttribute("data-i"),10);
  c.classList.add("dragging");
  try{ e.dataTransfer.effectAllowed="move"; e.dataTransfer.setData("text/plain", String(dragFrom)); }catch(err){}
});
$("itemList").addEventListener("dragover", function(e){
  if(dragFrom<0) return;
  var c=e.target.closest("[data-i]"); if(!c) return;
  e.preventDefault();
  var r=c.getBoundingClientRect(), before=(e.clientY < r.top + r.height/2);
  Array.prototype.forEach.call($("itemList").querySelectorAll(".it"), function(el){
    el.classList.remove("dropbefore"); el.classList.remove("dropafter");
  });
  c.classList.add(before?"dropbefore":"dropafter");
});
$("itemList").addEventListener("drop", function(e){
  if(dragFrom<0) return;
  var c=e.target.closest("[data-i]"); if(!c) return;
  e.preventDefault();
  var to=parseInt(c.getAttribute("data-i"),10);
  var r=c.getBoundingClientRect(), before=(e.clientY < r.top + r.height/2);
  var from=dragFrom; dragFrom=-1;
  clearDropMarks();
  reorderItem(from, to, before);
});
$("itemList").addEventListener("dragend", function(){ dragFrom=-1; clearDropMarks(); });

/* 移到别的卷 */
var moveFrom=-1;
function openMoveDialog(i){
  var cur=state.vols[state.cur]; if(!cur||!cur.items[i]) return;
  if(state.vols.length<2){ toast("只有一卷，没法移"); return; }
  moveFrom=i;
  var it=cur.items[i];
  $("mvHint").textContent="当前在《"+cur.name+"》· "+(blocks(it,0).lab||"这一条")
    +(it.imgs&&it.imgs.length?("，含 "+it.imgs.length+" 张附图"):"");
  $("mvVol").innerHTML = state.vols.map(function(v,k){
    if(k===state.cur) return "";
    return '<option value="'+k+'">'+esc(v.name+(v.no?"（"+v.no+"）":""))+'　现有 '+v.items.length+' 条</option>';
  }).join("");
  $("dlgMove").classList.add("on");
}
$("mvCancel").onclick=function(){ $("dlgMove").classList.remove("on"); moveFrom=-1; };
$("dlgMove").onclick=function(e){ if(e.target===this){ $("dlgMove").classList.remove("on"); moveFrom=-1; } };
$("mvOk").onclick=function(){
  var k=parseInt($("mvVol").value,10);
  var cur=state.vols[state.cur], to=state.vols[k];
  if(!to || k===state.cur || moveFrom<0){ $("dlgMove").classList.remove("on"); return; }
  var it=cur.items.splice(moveFrom,1)[0];
  to.items.push(it);
  if(editing){
    if(editing.i===moveFrom){ editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none"; dropPending(false); resetFormFields(); }
    else if(editing.i>moveFrom) editing.i--;
  }
  $("dlgMove").classList.remove("on"); moveFrom=-1;
  save(); render(); saveDraft();
  toast("已移到《"+to.name+"》第 "+to.items.length+" 条");
};

/* ============ 条目增删改 ============ */
function dropPending(del){
  pending.forEach(function(p){
    try{ URL.revokeObjectURL(p.url); }catch(e){}
    // 已存在的原图（saved）绝不在这里删：放弃编辑要能还原
    if(del && !p.saved) idbDel("imgs", p.id);
  });
  pending=[]; removedIds=[];
  renderShots();
}
function resetFormFields(){
  ["fP1","fP2","fMat","fText","fNote"].forEach(function(id){ $(id).value=""; });
  $("fMark").value=""; renderShots();
}

/* ---------- 草稿箱 ----------
   还没提交的摘录（表单文字 + 已截的图）自动存进草稿箱：
   按「哪一卷 + 改哪一条」各占一条，打字时 0.7 秒落一次盘；
   切卷、换条目之前先快照，不再悄悄丢掉。提交、清空、取消才删对应那条。 */
var draftTimer=null;
var DRAFTS=[];
var draftWrite=Promise.resolve();
function stamp(){ var d=new Date(); return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)+":"+("0"+d.getSeconds()).slice(-2); }
function scheduleDraft(){ clearTimeout(draftTimer); draftTimer=setTimeout(saveDraft, 700); }

/* 当前表单属于哪条草稿：编辑某条 = e:条目id；新摘录 = n:卷id */
function draftSlot(){
  if(editing){
    var ev=state.vols[editing.v], eit=ev && ev.items[editing.i];
    if(eit) return { key:"e:"+eit.id, vol:ev, itemId:eit.id, itemIdx:editing.i, edit:true };
  }
  var v=state.vols[state.cur];
  return v ? { key:"n:"+v.id, vol:v, itemId:null, itemIdx:null, edit:false } : null;
}
function formDirty(){
  return ["fP1","fP2","fMat","fText","fNote"].some(function(id){ return String($(id).value||"").trim(); })
      || $("fMark").value || pending.length>0;
}
function sameAsItem(item){
  if(!item) return false;
  if($("fP1").value.trim()!==String(item.p1||"").trim()) return false;
  if($("fP2").value.trim()!==String(item.p2||"").trim()) return false;
  if($("fMat").value.trim()!==String(item.mat||"").trim()) return false;
  if($("fMark").value!==String(item.mark||"")) return false;
  if($("fText").value!==String(item.text||"")) return false;
  if($("fNote").value.trim()!==String(item.note||"").trim()) return false;
  var a=(item.imgs||[]).map(function(x){ return x.id; }).join(",");
  var b=pending.map(function(p){ return p.id; }).join(",");
  return a===b;
}
function findDraft(key){
  for(var i=0;i<DRAFTS.length;i++) if(DRAFTS[i].key===key) return i;
  return -1;
}
function persistDrafts(){
  var snap=JSON.stringify(DRAFTS);
  draftWrite=draftWrite.then(function(){ return idbPut("meta","drafts",snap); }).catch(function(){});
  return draftWrite;
}
function dropDraftByKey(key){
  var i=findDraft(key); if(i<0) return;
  DRAFTS.splice(i,1);
  persistDrafts(); updateDraftBadge(); renderDraftList();
}
function updateDraftBadge(){
  var n=DRAFTS.length;
  var c=$("draftCnt"); if(c) c.textContent=String(n);
  var b=$("btnDrafts");
  if(b) b.title = n ? ("草稿箱里有 "+n+" 条没提交的摘录，点这里查看 / 恢复") : "没提交的摘录会自动存进草稿箱，点这里查看";
}
function saveDraft(){
  try{
    var slot=draftSlot(); if(!slot) return;
    if(!formDirty()) return;                      // 空表单不动草稿箱：清空 / 取消会明确删
    if(slot.edit && sameAsItem(slot.vol.items[slot.itemIdx])) return;   // 只是打开看了看，没改
    var d={ key:slot.key, volId:slot.vol.id, volName:slot.vol.name||"", volNo:slot.vol.no||"",
            itemId:slot.itemId, at:Date.now(),
            p1:$("fP1").value, p2:$("fP2").value, mat:$("fMat").value,
            mark:$("fMark").value, text:$("fText").value, note:$("fNote").value,
            imgs: pending.map(function(p){ return {id:p.id,w:p.w,h:p.h,ext:p.ext,
                    page:p.page, full:(p.full!==undefined?p.full:!p.rect), saved:!!p.saved}; }) };
    var i=findDraft(slot.key);
    if(i>=0) DRAFTS[i]=d; else DRAFTS.unshift(d);
    persistDrafts(); updateDraftBadge(); renderDraftList();
    $("topStat").textContent="草稿已存 "+stamp();
  }catch(e){}
}
/* 老版本只存一条 meta.draft：启动时搬进草稿箱，不丢旧内容 */
async function migrateOldDraft(){
  try{
    var raw=await idbGet("meta","draft"); if(!raw) return;
    var d=JSON.parse(raw); if(!d) return;
    var v=state.vols[d.volIdx]; if(!v) return;
    if(!(d.p1||d.p2||d.mat||d.text||d.note||(d.imgs&&d.imgs.length))) return;
    var it=(d.editIdx!=null) ? v.items[d.editIdx] : null;
    DRAFTS=[{ key:it?("e:"+it.id):("n:"+v.id), volId:v.id, volName:v.name||"", volNo:v.no||"",
              itemId:it?it.id:null, at:Date.now(),
              p1:d.p1||"", p2:d.p2||"", mat:d.mat||"", mark:d.mark||"", text:d.text||"", note:d.note||"",
              imgs:(d.imgs||[]).map(function(x){ return {id:x.id,w:x.w,h:x.h,ext:x.ext,
                    page:x.page||1, full:(x.full!==undefined?x.full:true), saved:!!x.saved}; }) }];
    persistDrafts();
  }catch(e){}
}
async function loadDraft(){
  try{
    var raw=await idbGet("meta","drafts");
    DRAFTS=[];
    if(raw){ try{ var arr=JSON.parse(raw); if(Array.isArray(arr)) DRAFTS=arr; }catch(e){} }
    if(!DRAFTS.length) await migrateOldDraft();
    updateDraftBadge();
    if(!DRAFTS.length) return;
    var sorted=DRAFTS.slice().sort(function(a,b){ return (b.at||0)-(a.at||0); });
    for(var i=0;i<sorted.length;i++){
      if(state.vols.some(function(v){ return v.id===sorted[i].volId; })){
        await restoreDraftByKey(sorted[i].key, true);
        return;
      }
    }
  }catch(e){}
}
function draftTitle(rec){
  var t=String(rec.mat||"").trim();
  if(!t) t=String(rec.text||"").replace(/\s+/g," ").trim().slice(0,24);
  if(!t) t=(rec.imgs&&rec.imgs.length) ? "（只有截图）" : "（空）";
  return t;
}
function renderDraftList(){
  var box=$("draftList"); if(!box) return;
  if(!$("dlgDrafts").classList.contains("on")) return;   // 没开就不重建，省得打字时白忙
  if(!DRAFTS.length){
    box.innerHTML='<div class="empty">草稿箱是空的<br>右边表单里打的内容、截的图会自动存到这里，不用手动保存</div>';
    return;
  }
  var list=DRAFTS.slice().sort(function(a,b){ return (b.at||0)-(a.at||0); });
  box.innerHTML=list.map(function(rec){
    var alive=state.vols.some(function(v){ return v.id===rec.volId; });
    var when=rec.at ? new Date(rec.at).toLocaleString() : "";
    var pg=(rec.p1||rec.p2) ? ("P"+(rec.p1||"?")+(rec.p2&&rec.p2!==rec.p1?("-"+rec.p2):"")) : "页码未填";
    return '<div class="trash-item">'+
      '<div class="ti-main"><b>'+esc(rec.volName||"未命名卷")+(rec.volNo?'（'+esc(rec.volNo)+'）':'')+
        (rec.itemId?' · 修改':' · 新摘录')+'</b>'+
      '<span class="tip-line">'+esc(when)+' · '+esc(pg)+' · '+esc(draftTitle(rec))+
        (rec.imgs&&rec.imgs.length?(' · '+rec.imgs.length+' 张截图'):'')+'</span>'+
      (alive?'':'<span class="tip-line" style="color:var(--red)">这本卷已经删除，恢复不了</span>')+'</div>'+
      '<div class="ti-act">'+(alive?'<button class="btn sm" data-drestore="'+esc(rec.key)+'">恢复</button>':'')+
        '<button class="btn sm dgr" data-ddel="'+esc(rec.key)+'">删除草稿</button>'+
      '</div></div>';
  }).join("");
}
function openDrafts(){ $("dlgDrafts").classList.add("on"); renderDraftList(); }
function closeDrafts(){ $("dlgDrafts").classList.remove("on"); }
async function restoreDraftByKey(key, auto){
  var rec=DRAFTS[findDraft(key)]; if(!rec) return false;
  var idx=-1;
  for(var i=0;i<state.vols.length;i++) if(state.vols[i].id===rec.volId){ idx=i; break; }
  if(idx<0){ toast("《"+(rec.volName||"这卷")+"》已经删除，草稿恢复不了", 4000); return false; }
  if(!auto){
    saveDraft();                                  // 先把正在写的东西收进草稿箱
    closeDrafts();
  }
  pending.forEach(function(p){ try{ URL.revokeObjectURL(p.url); }catch(e){} });
  pending=[]; removedIds=[];
  var v=state.vols[idx];
  state.cur=idx;
  $("fOffset").value=String(skipOf(v));
  var item=null, ii=-1;
  if(rec.itemId){ (v.items||[]).forEach(function(it,k){ if(it.id===rec.itemId){ item=it; ii=k; } }); }
  editing=item ? {v:idx, i:ii} : null;
  $("btnAdd").textContent=editing?"保存修改":"加入本卷";
  $("btnCancel").style.display=editing?"":"none";
  $("fP1").value=rec.p1||""; $("fP2").value=rec.p2||"";
  $("fMat").value=rec.mat||""; $("fMark").value=rec.mark||"";
  $("fText").value=rec.text||""; $("fNote").value=rec.note||"";
  var ids=rec.imgs||[];
  for(var k=0;k<ids.length;k++){
    var b=await idbGet("imgs", ids[k].id);
    if(b) pending.push({id:ids[k].id, w:ids[k].w, h:ids[k].h, ext:ids[k].ext,
      url:URL.createObjectURL(b), page:ids[k].page||1,
      rect:ids[k].full===false?{x:0,y:0,w:1,h:1}:null,
      full:ids[k].full!==false, saved:!!ids[k].saved});
  }
  renderShots();
  if(auto){
    if(pending.length) toast("已恢复上次没写完的编辑内容（含 "+pending.length+" 张截图）");
    else toast("已恢复上次没写完的编辑内容");
    return true;
  }
  save(); render(); updatePageTip(); openPdfOfVol(idx); scheduleA4();
  toast("已从草稿箱恢复《"+(v.name||"")+"》的内容"+(pending.length?("（含 "+pending.length+" 张截图）"):""), 4000);
  return true;
}
/* 删除草稿：只清这条记录；它单独截的图（没被任何条目/回收站/别的草稿引用）一并清掉 */
function deleteDraft(key){
  var i=findDraft(key); if(i<0) return;
  var rec=DRAFTS[i];
  if(!confirm("删除这条草稿？\n\n《"+(rec.volName||"未命名卷")+"》\n页码："+
      ((rec.p1||"?")+(rec.p2?("-"+rec.p2):""))+"\n\n只删这条草稿；已经加入的摘录和它们引用的截图不受影响。")) return;
  var slot=draftSlot(); var live=slot && slot.key===key;   // 正在表单里的这条：图先留着，别把预览弄坏
  DRAFTS.splice(i,1);
  persistDrafts(); updateDraftBadge(); renderDraftList();
  if(!live){
    var used={};
    function take(list){ (list||[]).forEach(function(im){ if(im&&im.id) used[im.id]=1; }); }
    state.vols.forEach(function(v){ (v.items||[]).forEach(function(it){ take(it.imgs); }); });
    (state.trash||[]).forEach(function(r){ var tv=(r&&r.vol)||{}; (tv.items||[]).forEach(function(it){ take(it.imgs); }); });
    DRAFTS.forEach(function(d){ take(d.imgs); });
    (rec.imgs||[]).forEach(function(im){ if(im&&im.id && !used[im.id]) idbDel("imgs", im.id); });
  }
  toast("草稿已删除");
}
$("btnDrafts").onclick=openDrafts;
$("draftClose").onclick=closeDrafts;
$("dlgDrafts").onclick=function(e){ if(e.target===this) closeDrafts(); };
$("draftList").onclick=function(e){
  var r=e.target.closest("[data-drestore]");
  if(r){ restoreDraftByKey(r.getAttribute("data-drestore"), false); return; }
  var d=e.target.closest("[data-ddel]");
  if(d){ deleteDraft(d.getAttribute("data-ddel")); return; }
};
$("topStat").title="点这里打开草稿箱"; $("topStat").style.cursor="pointer"; $("topStat").onclick=openDrafts;
function submit(){
  if(!state.vols.length){ toast("先加一卷"); return; }
  var p1=$("fP1").value.trim(), p2=$("fP2").value.trim();
  if(!p1&&!p2){ toast("填页码，或点「取当前页」"); $("fP1").focus(); return; }
  var o={ p1:p1, p2:p2, mat:$("fMat").value.trim(), mark:$("fMark").value,
          text:$("fText").value.replace(/\s+$/,""), note:$("fNote").value.trim() };
  var wasEdit=!!editing, editIdx=editing?editing.i:-1;
  var dslot=draftSlot(), dkey=dslot?dslot.key:null;   // 提交成功就把对应草稿从箱子里销掉
  pushUndo(editing?"修改摘录":"加入摘录", editing?removedIds.slice():[]);
  if(editing){
    var v=state.vols[state.cur];
    if(v&&v.items[editing.i]){
      var old=v.items[editing.i];
      old.p1=o.p1; old.p2=o.p2; old.mat=o.mat; old.mark=o.mark; old.text=o.text; old.note=o.note;
      // 以预览条的顺序为准：删掉的不再保留，挪过的顺序照搬
      old.imgs = pending.map(function(p){ return {id:p.id,w:p.w,h:p.h,ext:p.ext,page:p.page}; });
      removedIds.forEach(function(id){ idbDel("imgs", id); });
      removedIds=[];
    }
    editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
    toast("已更新");
  }else{
    var vol=state.vols[state.cur];
    vol.items.push({ id:uid(), p1:o.p1, p2:o.p2, mat:o.mat, mark:o.mark, text:o.text, note:o.note,
      imgs: pending.map(function(p){ return {id:p.id,w:p.w,h:p.h,ext:p.ext,page:p.page,full:(p.full!==undefined?p.full:!p.rect)}; }) });
    toast("已加入，本卷 "+vol.items.length+" 条");
  }
  /* 记下来刚动的是哪一条，buildA4 排完自动滚到它，预览就不会每次都跳回第一页 */
  a4Follow = { v: state.cur, i: wasEdit ? editIdx : (state.vols[state.cur] ? state.vols[state.cur].items.length-1 : 0) };
  dropPending(false); resetFormFields();
  if(dkey) dropDraftByKey(dkey);
  save(); render(); saveDraft();
  $("itemList").scrollTop=$("itemList").scrollHeight;
  $("fP1").focus();
}
async function editItem(i, follow){
  var it=state.vols[state.cur].items[i]; if(!it) return;
  saveDraft();                                      // 换条目之前先把手上没提交的存进草稿箱
  $("fP1").value=it.p1||""; $("fP2").value=it.p2||""; $("fMat").value=it.mat||"";
  $("fMark").value=it.mark||""; $("fText").value=it.text||""; $("fNote").value=it.note||"";
  dropPending(false);
  // 原来这条的附图也摆到预览条里，能看、能删、能调序，不用凭记忆
  var list=it.imgs||[];
  for(var k=0;k<list.length;k++){
    var b=await idbGet("imgs", list[k].id);
    if(b) pending.push({id:list[k].id, w:list[k].w, h:list[k].h, ext:list[k].ext,
      url:URL.createObjectURL(b), page:list[k].page||1, rect:null, full:!!list[k].full, saved:true});
  }
  editing={v:state.cur,i:i}; $("btnAdd").textContent="保存修改"; $("btnCancel").style.display="";
  /* 在预览里点某一块：follow 里带着"点的是哪一块/哪张图"，重建后视线原地不动（keepView）；
     从左栏列表点某条：不给 follow，就让预览滚到这一条。 */
  a4Follow=Object.assign({v:state.cur, i:i}, follow||{});
  renderShots(); render(); scheduleA4();
  toast(list.length ? ("已载入这条的 "+pending.length+" 张附图，可删除 / 调序")
                   : "这条没有附图", 3200);
}
$("btnAdd").onclick=submit;
$("btnClear").onclick=function(){
  var s=draftSlot(); if(s) dropDraftByKey(s.key);   // 主动清空 = 这条草稿也不要了
  dropPending(true); resetFormFields(); scheduleA4(); $("fP1").focus();
};
$("btnCancel").onclick=function(){
  var s=draftSlot(); if(s) dropDraftByKey(s.key);   // 取消修改 = 放弃这条草稿
  editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
  dropPending(true); resetFormFields(); render();
};
/* 表单一有变化（文字/页码/材料名/备注），右栏 A4 预览也跟着刷新，实时看排版空间 */
["fP1","fP2","fMat","fText","fNote"].forEach(function(id){ $(id).addEventListener("input", function(){ scheduleDraft(); scheduleA4(); }); });
$("fMark").addEventListener("change", function(){ scheduleDraft(); scheduleA4(); });
document.addEventListener("keydown",function(e){ if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){ e.preventDefault(); submit(); } });
document.addEventListener("keydown",function(e){
  var cmd=e.ctrlKey||e.metaKey; if(!cmd) return;
  var k=(e.key||"").toLowerCase();
  var t=e.target, tag=t&&t.tagName;
  /* 输入框里：Ctrl+Z 交给浏览器原生撤销文字，但 Ctrl+Shift+Z / Ctrl+Y 仍然做重做 */
  var inField=(tag==="INPUT"||tag==="TEXTAREA");
  if(k==="z" && e.shiftKey){ e.preventDefault(); redo(); return; }
  if(k==="y"){ e.preventDefault(); redo(); return; }
  if(k==="z"){ if(inField) return; e.preventDefault(); undo(); }
});
$("btnUndo").onclick=undo;
$("btnRedo").onclick=redo;

/* ============ 卷管理 ============ */
/* 删除某一本卷：摘录、附图不删，整卷移入回收站备份，可随时恢复 —— 由左栏卷名后的 × 触发 */
async function delVolume(i){
  var v=state.vols[i]; if(!v) return;
  var msg="删除《"+v.name+"》"+(v.no?"（"+v.no+"）":"")+"？\n\n这本卷的 "+v.items.length+" 条摘录、附图会保留在「回收站」里，可随时恢复；PDF 绑定也保留。\n\n只有从回收站里「彻底删除」才会真正清掉摘录。";
  if(!confirm(msg)) return;
  var wasBound = (pdfVolId === v.id);
  /* 删的正好是正在写 / 正在改的那卷：表单先收进草稿箱，截图留给草稿；
     删的是别的卷：当前表单、截图、修改状态一概不动。 */
  var curAffected = (i===state.cur) || (editing && editing.v===i);
  if(curAffected) saveDraft();
  state.trash = state.trash || [];
  state.trash.unshift({ vol:v, delAt:Date.now() });   // 整卷备份，不删截图、不丢摘录
  var dvIds=[]; v.items.forEach(function(it){(it.imgs||[]).forEach(function(im){ if(im&&im.id) dvIds.push(im.id); });});
  pushUndo("删除《"+v.name+"》", dvIds);
  state.vols.splice(i,1);
  if(curAffected){
    editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
    dropPending(false); resetFormFields();
  }else if(editing && editing.v>i){
    editing.v--;
  }
  if(state.cur>state.vols.length-1) state.cur=Math.max(0,state.vols.length-1);
  else if(state.cur>i) state.cur--;
  /* 删的是正在看的那卷（或已经删光）→ 先彻底关掉旧预览；
     删的是别的卷、而预览属于另一本还在的卷 → 预览不动，不再误关 */
  if(wasBound || !state.vols.length) await closePdf();
  save(); render(); saveDraft(); updatePageTip();
  if(!pdfDoc && state.vols.length && state.vols[state.cur]) openPdfOfVol(state.cur);   // 换到的那卷若有 PDF，自动打开
  toast("已删除《"+v.name+"》，摘录已备份到回收站", 4000);
}
/* ---------- 回收站：删卷时摘录、附图都备份在这里，可恢复 / 彻底删除 ---------- */
function trashCount(){ return (state.trash||[]).length; }
function updateTrashBadge(){
  var c=trashCount();
  var box=$("sideTrash"); if(box) box.style.display = c ? "" : "none";
  var t=$("trashCnt"); if(t) t.textContent=String(c);
}
function openTrash(){ renderTrashList(); $("dlgTrash").classList.add("on"); }
function closeTrash(){ $("dlgTrash").classList.remove("on"); }
function renderTrashList(){
  var box=$("trashList"); if(!box) return;
  var list=(state.trash||[]).map(function(rec,k){ return {rec:rec,k:k}; });
  if(!list.length){ box.innerHTML='<div class="empty">回收站是空的</div>'; return; }
  box.innerHTML=list.map(function(o){
    var v=o.rec.vol, k=o.k;
    var when=o.rec.delAt ? new Date(o.rec.delAt).toLocaleString() : "";
    return '<div class="trash-item">'+
      '<div class="ti-main"><b>'+esc(v.name)+(v.no?'（'+esc(v.no)+'）':'')+'</b>'+
      '<span class="tip-line">'+v.items.length+' 条摘录'+(v.pdfName?' · '+esc(v.pdfName):'')+(when?' · '+when:'')+'</span></div>'+
      '<div class="ti-act">'+
        '<button class="btn sm" data-trestore="'+k+'">恢复</button>'+
        '<button class="btn sm dgr" data-tpurge="'+k+'">彻底删除</button>'+
      '</div></div>';
  }).join("");
}
function restoreTrash(k){
  var rec=(state.trash||[])[k]; if(!rec) return;
  var v=rec.vol;
  state.trash.splice(k,1);
  var i=0;                        // 按名称序号排回原位
  for(; i<state.vols.length; i++){ if(volCmp(v, state.vols[i])<0) break; }
  state.vols.splice(i,0,v);
  state.cur=i;
  save(); render(); renderTrashList(); updateTrashBadge();
  if(v.pdfName && v.pdfPath && window.desktop && window.desktop.readFile) openPdfOfVol(i);
  toast("已恢复《"+v.name+"》", 3200);
}
function purgeTrash(k){
  var rec=(state.trash||[])[k]; if(!rec) return;
  var v=rec.vol;
  if(!confirm("彻底删除《"+v.name+"》"+(v.no?"（"+v.no+"）":"")+"及它的 "+v.items.length+" 条摘录、附图？\n\n此操作不可恢复。")) return;
  v.items.forEach(function(it){ (it.imgs||[]).forEach(function(im){ idbDel("imgs",im.id); }); });
  state.trash.splice(k,1);
  save(); renderTrashList(); updateTrashBadge();
  toast("已彻底删除《"+v.name+"》");
}
function clearTrash(){
  var list=(state.trash||[]).slice();
  if(!list.length){ toast("回收站已经是空的"); return; }
  var n=0; list.forEach(function(rec){ n+=rec.vol.items.length; });
  if(!confirm("清空回收站？\n\n将永久删除 "+list.length+" 本卷、共 "+n+" 条摘录及附图，不可恢复。")) return;
  list.forEach(function(rec){ rec.vol.items.forEach(function(it){ (it.imgs||[]).forEach(function(im){ idbDel("imgs",im.id); }); }); });
  state.trash=[];
  save(); renderTrashList(); updateTrashBadge();
  toast("回收站已清空");
}
$("btnTrash").onclick=openTrash;
$("trashClose").onclick=closeTrash;
$("trashClear").onclick=clearTrash;
$("dlgTrash").onclick=function(e){ if(e.target===this) closeTrash(); };
$("trashList").onclick=function(e){
  var b=e.target.closest("[data-trestore],[data-tpurge]"); if(!b) return;
  var k=parseInt(b.getAttribute("data-trestore")!==null ? b.getAttribute("data-trestore") : b.getAttribute("data-tpurge"),10);
  if(b.hasAttribute("data-trestore")) restoreTrash(k); else purgeTrash(k);
};
/* 删除所有摘录：清掉全部卷里的条目和截图，卷名保留（还能继续往这些卷里摘） */
async function wipeAllItems(){
  var vols=state.vols;
  if(!vols.length){ toast("还没有卷"); return; }
  var nItems=vols.reduce(function(a,v){ return a+v.items.length; },0);
  if(!nItems){ toast("现在没有任何摘录，不用删"); return; }
  if(!confirm("删除所有摘录\n\n全部 "+vols.length+" 卷、共 "+nItems+" 条摘录及全部附图都会被删掉。\n卷名保留，摘录单位等设置保留。\n\n删了可用顶部「撤回」恢复（Ctrl+Z），确定吗？")) return;
  if(!confirm("最后一次确认：真的要删掉这 "+nItems+" 条摘录吗？")) return;
  busy(true);
  var waIds=[]; vols.forEach(function(v){ v.items.forEach(function(it){(it.imgs||[]).forEach(function(im){ if(im&&im.id) waIds.push(im.id); });}); });
  pushUndo("删除所有摘录", waIds);
  try{
    vols.forEach(function(v){
      v.items.forEach(function(it){ (it.imgs||[]).forEach(function(im){ idbDel("imgs",im.id); }); });
      v.items=[];
    });
    dropPending(true);
    editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
    resetFormFields();
    save(); render(); saveDraft();
    toast("已删除全部 "+nItems+" 条摘录，卷名保留", 5000);
  }catch(e){ console.error(e); toast("删除失败："+(e&&e.message||e)); }
  finally{ busy(false); }
}
$("btnWipeAll").onclick=wipeAllItems;
$("btnToggle").onclick=function(){ $("sidebar").classList.toggle("hide"); };
$("fCase").oninput=function(){ state.case=this.value; save(); };

/* ============ 设置 ============ */
$("btnSet").onclick=function(){
  $("sUnit").value=opt.coverUnit||""; $("sBy").value=opt.by;
  $("sCover").checked=opt.cover; $("sToc").checked=opt.toc;
  $("sNote").checked=opt.note; $("sInline").checked=opt.inline;
  $("sSep").value=opt.sep; $("sMax").value=String(opt.max);
  $("sRepTitle").checked=!!opt.repTitle;
  if($("sImgPage")) $("sImgPage").checked=opt.imgPage!==false;
  showDataPath();
  $("dlgSet").classList.add("on");
};
$("btnSetClose").onclick=function(){
  opt.coverUnit=$("sUnit").value.trim(); opt.by=$("sBy").value.trim();
  opt.cover=$("sCover").checked; opt.toc=$("sToc").checked;
  opt.note=$("sNote").checked; opt.inline=$("sInline").checked;
  opt.sep=$("sSep").value; opt.max=parseInt($("sMax").value,10)||1600;
  opt.repTitle=$("sRepTitle").checked;
  if($("sImgPage")) opt.imgPage=$("sImgPage").checked;
  save(); $("dlgSet").classList.remove("on"); render(); scheduleA4(); toast("设置已保存");
};
/* ============ 封面与目录的文字：随时可改，改完预览/导出一起变 ============ */
function openCoverDlg(){
  $("cCase").value=state.case||"";
  $("cSub").value=opt.coverSub||"";
  $("cUnit").value=opt.coverUnit||"";
  $("cBy").value=opt.by||"";
  $("cDate").value=opt.coverDate||"";
  $("cToc").value=opt.tocTitle||"";
  $("dlgCover").classList.add("on");
}
$("btnCoverDlg").onclick=openCoverDlg;
$("cCancel").onclick=function(){ $("dlgCover").classList.remove("on"); };
$("cOk").onclick=function(){
  state.case=$("cCase").value.trim();
  opt.coverSub=$("cSub").value.trim() || "阅卷摘录";
  opt.coverUnit=$("cUnit").value.trim();
  opt.by=$("cBy").value.trim();
  opt.coverDate=$("cDate").value.trim();
  opt.tocTitle=$("cToc").value.trim() || "目　录";
  if($("fCase")) $("fCase").value=state.case;
  save(); $("dlgCover").classList.remove("on"); render(); scheduleA4();
  toast("封面和目录已更新，导出就是现在这样");
};
/* 上传文档：把分几次导出的 docx 合回来的正文，重新套上封面 + 目录 */
$("btnImport").onclick=function(){ importDocxFile(); };
/* 导入后悔了：把「上传文档」之前的内容换回来 */
$("btnRestoreImport").onclick=async function(){
  var raw=null;
  try{ raw=await idbGet("meta","preimport"); }catch(e){}
  if(!raw){ toast("没有可恢复的内容（只在执行过「上传文档」之后才有）"); return; }
  var b=null;
  try{ b=JSON.parse(raw); }catch(e){}
  if(!b || !b.vols){ toast("备份已损坏"); return; }
  var n=b.vols.reduce(function(a,v){return a+v.items.length;},0);
  if(!confirm("恢复「上传文档」之前的内容？\n\n备份："+(b.case||"未命名")+"　"+b.vols.length+" 卷 / "+n+" 条\n"+
      "当前："+(state.case||"未命名")+"　"+state.vols.length+" 卷 / "+
      state.vols.reduce(function(a,v){return a+v.items.length;},0)+" 条\n\n当前内容会被替换。")) return;
  state.case=b.case||""; state.vols=b.vols; state.cur=b.cur||0; state.trash=[];
  if($("fCase")) $("fCase").value=state.case;
  editing=null; pending.length=0; removedIds.length=0;
  await save(); render(); a4Mode="all"; await buildA4();
  $("dlgSet").classList.remove("on");
  toast("已恢复上传前的内容");
};

$("btnBackup").onclick=function(){
  dl((state.case||"未命名")+"_阅卷摘录备份_"+new Date().toISOString().slice(0,10)+".json",
     new Blob([JSON.stringify({case:state.case,vols:state.vols},null,1)],{type:"application/json"}));
  toast("已备份（不含截图，截图在本机浏览器里）");
};
$("btnRestore").onclick=function(){ $("jsonPick").click(); };

/* ---------- 数据位置 & 完整备份（含截图） ---------- */
async function showDataPath(){
  var el=$("sDataPath"); if(!el) return;
  if(!(window.desktop && window.desktop.dataInfo)){ el.textContent="网页演示版：数据存在浏览器 IndexedDB 里"; return; }
  try{
    var i=await window.desktop.dataInfo();
    el.textContent = i.dir + "　（摘录在 IndexedDB 子目录，端口 "+i.port+"）";
  }catch(e){ el.textContent="读取失败"; }
}
$("btnOpenData").onclick=async function(){
  if(!(window.desktop && window.desktop.openDataDir)){ toast("网页版没有文件夹可开"); return; }
  var r=await window.desktop.openDataDir();
  if(r && !r.ok) toast("打开失败："+(r.error||""));
};
$("btnBackupZip").onclick=async function(){
  var nItems=state.vols.reduce(function(a,v){return a+v.items.length;},0);
  var tItems=(state.trash||[]).reduce(function(a,r){return a+r.vol.items.length;},0);
  if(!nItems && !tItems){ toast("还没有摘录"); return; }
  busy(true);
  try{
    var files=[], cnt=0;
    var allVols=state.vols.concat((state.trash||[]).map(function(r){ return r.vol; }));
    for(var vi=0; vi<allVols.length; vi++){
      var items=allVols[vi].items;
      for(var ii=0; ii<items.length; ii++){
        var imgs=items[ii].imgs||[];
        for(var k=0;k<imgs.length;k++){
          var b=await idbGet("imgs", imgs[k].id);
          if(!b) continue;
          files.push({name:"imgs/"+imgs[k].id+".jpg", data:new Uint8Array(await b.arrayBuffer())});
          cnt++;
        }
      }
    }
    var meta={app:"zhai-juan", v:1, at:new Date().toISOString(), case:state.case, opt:opt, vols:state.vols, trash:state.trash||[]};
    files.unshift({name:"backup.json", data:new TextEncoder().encode(JSON.stringify(meta))});
    dl((state.case||"未命名")+"_完整备份_"+new Date().toISOString().slice(0,10)+".zip", makeZip(files));
    toast("已备份 "+state.vols.length+" 卷 / "+nItems+" 条 / "+cnt+" 张图"+(tItems?("（含回收站 "+tItems+" 条）"):""), 6000);
  }catch(e){ console.error(e); toast("备份失败："+(e&&e.message||e)); }
  finally{ busy(false); }
};
/* 读 zip（本软件写的是不压缩存储，直接按中央目录取） */
async function unzipAll(buf){
  var dv=new DataView(buf), len=dv.byteLength, eocd=-1;
  for(var i=len-22; i>=Math.max(0,len-66000); i--){
    if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; }
  }
  if(eocd<0) throw new Error("不是有效的 zip 文件");
  var n=dv.getUint16(eocd+10,true), p=dv.getUint32(eocd+16,true), out={};
  for(var k=0;k<n;k++){
    if(dv.getUint32(p,true)!==0x02014b50) break;
    var method=dv.getUint16(p+10,true), csize=dv.getUint32(p+20,true);
    var nl=dv.getUint16(p+28,true), el=dv.getUint16(p+30,true), cl=dv.getUint16(p+32,true);
    var lho=dv.getUint32(p+42,true);
    var name=new TextDecoder().decode(new Uint8Array(buf,p+46,nl));
    var lnl=dv.getUint16(lho+26,true), lel=dv.getUint16(lho+28,true);
    out[name]={method:method, data:new Uint8Array(buf, lho+30+lnl+lel, csize)};
    p+=46+nl+el+cl;
  }
  return out;
}
async function entryBytes(e){
  if(e.method===0) return e.data;
  if(e.method===8 && window.DecompressionStream){
    var ds=new DecompressionStream("deflate-raw");
    var ab=await new Response(new Blob([e.data]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error("压缩方式不支持");
}
async function restoreZip(file){
  busy(true);
  try{
    var z=await unzipAll(await file.arrayBuffer());
    if(!z["backup.json"]) throw new Error("压缩包里没有 backup.json，不是本软件的备份");
    var meta=JSON.parse(new TextDecoder().decode(await entryBytes(z["backup.json"])));
    if(!meta.vols) throw new Error("备份内容为空");
    var n=meta.vols.reduce(function(a,v){return a+v.items.length;},0);
    var cur=state.vols.reduce(function(a,v){return a+v.items.length;},0);
    if(cur && !confirm("恢复会替换当前全部内容\n\n备份："+(meta.case||"未命名")+"　"+meta.vols.length+" 卷 / "+n+" 条\n当前："+(state.case||"未命名")+"　"+state.vols.length+" 卷 / "+cur+" 条\n\n继续？")) return;
    var d=await idb();
    await new Promise(function(res,rej){
      var t=d.transaction("imgs","readwrite"); t.objectStore("imgs").clear();
      t.oncomplete=res; t.onerror=function(){ rej(t.error); };
    });
    urlCache={};
    var cnt=0;
    for(var name in z){
      if(name.indexOf("imgs/")!==0) continue;
      var id=name.slice(5).replace(/\.[a-z0-9]+$/i,"");
      var bytes=await entryBytes(z[name]);
      await idbPut("imgs", id, new Blob([bytes],{type:"image/jpeg"}));
      cnt++;
    }
    dropPending(false);
    state={case:meta.case||"", vols:meta.vols, cur:0, trash:meta.trash||[]};
    if(meta.opt) opt=Object.assign(opt, meta.opt);
    editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
    $("fCase").value=state.case;
    resetFormFields(); save(); render(); saveDraft();
    toast("已恢复 "+meta.vols.length+" 卷 / "+n+" 条 / "+cnt+" 张图", 6000);
  }catch(err){ console.error(err); toast("恢复失败："+(err&&err.message||err), 6000); }
  finally{ busy(false); }
}

/* 清空全部摘录数据：只删数据，不动设置。
   保留：摘录单位、提交人、分隔符、各项开关（存在 meta.opt）
   删除：所有卷、所有摘录条目、所有截图、草稿、案件名称 */
$("btnWipe").onclick=async function(){
  var vc=state.vols.length, ic=state.vols.reduce(function(a,v){return a+v.items.length;},0);
  if(!vc && !ic){ toast("本来就是空的"); return; }
  var msg="确定清空全部摘录数据吗？\n\n将删除：\n"
    + "· 卷 "+vc+" 本\n· 摘录条目 "+ic+" 条\n· 所有截图\n· 案件名称\n\n"
    + "此操作可用顶部「撤回」恢复（Ctrl+Z）。\n\n【设置】（摘录单位、提交人、分隔符）会保留。\n"
    + "建议先点「备份数据」留一份。";
  if(!confirm(msg)) return;
  var wipeIds=[]; state.vols.forEach(function(v){ v.items.forEach(function(it){(it.imgs||[]).forEach(function(im){ if(im&&im.id) wipeIds.push(im.id); });});});
  (state.trash||[]).forEach(function(rec){ var vv=rec.vol||{}; (vv.items||[]).forEach(function(it){(it.imgs||[]).forEach(function(im){ if(im&&im.id) wipeIds.push(im.id); });});});
  pushUndo("清空全部数据", wipeIds);
  try{
    var d=await idb();
    await new Promise(function(res,rej){
      var t=d.transaction(["imgs","meta"],"readwrite");
      t.objectStore("imgs").clear();
      t.objectStore("meta").delete("state");
      t.objectStore("meta").delete("draft");
      t.objectStore("meta").delete("drafts");
      t.oncomplete=res; t.onerror=function(){rej(t.error);};
    });
  }catch(e){ toast("清理失败："+(e&&e.message?e.message:e)); return; }

  DRAFTS=[]; updateDraftBadge();
  dropPending(false);
  state={case:"",vols:[],cur:0,trash:[]};
  editing=null; $("btnAdd").textContent="加入本卷"; $("btnCancel").style.display="none";
  await closePdf();
  $("fCase").value="";
  resetFormFields();
  render(); save(); saveDraft();
  toast("已清空全部摘录数据（设置已保留）", 4000);
};
$("jsonPick").onchange=async function(e){
  var f=e.target.files[0]; if(!f) return;
  if(/\.zip$/i.test(f.name)){ e.target.value=""; await restoreZip(f); return; }
  var r=new FileReader();
  r.onload=function(){
    try{ var o=JSON.parse(r.result); if(!o||!o.vols) throw 0;
      if(state.vols.some(function(v){return v.items.length;}) && !confirm("恢复会覆盖当前内容，确认？")) return;
      state={case:o.case||"",vols:o.vols,cur:0,trash:[]}; $("fCase").value=state.case;
      save(); render(); toast("已恢复");
    }catch(err){ toast("备份文件格式不对"); }
  };
  r.readAsText(f); e.target.value="";
};

/* ============ ZIP ============ */
var CRCT=(function(){var t=[],c,n,k;for(n=0;n<256;n++){c=n;for(k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function crc32(b){var c=0xFFFFFFFF;for(var i=0;i<b.length;i++)c=CRCT[(c^b[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function makeZip(files){
  var enc=new TextEncoder(), parts=[], cen=[], off=0;
  files.forEach(function(f){
    var nm=enc.encode(f.name), d=f.data, crc=crc32(d);
    var lh=new Uint8Array(30+nm.length), dv=new DataView(lh.buffer);
    dv.setUint32(0,0x04034b50,true); dv.setUint16(4,20,true); dv.setUint16(6,0x0800,true);
    dv.setUint16(8,0,true); dv.setUint16(10,0,true); dv.setUint16(12,0x5821,true);
    dv.setUint32(14,crc,true); dv.setUint32(18,d.length,true); dv.setUint32(22,d.length,true);
    dv.setUint16(26,nm.length,true); dv.setUint16(28,0,true); lh.set(nm,30);
    parts.push(lh,d);
    var ch=new Uint8Array(46+nm.length), cv=new DataView(ch.buffer);
    cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true);
    cv.setUint16(8,0x0800,true); cv.setUint16(10,0,true); cv.setUint16(12,0,true); cv.setUint16(14,0x5821,true);
    cv.setUint32(16,crc,true); cv.setUint32(20,d.length,true); cv.setUint32(24,d.length,true);
    cv.setUint16(28,nm.length,true); cv.setUint16(30,0,true); cv.setUint16(32,0,true);
    cv.setUint16(34,0,true); cv.setUint16(36,0,true); cv.setUint32(38,0,true); cv.setUint32(42,off,true);
    ch.set(nm,46); cen.push(ch);
    off+=lh.length+d.length;
  });
  var cs=cen.reduce(function(a,b){return a+b.length;},0);
  var e=new Uint8Array(22), ev=new DataView(e.buffer);
  ev.setUint32(0,0x06054b50,true); ev.setUint16(4,0,true); ev.setUint16(6,0,true);
  ev.setUint16(8,files.length,true); ev.setUint16(10,files.length,true);
  ev.setUint32(12,cs,true); ev.setUint32(16,off,true); ev.setUint16(20,0,true);
  return new Blob(parts.concat(cen,[e]),{type:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}

/* ============ DOCX ============ */
/* 版式写死，不给用户选：标题 宋体 2 号（22pt），正文 仿宋 3 号（16pt）。
   法院/检察院的阅卷材料都是这个规格，让用户选字体字号只会把简单事搞复杂。 */
var STYLE={ bodyFont:"仿宋", bodyHalf:32, titleFont:"宋体", titleHalf:44 };
function FONT(){ return STYLE.bodyFont; }
function SZ(){ return STYLE.bodyHalf; }
function RPR(){ return RPRX({}); }
/* 文字属性：默认不加粗。以前全文被强制加粗，正文发黑，不像正式材料 */
function RPRX(o){
  o=o||{};
  var f=o.font||FONT(), sz=o.sz||SZ();
  return '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="'+f+'" w:hAnsi="'+f+'" w:eastAsia="'+f+'" w:cs="'+f+'"/>'+
    (o.b?'<w:b/><w:bCs/>':'')+'<w:sz w:val="'+sz+'"/><w:szCs w:val="'+sz+'"/></w:rPr>';
}
/* 行距：三号字以前只有 15.6 磅行距，字挤在一起。按字号给 28 磅起步的固定行距 */
function LINE(){
  var pt=(parseInt(SZ(),10)||32)/2;
  return Math.round(Math.max(28, pt*1.55)*20);
}
/* 标题行高（磅）：必须和导出时 HEAD() 用的公式一模一样，
   预览与 Word 的标题高度才会分毫不差，分页位置才对得上。 */
function headLinePt(sizePt){
  return Math.round(Math.max(28, (sizePt||16)*1.6)*20)/20;
}
function PSPACE(){ return '<w:spacing w:before="0" w:after="0" w:line="'+LINE()+'" w:lineRule="exact"/>'; }
function P(inner, jc){ return '<w:p><w:pPr>'+PSPACE()+'<w:jc w:val="'+(jc||"both")+'"/>'+RPR()+'</w:pPr>'+inner+'</w:p>'; }
/* keepNext = 这一段不许和下一段分开（Word 的"与下段同页"）。
   标注行和它的附图就是这样粘住的，不会出现"标注在页底、图跑下一页"。 */
function KN(xml){ return String(xml).replace('<w:pPr>', '<w:pPr><w:keepNext/>'); }
function RUN(t){ return '<w:r>'+RPR()+'<w:t xml:space="preserve">'+esc(t)+'</w:t></w:r>'; }
function RUNB(t){ return '<w:r>'+RPRX({b:true})+'<w:t xml:space="preserve">'+esc(t)+'</w:t></w:r>'; }
/* 居中标题：总标题 / 卷名 / 目录标题 */
function HEAD(t, half, font){
  var f=font||STYLE.titleFont;
  var line=Math.round(Math.max(28,(half/2)*1.6)*20);
  return '<w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="120" w:line="'+line+'" w:lineRule="exact"/>'+
    '<w:jc w:val="center"/>'+RPRX({b:true,sz:half,font:f})+'</w:pPr>'+
    '<w:r>'+RPRX({b:true,sz:half,font:f})+'<w:t xml:space="preserve">'+esc(t)+'</w:t></w:r></w:p>';
}
/* 居中标题（可指定字号、是否加粗）：目录标题用它——参考稿里「目录」是 16 磅、不加粗 */
function HEADX(t, sizePt, bold){
  var half=Math.round(sizePt*2), rp=RPRC({b:!!bold, sz:half, font:STYLE.titleFont});
  return '<w:p><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="120" w:line="'+
    Math.round(headLinePt(sizePt)*20)+'" w:lineRule="exact"/>'+
    '<w:jc w:val="center"/>'+rp+'</w:pPr>'+
    '<w:r>'+rp+'<w:t xml:space="preserve">'+esc(t||"")+'</w:t></w:r></w:p>';
}
function PB(){ return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'; }
/* 段前分页（pageBreakBefore）：这就是"从这一页开始"的正确写法。
   它和 <w:br type="page"/> 的区别很关键：如果这段本来就已经落在页首，
   段前分页不会多出任何东西；而空的换页段落会再顶出一张空白页。
   所以导出按预览的分页点加它，就能做到"预览怎么分页、Word 就怎么分页"。 */
function PBB(xml){
  var s=String(xml), m=/<w:pPr>(?:<w:keepNext\/>|<w:keepLines\/>)*/.exec(s);
  if(!m) return s.replace('<w:pPr>', '<w:pPr><w:pageBreakBefore/>');
  var at=m.index+m[0].length;
  return s.slice(0,at)+'<w:pageBreakBefore/>'+s.slice(at);
}
/* Word 默认会在「中文 ↔ 数字/英文」之间自动塞 1/8 个字宽的间距（autoSpaceDE/DN）。
   预览用的是浏览器排版，不会做这件事——于是同一句话在 Word 里比预览宽一两个百分点，
   正好卡在行尾的字就被挤到下一行、整页往下串（这就是"导出后有些页面跑位"的最后一点残差）。
   导出统一关掉这两个开关，Word 的行宽才和预览一模一样。 */
function noAutoSpace(xml){
  var A='<w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/>';
  return String(xml).replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/g, function(m, inner){
    if(/w:autoSpaceDE/.test(inner)) return m;
    /* 按 OOXML 规定，autoSpaceDE/DN 必须排在 snapToGrid / spacing / jc / rPr 之类之前 */
    var cands=['<w:snapToGrid','<w:spacing','<w:ind ','<w:jc ','<w:outlineLvl','<w:rPr>','<w:sectPr>'], idx=-1;
    for(var i=0;i<cands.length;i++){
      var p=inner.indexOf(cands[i]);
      if(p>=0 && (idx<0 || p<idx)) idx=p;
    }
    if(idx<0) return '<w:pPr>'+inner+A+'</w:pPr>';
    return '<w:pPr>'+inner.slice(0,idx)+A+inner.slice(idx)+'</w:pPr>';
  });
}
/* 图下面那行小页码：10.5 磅、居中、紧贴图片，页与图对得上 */
function PGNO(t){
  return '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="260" w:lineRule="exact"/>'+
    '<w:jc w:val="left"/>'+RPRX({sz:21})+'</w:pPr>'+
    '<w:r>'+RPRX({sz:21})+'<w:t xml:space="preserve">'+esc(t)+'</w:t></w:r></w:p>';
}
function PIMG(rid,id,cx,cy,jc){
  /* 图这一段的上下间距必须是 0、段落标记用 1 磅小字、并且关掉「对齐到文档网格」：
     Word 默认会把行内图片所在的行吸附到 15.6 磅的网格上，每张图凭空多占 0～15.6 磅，
     几十张图累积下来就把后面的页整页顶走样（导出和预览对不上的真正原因）。
     关了网格对齐，Word 里每张图的高度才等于预览里算的高度。 */
  return '<w:p><w:pPr><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>'+
   '<w:jc w:val="'+(jc||"left")+'"/>'+RPRX({sz:2})+'</w:pPr><w:r>'+RPR()+'<w:drawing>'+
   '<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="'+cx+'" cy="'+cy+'"/>'+
   '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="'+id+'" name="图片 '+id+'"/><wp:cNvGraphicFramePr/>'+
   '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'+
   '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'+
   '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'+
   '<pic:nvPicPr><pic:cNvPr id="0" name="img'+id+'.jpg"/><pic:cNvPicPr/></pic:nvPicPr>'+
   '<pic:blipFill><a:blip r:embed="'+rid+'"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'+
   '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="'+cx+'" cy="'+cy+'"/></a:xfrm>'+
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>'+
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
}
/* 查漏：49 本卷最容易出的事就是漏页、重页 */
function checkGaps(vols){
  var warns=[];
  vols.forEach(function(v){
    var ps=[], dup=[], seen={};
    v.items.forEach(function(it){
      var a=parseInt(it.p1,10);
      if(!isNaN(a)){ if(seen[a]) dup.push(a); seen[a]=1; ps.push(a); }
    });
    var tag="《"+v.name+(v.no?("（"+v.no+"）"):"")+"》";
    if(dup.length) warns.push(tag+" 页码重复录入：第 "+dup.join("、")+" 页");
    if(ps.length>1){
      ps.sort(function(a,b){return a-b;});
      var miss=[];
      for(var i=ps[0]; i<=ps[ps.length-1]; i++) if(!seen[i]) miss.push(i);
      if(miss.length && miss.length<=40) warns.push(tag+" 可能漏页：第 "+miss.join("、")+" 页");
      else if(miss.length>40) warns.push(tag+" 中间断档 "+miss.length+" 页，请核对是否漏卷");
    }
  });
  return warns;
}

/* ===== 目录：六列「序号 / 原卷 / 原页码 / 标 题 / 页码 / 备注」 =====
   版式照用户 2026-10-31 发来的目录截图（第81–100行那一页）：
     · 表头和数据统一仿宋 16 磅、全部居中、不加粗；
     · 「原卷」只写短册名（第16册）并竖排，列很窄；同页同册的行用一格合并；
     · 行高按字号的 2.1 倍留白（16 磅字 → 34 磅行高），和参考图一样松；
     · 「原页码」是卷宗 PDF 的页（P3-8），「页码」是本文件成稿的页（P137-140）。
   列宽合计 8306 twips = 版心宽（11906 − 左右边距 1800×2），表不会压出右边距外。
   格子左右内边距 57 twips（0.1 厘米），所以下面算"一行能放几个字"时一律减 114。 */
var TOCW=[820,772,1540,2870,1540,764];
var TOCFS=16, TOCNUMFS=16, TOCVOLFS=16, TOCLH=34, TOCTITLE_PT=16;
var TOCHEAD=["序号","原卷","原页码","标　题","页码","备注"];

/* 一个字占几个"全角位"：半角（数字/字母/空格）算 0.5 —— Word 里仿宋的半角就是半个字宽 */
function tocUnits(s){
  s=String(s||""); var w=0;
  for(var i=0;i<s.length;i++) w += (s.charCodeAt(i)<128 ? 0.5 : 1);
  return w;
}
/* 按列宽折行：返回 1~maxLn 行。预览和导出都用它切成同样的行——
   这样 Word 里绝不会自己再折一次，行高就永远是 行数×22 磅，跟预览分毫不差。 */
function tocLines(s, twips, sz, maxLn){
  var lim=Math.max(0.5, (twips-114)/(sz*20));
  s=String(s||"");
  var out=[], cur="", w=0;
  for(var i=0;i<s.length;i++){
    var ch=s.charAt(i), u=(ch.charCodeAt(0)<128 ? 0.5 : 1);
    if(cur && w+u>lim){ out.push(cur); cur=""; w=0; }
    cur+=ch; w+=u;
  }
  out.push(cur);
  if(out.length>maxLn){
    out=out.slice(0,maxLn);
    out[maxLn-1]=out[maxLn-1].slice(0,-1)+"…";
  }
  return out;
}
/* 原卷：只取「第几册」这个短名（第16册），和参考图一致。
   卷名里的描述（「第16册 诉讼文书卷」）、PDF 后缀、副本后缀都不进这一列。 */
var VOLNUM_RE=/第\s*([0-9０-９一二三四五六七八九十百千]+)\s*([册卷])/;
var VOLONLY_RE=/^[0-9０-９一二三四五六七八九十百千]+$/;
function tocVolShort(v){
  var name=String(v&&v.name||"").replace(/\.pdf$/i,"").replace(/\s*[（(]\s*\d+\s*[）)]\s*$/,"").trim();
  var no=String(v&&v.no||"").trim();
  var m=name.match(VOLNUM_RE) || no.match(VOLNUM_RE);
  if(m) return {n:m[1], unit:m[2]};
  if(VOLONLY_RE.test(name)) return {n:name, unit:"册"};
  if(VOLONLY_RE.test(no)) return {n:no, unit:"册"};
  return null;
}
function tocVolCell(v, vi){
  var t=tocVolShort(v);
  if(t) return "第"+t.n+t.unit;
  var name=String(v&&v.name||"").replace(/\.pdf$/i,"").replace(/\s*[（(]\s*\d+\s*[）)]\s*$/,"").trim();
  if(name) return name;
  var no=String(v&&v.no||"").trim();
  return no || ("第"+((vi||0)+1)+"册");
}
/* 短册名竖排成三行：第 / 16 / 册（参考图就是这样）；没有「第N册」的卷名
   才按列宽折行，最多三行，多出的用省略号。 */
function tocVolLines(v, vi){
  var t=tocVolShort(v);
  if(t) return ["第", t.n, t.unit];
  return tocLines(tocVolCell(v, vi), TOCW[1], TOCVOLFS, 3);
}
/* 原页码：P4-P7（第二个 P 省掉，这一列才放得下三位数） */
function tocSeg(it){
  var a=String(it&&it.p1||"").trim(), b=String(it&&it.p2||"").trim();
  if(a&&b&&a!==b) return "P"+a+"-"+b;
  if(a) return "P"+a;
  if(b) return "P"+b;
  return "";
}
/* 页码：这一条在成稿里从第几页到第几页（正文从 1 数，和页脚一致） */
function tocPage(r, front){
  if(!r || !r.page) return "";
  var a=r.page-(front||0), b=(r.pageEnd||r.page)-(front||0);
  if(b<a) b=a;
  return b>a ? ("P"+a+"-"+b) : ("P"+a);
}
/* 标题：只认「材料名称」这一栏。没填就留空——
   以前拿正文第一行顶上，结果"问：你和你他人……"这种笔录正文全跑进目录标题里，
   打印出来根本不能看。有截图没名字的写「截图」，一眼能看出是漏填了名字。
   例外：每卷第一条（第一页截图）常常只有一行卷首标题、没有材料名，
   若这一行短且不像正文（没有句读、不是问答），就把它当标题保留下来。 */
function tocFirstLine(it){
  var ls=String(it&&it.text||"").split(/\r?\n/).filter(function(s){ return s.trim(); });
  return ls.length ? ls[0].trim() : "";
}
function tocMat(it, first){
  var m=String(it&&it.mat!=null?it.mat:"").trim();
  if(m) return m;
  if(first && it && it.imgs && it.imgs.length){
    var t=tocFirstLine(it);
    if(t && t.length<=32 && !/[。！？；：，、,.;:?!]/.test(t) &&
       !/^(问|答|供|证|经|据|我|他|她|其|以上)/.test(t)) return t;
  }
  if(it && it.imgs && it.imgs.length) return "截图";
  return "";
}
/* 备注：就是「标记」那一栏，照原样印 ※ / ？ / !；自己写的几个字也原样显示 */
var MARK_TXT={ "【※】":"※", "【？】":"？", "【!】":"!",
               "【※】重点":"※", "【？】存疑":"？", "【!】待核原件":"!" };
function tocNote(it){
  var m=String(it.mark||"").trim();
  if(!m) return "";
  if(MARK_TXT[m]) return MARK_TXT[m];
  var inner=m.replace(/^[【\[]/,"").replace(/[】\]]$/,"").trim();
  /* 备注列只有两个字宽：自己写长的标记（【※与供述矛盾说…】）只印最前面那个符号 */
  var sym=inner.charAt(0);
  if(inner.length>2 && /[※？?!！]/.test(sym)) return sym;
  return inner;
}

/* ---- 封面 / 目录上那几个字：用户自己改，预览和导出用同一份 ---- */
function coverSub(){ return String(opt.coverSub||"").trim() || "阅卷摘录"; }
function coverUnit(){ return String(opt.coverUnit||"").trim(); }
function tocTitle(){ return String(opt.tocTitle||"").trim() || "目　录"; }
function coverDate(){
  var d=String(opt.coverDate||"").trim();
  if(d==="无" || d==="不印") return "";          // 想不印日期就填「无」
  return d || new Date().toLocaleDateString("zh-CN");
}
/* 2026-03-17 → 2026 年 3 月 17 日（已经是"年月日"的原样用） */
function cnDate(s){
  s=String(s||"").trim();
  if(!s) return "";
  if(/年/.test(s)) return s;
  var m=s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if(m) return m[1]+" 年 "+parseInt(m[2],10)+" 月 "+parseInt(m[3],10)+" 日";
  return s;
}
/* 卷宗 PDF 一共多少页：各卷"最大页号"相加（一卷卷从 P1 起，所以要按卷累加） */
function coverPgTotal(vols){
  var n=0;
  (vols||[]).forEach(function(v){
    var mx=0;
    (v.items||[]).forEach(function(it){
      [it.p1,it.p2].forEach(function(x){
        var k=parseInt(String(x||"").replace(/[^\d]/g,""),10);
        if(k>mx) mx=k;
      });
    });
    n+=mx;
  });
  return n;
}
/* 封面版式：一行一条，预览（buildA4）和导出（COVER）都照这份清单排。
   照用户给的《…卷宗摘卷笔录封面.docx》：
     22 磅案件名 → 26 磅竖排「阅卷摘录」四段 → 18 磅「页码段（共 N页）」→
     18 磅仿宋加粗三行「摘录单位 / 提 交 人 / 提交时间」（首行缩进两字）。 */
function coverSpec(vols, total){
  var L=[];
  function blank(n, sz){ for(var i=0;i<n;i++) L.push({t:"", sz:sz||16}); }
  var nm=(state.case||"").trim(), sub=coverSub();
  if(nm) L.push({t:nm, sz:22, center:1, bold:1, spc:57});
  L.push({t:"", sz:26});
  for(var i=0;i<sub.length;i++) L.push({t:sub.charAt(i), sz:26, center:1, bold:1, spc:40});
  blank(2, 12);
  var pt=coverPgTotal(vols);
  L.push({t:"页码段（共 "+(pt||total||0)+"页）", sz:18, center:1, bold:1, fs:1});
  blank(3, 18);
  if(coverUnit()) L.push({t:"摘录单位："+coverUnit(), sz:18, bold:1, fs:1, ind:2});
  if(opt.by) L.push({t:"提 交 人："+opt.by, sz:18, bold:1, fs:1, ind:2});
  if(coverDate()) L.push({t:"提交时间："+cnDate(coverDate()), sz:18, bold:1, fs:1, ind:2});
  return L;
}
/* 目录表（导出 Word）：一页一张表，跟预览的分页完全一致（参考稿本身也是每页一张表）。
   「原卷」列的 vMerge 只在**这一页**里从新开始：这页该卷的第一行 restart，后面的行 continue。
   以前整本目录一张表，vMerge 从头连到尾——打印出来那一列除了中间某页，其余页全是空的。 */
function TOC_TABLE(rows){
  function TRH(lines, hdr){
    return '<w:trPr>'+(hdr?'<w:tblHeader/>':'')+'<w:cantSplit/>'+
      '<w:trHeight w:val="'+(lines*TOCLH*20)+'" w:hRule="exact"/></w:trPr>';
  }
  function TP(lines, sz, bold){
    /* 每一行单独一段：行距钉死 TOCLH、snapToGrid=0（否则 16 磅字被吸到 15.6 磅网格，
       行高会变），Word 不会再自己折行，行数就是预览算出来的行数。 */
    var rp=RPRC({sz:sz*2, b:!!bold, font:"仿宋"});
    return (lines&&lines.length?lines:[""]).map(function(l){
      return '<w:p><w:pPr><w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="'+(TOCLH*20)+'" w:lineRule="exact"/>'+
        '<w:jc w:val="center"/>'+rp+'</w:pPr>'+
        '<w:r>'+rp+'<w:t xml:space="preserve">'+esc(l||"")+'</w:t></w:r></w:p>';
    }).join("");
  }
  function TC(w, inner, vmerge){
    return '<w:tc><w:tcPr><w:tcW w:w="'+w+'" w:type="dxa"/>'+
      (vmerge?'<w:vMerge'+(vmerge==="restart"?' w:val="restart"':'')+'/>':'')+
      '<w:vAlign w:val="center"/></w:tcPr>'+inner+'</w:tc>';
  }
  var n=rows.length, startOf={};
  for(var a=0;a<n;a++){
    var b=a;
    while(b<n-1 && rows[b+1].vi===rows[a].vi) b++;
    startOf[a]=1;
    a=b;
  }
  var head='<w:tr>'+TRH(1,true)+
    TOCHEAD.map(function(t,k){
      return TC(TOCW[k], TP([t], (k===0||k===2||k===4)?TOCNUMFS:(k===1?TOCVOLFS:TOCFS)));
    }).join("")+'</w:tr>';
  var body=rows.map(function(r,ri){
    var restart=!!startOf[ri];
    var volLines=restart ? (r.volLines || (r.vol!=null?[r.vol]:[])) : [];
    return '<w:tr>'+TRH(r.hLines||r.title.length)+
      TC(TOCW[0], TP([String(r.seq)], TOCNUMFS))+
      TC(TOCW[1], TP(volLines, TOCVOLFS), restart?'restart':'cont')+
      TC(TOCW[2], TP(r.seg, TOCNUMFS))+
      TC(TOCW[3], TP(r.title, TOCFS))+
      TC(TOCW[4], TP([r.pg||""], TOCNUMFS))+
      TC(TOCW[5], TP(r.note, TOCFS))+
    '</w:tr>';
  }).join("");
  var bd=["top","left","bottom","right","insideH","insideV"].map(function(s){
    return '<w:'+s+' w:val="single" w:sz="4" w:space="0" w:color="000000"/>';}).join("");
  var grid=TOCW.map(function(w){ return '<w:gridCol w:w="'+w+'"/>'; }).join("");
  /* tblPr 子元素顺序必须按 schema：tblW → jc → tblBorders → tblLayout → tblCellMar */
  return '<w:tbl><w:tblPr><w:tblW w:w="8306" w:type="dxa"/><w:jc w:val="center"/>'+
    '<w:tblBorders>'+bd+'</w:tblBorders>'+
    '<w:tblLayout w:type="fixed"/>'+
    /* 左右内边距 57 twips（0.1 厘米）＝ 与预览的 padding 一样，表头「序号 / 原卷」
       才不会因为 16 磅字太宽而折成两行；tocLines() 减的也是这 114 twips */
    '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="57" w:type="dxa"/>'+
    '<w:bottom w:w="0" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar>'+
    '</w:tblPr>'+
    '<w:tblGrid>'+grid+'</w:tblGrid>'+
    head+body+'</w:tbl>';
}
/* 整份目录：每页 = 「目录」标题（第 2 页起段前分页）+ 一张表 */
function TOCTBL(pages){
  return (pages||[]).map(function(rows,pi){
    var h=HEADX(tocTitle(), TOCTITLE_PT, false);
    if(pi>0) h=PBB(h);
    return h+TOC_TABLE(rows);
  }).join("");
}
/* 没有预览分页数据时的兜底：全部行排成一张表（Word 自己翻页，原卷列只按卷分组） */
function TOC_FALLBACK(vols, plan, front){
  var rows=[], n=0;
  vols.forEach(function(v,vi){
    var vl=tocVolLines(v, vi);
    v.items.forEach(function(it,ii){
      n++;
      var title=tocLines(tocMat(it, ii===0), TOCW[3], TOCFS, 2);
      var hLines=Math.max(title.length, ii===0 ? vl.length : 1);
      rows.push({ vi:vi, ii:ii, seq:n, vol:tocVolCell(v,vi), volLines:vl,
                  seg:tocLines(tocSeg(it), TOCW[2], TOCNUMFS, 1),
                  title:title, hLines:hLines,
                  note:tocLines(tocNote(it), TOCW[5], TOCFS, 1),
                  pg:tocPage(plan && plan.items[(plan.mode==="cur"?0:vi)+":"+ii], front) });
    });
  });
  return rows.length ? [rows] : [];
}
/* 行内属性：仿宋 + 加粗 + 字间距 + 字号（封面和目录共用） */
function RPRC(o){
  var f=o.font||"仿宋";
  return '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="'+f+'" w:hAnsi="'+f+'" w:eastAsia="'+f+'" w:cs="'+f+'"/>'+
    (o.b?'<w:b/><w:bCs/>':'<w:b w:val="0"/><w:bCs w:val="0"/>')+
    (o.spc?'<w:spacing w:val="'+o.spc+'"/>':'')+
    '<w:sz w:val="'+o.sz+'"/><w:szCs w:val="'+o.sz+'"/></w:rPr>';
}
function COVER(vols, total){
  var s="";
  /* 封面照 coverSpec 的清单排：行高一律用 headLinePt(字号) 写死，
     和预览同一个公式，所以封面不会在 Word 里多出半行、把目录顶到第二页。 */
  coverSpec(vols, total).forEach(function(L){
    var font=L.fs?"仿宋":"宋体";
    var rp=RPRC({b:!!L.bold, sz:Math.round(L.sz*2), font:font, spc:L.spc||0});
    var ppr='<w:snapToGrid w:val="0"/><w:spacing w:before="0" w:after="0" w:line="'+Math.round(headLinePt(L.sz)*20)+'" w:lineRule="exact"/>'+
      (L.ind?'<w:ind w:firstLineChars="'+L.ind*100+'" w:firstLine="'+Math.round(L.ind*L.sz*20)+'"/>':'')+
      '<w:jc w:val="'+(L.center?"center":"left")+'"/>'+rp;
    s+='<w:p><w:pPr>'+ppr+'</w:pPr>'+
      (L.t?'<w:r>'+rp+'<w:t xml:space="preserve">'+esc(L.t)+'</w:t></w:r>':'')+'</w:p>';
  });
  s+=SECT("rId11");   // 封面单独一节：这一节挂空页脚，封面不会被印上页码
  return s;
}
/* 分节符（不是普通分页）：fed 是页脚 id，start 传了就从这个数重新起编
   结构：节1 封面（无页码）→ 节2 目录（1 起）→ 节3 正文（又 1 起） */
function SECT(fed, start){
  return '<w:p><w:pPr><w:sectPr>'+
    '<w:footerReference r:id="'+(fed||"rId10")+'" w:type="default"/>'+
    '<w:pgSz w:w="11906" w:h="16838"/>'+
    '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>'+
    (start?'<w:pgNumType w:fmt="decimal" w:start="'+start+'"/>':'')+
    '<w:cols w:space="425" w:num="1"/><w:docGrid w:linePitch="312"/></w:sectPr></w:pPr></w:p>';
}

async function buildDocx(all){
  var vols = all ? state.vols : (state.vols[state.cur] ? [state.vols[state.cur]] : []);
  var enc=new TextEncoder(), files=[], rels=[], rid=100, body="", n=0, picN=0;
  /* 导出前先保证预览的分页结果是最新的（同一种模式），Word 照着它写死分页和图片尺寸 */
  var mode = all ? "all" : "cur";
  if(!layoutPlan || layoutPlan.mode!==mode){
    a4Mode=mode;
    try{ await buildA4(); }catch(e){ console.error(e); }
  }
  var plan=(layoutPlan && layoutPlan.mode===mode) ? layoutPlan : null;
  /* 封面/目录只属于「全部卷」：预览里「当前卷」是不带封面目录的，
     导出也必须一样，否则本卷模式导出来会凭空多两页，跟预览对不上。 */
  if(opt.cover) body += COVER(vols, vols.reduce(function(a,v){return a+v.items.length;},0));
  if(opt.toc){
    /* 目录的「页码」列直接用预览排完的那套页码（plan.items[..].page 含封面目录，减去前页数），
       所以 Word 目录里的页码和预览、和页脚完全一致，不会出现两套号。 */
    var front=(plan && plan.front!=null) ? plan.front : 0;
    /* 目录按预览分好的页，一页一张表（原卷的合并因此在每页重新开始）；
       万一没有预览数据（极少），退回"整份一张表"。 */
    var tpages=(plan && plan.toc && plan.toc.length) ? plan.toc : TOC_FALLBACK(vols, plan, front);
    body += TOCTBL(tpages);
    body += SECT("rId11");         // 目录也挂空页脚：封面、目录都不印页码、不占编号，正文从第 1 页起
  }
  for(var vi=0; vi<vols.length; vi++){
    var v=vols[vi];
    var tvi = all ? vi : state.cur;                      // 真实卷下标（和预览分页记录一致）
    // 总标题默认只在第一卷前面出现一次。49 本卷的话每卷都重复一遍会很冗余，
    // 需要沿用的话在设置里打开「每卷重复总标题」。整页扫描件也按普通截图排，标题照常出现。
    if(opt.repTitle || vi===0){
      var t1=HEAD((state.case||"")+"阅卷摘录", STYLE.titleHalf);
      if(plan && plan.titlePB && plan.titlePB[tvi]) t1=PBB(t1);   // 预览里这个大标题另起了一页
      body += t1;
    }
    var t2=HEAD(v.name+(v.no?("（"+v.no+"）"):""), 32);
    if(plan && plan.volPB && plan.volPB[tvi]) t2=PBB(t2);         // 预览里卷名另起了一页
    body += t2;
    for(var ii=0; ii<v.items.length; ii++){
      var it=v.items[ii]; n++;
      var b=blocks(it,0);
      /* 分页完全照预览：预览里"从这里开始新的一页"的三处（这条摘录、第 k 张截图、截图后文字），
         导出时用 <w:pageBreakBefore/>（段前分页）原样标出来。
         用它而不用空的换页段落，是因为段前分页在"本来就在页首"时不产生任何效果，
         绝不会像 <w:br type="page"/> 那样叠出整页空白。 */
      var pl=plan && plan.items[tvi+":"+ii];
      /* 头部 = 标注行 + 正文 + 第一张图，用 keepNext 串在一起（不孤页、不拆开）。
         第一张图之后的图不再 keepNext：放得下就接着排，放不下 Word 自然换页——
         不能因为后面有张大图，就把前面已排好的图和标注行一起挤到下一页。 */
      var segs=[];
      var segLab=KN(P(RUNB(b.lab)));
      if(pl && pl.newPage) segLab=PBB(segLab);
      segs.push(segLab);
      b.lines.forEach(function(ln){ segs.push(KN(P(RUN(ln)))); });
      var list=it.imgs||[];
      var resv=(ii===0) ? (volHeadPt(opt.repTitle || vi===0) + (LINE()/20) + 14 + 6) : 0;   // 卷首那条给标题+标注行+页码让位
      for(var k=0;k<list.length;k++){
        var im=list[k];
        var blob=await idbGet("imgs", im.id);
        if(!blob) continue;
        var buf=new Uint8Array(await blob.arrayBuffer());
        var fn="media/img"+(picN+1)+".jpg"; picN++;
        files.push({name:"word/"+fn, data:buf});
        rels.push('<Relationship Id="rId'+rid+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="'+fn+'"/>');
        var pn=shotPageNo(im, v);
        /* 整页扫描件：和普通截图一样排进版心（P 页码在图上方、版心内），
           不再铺满整页——铺满会把页码顶到纸张最边上，装订后看不见。 */
        /* 普通图、整页扫描件一律用预览里分页时算好的最终尺寸（EMU）：
           以前整页图这里会重新算一遍（calcSize），而预览那次是"给紧跟文字让过高度"的，
           于是 Word 里的图比预览高一截，那一页就装不下，内容被挤到下一页——整页截图页面错位就是这么来的。 */
        var sz=(pl && pl.imgs && pl.imgs[k]) ? pl.imgs[k] : calcSize(im, resv);
        var brk = !!(pl && pl.imgPB && pl.imgPB[k]);      // 预览里这张图换了页
        /* 每张图上方标它来自卷宗第几页（先页码、再截图） */
        if(opt.imgPage!==false && pn){
          var pg1=PGNO("P"+pn);
          if(brk) pg1=PBB(pg1);
          /* 只有第一张图的页码 keepNext（把第一张图跟前面的标注行/正文绑在同一页） */
          segs.push(k===0 ? KN(pg1) : pg1);
          brk=false;                                       // 已经挂到页码那段上了
        }
        /* 图本身一律不加 keepNext：第一张图是「头部」结尾，之后的图放不下就自然换页 */
        var img1=PIMG("rId"+rid, picN, sz.cx, sz.cy, "left");
        segs.push(brk ? PBB(img1) : img1);
        rid++;
      }
      /* 截图后文字：和它上面那张截图是一起的——图 + 紧跟的这几行用 keepNext 串成一条链，
         Word 只会整块挪页，绝不会把文字甩到下一页开头去（预览的分页规则完全一致）。 */
      if(opt.note && b.after.length){
        for(var si=segs.length-1; si>=0; si--){
          if(segs[si].indexOf('<w:drawing')>=0){ segs[si]=KN(segs[si]); break; }
        }
        b.after.forEach(function(ln, li){
          var ap=KN(P(RUN(ln)));
          /* 预览里这段文字是在第几行换的页，就在第几行加段前分页（长段可能中间断开） */
          if(pl && pl.notePB && pl.notePB[li]) ap=PBB(ap);
          segs.push(ap);
        });
      }
      if(segs.length) segs[segs.length-1]=segs[segs.length-1].replace('<w:keepNext/>','');  // 最后一段放手
      body += segs.join("");
    }
  }

  body = noAutoSpace(body);      // 关掉 Word 的中英文自动间距，行宽与预览一致
  var doc='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'+
   ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'+
   ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'+
   ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'+
   ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>'+body+
   '<w:sectPr><w:footerReference r:id="rId10" w:type="default"/><w:pgSz w:w="11906" w:h="16838"/>'+
   '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/>'+
   '<w:pgNumType w:fmt="decimal" w:start="1"/><w:cols w:space="425" w:num="1"/>'+
   '<w:docGrid w:linePitch="312"/></w:sectPr></w:body></w:document>';
  var footer='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/>'+
   '<w:rPr><w:rFonts w:ascii="仿宋" w:hAnsi="仿宋" w:eastAsia="仿宋"/><w:sz w:val="21"/></w:rPr></w:pPr>'+
   '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'+
   '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>';
  /* 封面那一节的页脚：空的，什么都不印 */
  var footerEmpty='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr></w:p></w:ftr>';
  var styles='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults>'+
   '<w:rPrDefault><w:rPr><w:rFonts w:ascii="'+FONT()+'" w:hAnsi="'+FONT()+'" w:eastAsia="'+FONT()+'" w:cs="'+FONT()+'"/><w:sz w:val="'+SZ()+'"/><w:szCs w:val="'+SZ()+'"/></w:rPr></w:rPrDefault>'+
   '<w:pPrDefault/></w:docDefaults></w:styles>';
  var relsDoc='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.join("")+
   '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'+
   '<Relationship Id="rId11" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer2.xml"/></Relationships>';
  var ct='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
   '<Default Extension="xml" ContentType="application/xml"/>'+
   '<Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/>'+
   '<Default Extension="png" ContentType="image/png"/>'+
   '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'+
   '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'+
   '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'+
   '<Override PartName="/word/footer2.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>';
  var root='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+
   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  files.unshift({name:"[Content_Types].xml",data:enc.encode(ct)},
    {name:"_rels/.rels",data:enc.encode(root)},
    {name:"word/document.xml",data:enc.encode(doc)},
    {name:"word/styles.xml",data:enc.encode(styles)},
    {name:"word/footer1.xml",data:enc.encode(footer)},
    {name:"word/footer2.xml",data:enc.encode(footerEmpty)},
    {name:"word/_rels/document.xml.rels",data:enc.encode(relsDoc)});
  return { blob: makeZip(files), n:n, pics:picN, vols:vols.length };
}
/* ============ 上传文档：把本软件导出的 docx 读回来，重新生成封面 + 目录 ============
   为什么要读回来：用户常常分几次导出（20-29、30-39…），再把几份 docx 合成一份；
   合成的时候目录就乱了，往往只剩下正文。这里把正文（每条摘录、每张截图）原样解析出来，
   重新套上封面和目录——页码由本软件重新排版算出来，所以目录页码一定是对的。
   能认出来的东西：标注行（P20、讯问笔录）、图上方页码（P15）、图片、卷名标题、总标题。 */
function unesc(s){
  return String(s==null?"":s).replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&apos;/g,"'")
    .replace(/&#(\d+);/g, function(m,d){ return String.fromCharCode(parseInt(d,10)); })
    .replace(/&amp;/g,"&");
}
/* 标注行：P20、讯问笔录【※】重点 / P20-P24、到案经过 / P20 正文首行（材料名留空时）
   分隔符除了「、,，:：」还允许空格——材料名留空时导出用的是空格接正文首行 */
var LABEL_RE=/^P(\d+)(?:\s*[-—–~]\s*(\d+))?(?:[、,，:：]\s*|\s+(?=\S))?([\s\S]*)$/;
var DOCX_MARKS=["【※】重点","【？】存疑","【!】待核原件"];

/* 把 document.xml 拆成段落（getBoundingClientRect 那套用不上，只认 OOXML） */
function parseDocxParas(xml){
  var body=(xml.match(/<w:body>([\s\S]*)<\/w:body>/)||[])[1]||"";
  var out=[], re=/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g, m;
  while((m=re.exec(body))){
    var raw=m[0];
    if(raw.indexOf("<w:tbl")===0){ out.push({tbl:true}); continue; }
    var parts=[], tre=/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, tm;
    while((tm=tre.exec(raw))) parts.push(unesc(tm[1]));
    var txt=parts.join("");
    if(/<w:tab\s*\/>/.test(raw)) txt=txt.replace(/\t/g," ");
    var szm=raw.match(/<w:sz w:val="(\d+)"/);
    /* 图片：blip 的 r:embed 决定用哪张图，wp:extent 决定它在 Word 里多大 */
    var exts=[], xre=/<wp:extent[^>]*?cx="(\d+)"[^>]*?cy="(\d+)"/g, xm;
    while((xm=xre.exec(raw))) exts.push({cx:parseInt(xm[1],10), cy:parseInt(xm[2],10)});
    var imgs=[], bres=/<a:blip[^>]*?r:embed="([^"]+)"/g, bm, bi=0;
    while((bm=bres.exec(raw))) imgs.push({rid:bm[1], ext:exts[bi++]||null});
    out.push({
      text:txt.replace(/\u00a0/g," "),
      sz: szm ? parseInt(szm[1],10)/2 : 0,
      ctr: /<w:jc w:val="center"\/>/.test(raw),
      bold: /<w:b\/>|<w:b w:val="(1|true|on)"/.test(raw),
      pb: /<w:pageBreakBefore\/>/.test(raw) || /<w:br w:type="page"\/>/.test(raw),
      imgs: imgs
    });
  }
  return out;
}

/* 读一份 docx，返回 {case, vols, items, pics, hasCover, hasToc} */
async function readDocx(bytes, fileName){
  var ab = bytes instanceof ArrayBuffer ? bytes
         : bytes.buffer.slice(bytes.byteOffset||0, (bytes.byteOffset||0)+bytes.byteLength);
  var z=await unzipAll(ab);
  if(!z["word/document.xml"]) throw new Error("这不是 Word 文档（缺 word/document.xml）");
  var xml=new TextDecoder().decode(await entryBytes(z["word/document.xml"]));
  var relsXml = z["word/_rels/document.xml.rels"]
    ? new TextDecoder().decode(await entryBytes(z["word/_rels/document.xml.rels"])) : "";
  var relMap={};
  relsXml.replace(/<Relationship\b[^>]*?\/?>/g, function(tag){
    var id=(tag.match(/Id="([^"]+)"/)||[])[1], tg=(tag.match(/Target="([^"]+)"/)||[])[1];
    if(id && tg) relMap[id]=tg.replace(/^\/?word\//,"").replace(/^\//,"");
    return "";
  });
  var paras=parseDocxParas(xml);
  /* ---- 识别规则（不再靠"标注行长得像什么"，靠"P 页码 + 上下文"）----
     以前用一条正则去套整行，碰上"P88 问：……"（材料名留空、正文首行接在后面）就容易把
     整行当成材料名，甚至把图上方那行「P15」当成一条新摘录。现在改成：
       · 以 P+数字开头的段，往后面看一段：后面是图片 → 那是图上方页码；否则 → 是一条摘录。
       · 剩下的尾巴里带「，。；：？！」或特别长 → 是正文首行（材料名留空时导出的样子），
         不带标点又短 → 是材料名。
     起点从文档第一段开始扫（封面、目录、居中标题按规则跳过），
     所以"第一页上的正文"不会被跳过——以前是从"第一条标注行"开始，前面的一律丢掉。 */
  var vols=[], v=null, it=null, pendingPage="", pics=0, total=0;
  /* 第一个卷/第一条之前就出现的正文（比如文档第一页上的一段说明）先攒着，
     等第一个卷出现时挂到它最前面——这样既不会丢，也不会凭空多出一个"虚拟卷"。 */
  var pre=[];
  function newVol(name, no){
    v={ id:uid(), name:name, no:no||"", offset:0, items:[] };
    vols.push(v); it=null;
    if(pre.length){
      var pi={ id:uid(), p1:"", p2:"", mat:"", mark:"", text:pre.join("\n"), note:"", imgs:[] };
      v.items.push(pi); total++;
      pre=[]; it=null;
    }
    return v;
  }
  function newItem(p1,p2,mat,mark){
    it={ id:uid(), p1:p1||"", p2:p2||"", mat:mat||"", mark:mark||"", text:"", note:"", imgs:[] };
    v.items.push(it); total++; return it;
  }
  function volName(){ return String(fileName||"").replace(/\.docx$/i,"") || "卷宗"; }
  function nextBlock(i){
    for(var j=i+1;j<paras.length;j++){
      var b=paras[j]; if(b.tbl) continue;
      if(b.imgs.length) return b;
      if((b.text||"").trim()) return b;
    }
    return null;
  }
  var caseName="", cover={};
  for(var i=0;i<paras.length;i++){
    var bd=paras[i];
    if(bd.tbl) continue;
    var t=(bd.text||"").trim();

    /* ① 图片（可能一段里好几张）：挂到当前这条上；图上方那行 P 页码用完就清 */
    if(bd.imgs.length){
      if(!v) newVol(volName(), "");
      if(!it) newItem("","","","");
      for(var k=0;k<bd.imgs.length;k++){
        var im=bd.imgs[k], tf=relMap[im.rid];
        if(!tf) continue;
        var e=z["word/"+tf] || z[tf];
        if(!e) continue;
        var bin=new Uint8Array(await entryBytes(e));
        var ext=/\.png$/i.test(tf) ? "png" : "jpg";
        var w=600, h=800;
        if(im.ext && im.ext.cx && im.ext.cy){
          w=Math.max(1,Math.round(im.ext.cx/EMU_PER_PX));
          h=Math.max(1,Math.round(im.ext.cy/EMU_PER_PX));
        }
        var id=uid();
        await idbPut("imgs", id, new Blob([bin], {type: ext==="png"?"image/png":"image/jpeg"}));
        it.imgs.push({ id:id, w:w, h:h, ext:ext, page:pendingPage||"", full:(w/h>0.55 && w/h<0.85) });
        pendingPage=""; pics++;
      }
      continue;
    }
    if(!t) continue;

    /* ② 目录、统计行、表头残留：跳过（合并稿里可能有好几份目录） */
    if(/^目\s*录$/.test(t)) continue;
    if(/^共\s*\d+\s*条摘录/.test(t)) continue;
    if(/^(序号|卷宗|原卷|原页码|页码段|页码|材料名称|标题|标\s*题|备注)$/.test(t)) continue;

    /* ②' 封面上那三行（摘录单位 / 提 交 人 / 提交时间）要读出来，新封面照原样印回去——
       不然用户会觉得"第一页（封面）被干掉了"：字都在，但人没了。
       这几行不一定是居中的（参考稿里是左对齐 + 首行缩进两字），所以放在 ctr 判断之前。 */
    var cm=t.match(/^(摘录单位|提\s*交\s*人|提交时间|承办律师|摘\s*录\s*人|摘录日期|卷宗册数|摘录条数)\s*[:：]\s*(.*)$/);
    if(cm){
      var ck=cm[1].replace(/\s/g,"");
      if(ck==="摘录单位") cover.unit=cm[2].trim();
      else if(ck==="提交人") cover.by=cm[2].replace(/\s+/g,"").trim();
      else if(ck==="提交时间") cover.date=cm[2].trim();
      else if(ck==="承办律师") cover.lawyer=cm[2].trim();
      else if(ck==="摘录人") cover.by=cm[2].replace(/\s+/g,"").trim();
      else if(ck==="摘录日期") cover.date=cm[2].trim();
      continue;
    }
    /* 封面上的「页码段（共 221页）」是自动算的，不读也不进正文 */
    if(/^页码段（共\s*\d+\s*页?）$/.test(t.replace(/\s/g,""))) continue;

    /* ③ 居中的段：总标题 / 卷名 / 封面信息，一律不进正文（否则封面会粘到第一条后面） */
    if(bd.ctr){
      if(/阅卷摘录$/.test(t)){
        var cn=t.replace(/阅卷摘录$/,"").trim();
        if(cn) caseName=cn;                    // 只有「某某案阅卷摘录」才带案件名
        continue;
      }
      if(bd.bold && bd.sz>=14 && bd.sz<=17 && !/^[PＰ]\s*\d/.test(t)){
        var nm2=t.match(/^(.*?)（([^（）]{1,12})）$/);
        newVol(nm2?nm2[1]:t, nm2?nm2[2]:"");   // 卷名（可带（卷号））
        continue;
      }
      if(bd.sz>=18) continue;                  // 目录标题、封面大标题
      if(bd.bold) continue;                    // 其余居中小标题
      continue;                                // 居中的一律不进正文
    }

    /* ④ 以「P+页码」开头的段 */
    var pm=t.match(/^[PＰ]\s*([0-9０-９]{1,4})(?:\s*[-—–~至]\s*([0-9０-９]{1,4}))?/);
    if(pm){
      var rest=t.slice(pm[0].length).replace(/^[\s、,，:：.。·\-—]+/,"").trim();
      var nb=nextBlock(i);
      /* 后面紧跟图片的那行短 P 页码，是图片上方的小字，不是新摘录 */
      if(!rest && nb && nb.imgs.length){ pendingPage=pm[1]; continue; }
      var p1=pm[1], p2=pm[2]||"";
      var mark="", mat=rest;
      /* 标注行末尾的标记：先认预设的【※】/【？】/【!】，再认自己写的【※与供述矛盾…】这类，
         都必须从材料名里剥出去——不然"讯问笔录【※与供述矛盾说习俊龙提议】"整个进了标题列。 */
      var mb=mat.match(/^(.*?)\s*([【\[][^】\]]{1,40}[】\]])\s*$/);
      if(mb){ if(mb[1].trim()){ mat=mb[1].trim(); mark=mb[2]; } else { mat=""; mark=mb[2]; } }
      else for(var mi=0;mi<DOCX_MARKS.length;mi++){
        var mk=DOCX_MARKS[mi];
        if(mat && mat.slice(-mk.length)===mk){ mark=mk; mat=mat.slice(0,mat.length-mk.length).trim(); break; }
      }
      /* 材料名 vs 正文首行：带标点 / 太长 → 是正文（材料名留空时导出会接在页码后面） */
      var firstLine="";
      if(mat && (/[，。；：？！,.;:?!]/.test(mat) || mat.length>24)){ firstLine=mat; mat=""; }
      if(!v) newVol(volName(), "");
      newItem(p1, p2, mat, mark);
      if(firstLine) it.text=firstLine;
      pendingPage="";
      continue;
    }

    /* ⑤ 其余文字：图片之前算正文，图片之后算「截图后文字」 */
    if(!v){ pre.push(t); continue; }           // 还没遇到卷：先攒着（第一页的正文不丢）
    if(!it) newItem("","","","");
    if(!it.imgs.length) it.text = it.text ? (it.text+"\n"+t) : t;
    else it.note = it.note ? (it.note+"\n"+t) : t;
  }
  vols=vols.filter(function(x){ return x.items.length; });
  if(!vols.length) throw new Error("文档里没有找到可用的摘录条目");
  return { case:caseName, cover:cover, vols:vols,
           items:vols.reduce(function(a,x){return a+x.items.length;},0), pics:pics };
}

/* 文档模式：把中间 PDF 栏收起来，A4 成品占满。
   上传的文档没有 PDF 原件，中间那块一直空着"先选一卷、再点选择 PDF"，看着像卡住了；
   收起来以后 A4 能 1:1 显示，也能随时点「PDF」切回去给这一卷补 PDF。 */
function setDocMode(on){
  var main=document.querySelector(".main"); if(!main) return;
  main.classList.toggle("docmode", !!on);
  var b=$("a4Pdf"); if(b) b.classList.toggle("on", !on);
  /* A4 栏平时靠内联 flex（拖动分隔条留下）定宽，会压过 CSS；
     文档模式下清掉内联，让它铺满；切回来时按记住的宽度还原。 */
  var box=$("a4Box");
  if(box){
    if(on) box.style.flex="";
    else box.style.flex="0 0 "+(opt.a4w>0 ? parseInt(opt.a4w,10) : window.__a4DefaultW())+"px";
  }
  try{ fitA4Pages($("a4Pages")); }catch(e){}
  if(a4Sel) placeA4Tools();
}
$("a4Pdf").onclick=function(){
  setDocMode(!document.querySelector(".main").classList.contains("docmode"));
};

/* 上传文档：选文件 → 解析 → 备份当前内容 → 换成导入的内容（封面+目录自动重排） */
async function importDocxFile(){
  if(!(window.desktop && window.desktop.pickDocx)){ toast("上传文档只在桌面版可用"); return; }
  var r=await window.desktop.pickDocx();
  if(!r || r.canceled) return;
  if(r.ok===false){ toast("打开失败："+(r.error||"")); return; }
  busy(true);
  try{
    var got=await readDocx(r.data, r.name);
    if(state.vols.length && !confirm(
      "上传《"+r.name+"》会替换当前案件内容。\n\n"+
      "当前："+(state.case||"未命名")+"　"+state.vols.length+" 卷 / "+
        state.vols.reduce(function(a,v){return a+v.items.length;},0)+" 条\n"+
      "导入："+(got.case||r.name)+"　"+got.vols.length+" 卷 / "+got.items+" 条\n\n"+
      "当前内容会自动备份一份，可以随时恢复。继续？")){ busy(false); return; }
    /* 先备份当前内容（含截图 id 引用），导入后悔了能一键还原 */
    if(state.vols.length){
      try{ await idbPut("meta","preimport", JSON.stringify({at:Date.now(), case:state.case, vols:state.vols, cur:state.cur})); }catch(e){}
    }
    /* 旧封面上的字照搬：案件名、承办律师、摘录人、日期 */
    if(got.cover){
      if(got.cover.lawyer) opt.lawyer=got.cover.lawyer;
      if(got.cover.unit) opt.coverUnit=got.cover.unit;
      if(got.cover.by) opt.by=got.cover.by;
      if(got.cover.date) opt.coverDate=got.cover.date;
    }
    await closePdf();              // 上传的文档没有 PDF：旧预览先收掉，别留在中间
    state.case = got.case || String(r.name||"").replace(/\.docx$/i,"");
    state.vols = got.vols;
    state.cur = 0;
    state.trash = [];
    if($("fCase")) $("fCase").value = state.case;
    opt.cover = true; opt.toc = true;
    await save();
    editing=null; pending.length=0; removedIds.length=0;
    render();
    a4Mode="all";
    setDocMode(true);              // 没有 PDF，中间那栏收起来，A4 直接占满
    await buildA4();
    try{ $("a4Pages").scrollTop=0; }catch(e){}
    toast("已导入 "+got.vols.length+" 卷 / "+got.items+" 条摘录、"+got.pics+" 张截图，封面和目录已自动生成");
    openCoverDlg();          // 紧接着让用户改封面/目录的文字
  }catch(e){
    console.error(e);
    toast("导入失败："+(e&&e.message||e));
  }finally{ busy(false); }
}

/* 自动化测试入口：直接拿到导出的 docx 校验版式，不弹「另存为」 */
window.__zj = {
  buildDocx: function(all){ return buildDocx(all); },
  unzip: function(buf){ return unzipAll(buf); },
  entry: function(e){ return entryBytes(e); },
  addShot: function(blob, p, l){ return addShot(blob, p, l, {page:p}); },   // 回归测试造附图用（把第2个参数当卷宗页号）
  save: function(){ return save(); },
  render: function(){ return render(); },
  state: function(){ return state; },
  openPdfBytes: async function(bytes, name){    // 测试：直接注入 PDF 字节打开（绕过文件选择）
    if(!state.vols.length){ state.vols.push({ id:uid(), name:name||"test.pdf", no:"", offset:0, items:[] }); }
    var v=state.vols[state.cur]; v.pdfName=name||"test.pdf";
    var f=new File([bytes], name||"test.pdf", {type:"application/pdf"});
    await openPdfOfVol(state.cur, f);
    return { pages: pageCount, pageNum: pageNum };
  },
  pageNum: function(){ return pageNum; },
  pending: function(){ return pending; },
  drafts: function(){ return DRAFTS; },
  /* —— 附加测试钩子：整页截图 / A4 预览 / 修改摘录 的自动化校验用 —— */
  idbPut: function(s,k,v){ return idbPut(s,k,v); },
  idbGet: function(s,k){ return idbGet(s,k); },
  buildA4: function(){ return buildA4(); },
  uiDbg: function(){ return { a4w:opt.a4w, def:window.__a4DefaultW?window.__a4DefaultW():null,
                              previews:$("previews").clientWidth, flex:$("a4Box").style.flex }; },
  editItem: function(i){ return editItem(i); },
  scheduleA4: function(){ return scheduleA4(); },
  setA4Mode: function(m){ a4Mode=m; },
  getA4Mode: function(){ return a4Mode; },
  plan: function(){ return layoutPlan; },       // 预览分页记录（导出照抄的那份），测试用来核对尺寸
  readDocx: function(bytes, name){ return readDocx(bytes, name); },   // 上传文档的解析器（往返测试用）
  applyImport: async function(got, name){        // 测试：不弹对话框直接换成导入结果
    if(got.cover){
      if(got.cover.lawyer) opt.lawyer=got.cover.lawyer;
      if(got.cover.unit) opt.coverUnit=got.cover.unit;
      if(got.cover.by) opt.by=got.cover.by;
      if(got.cover.date) opt.coverDate=got.cover.date;
    }
    state.case=got.case||String(name||"").replace(/\.docx$/i,"");
    state.vols=got.vols; state.cur=0; state.trash=[];
    if($("fCase")) $("fCase").value=state.case;
    opt.cover=true; opt.toc=true;
    save(); render(); a4Mode="all"; setDocMode(true); return buildA4();
  }
};

function dl(name, blob){
  // 桌面版：走 Windows「另存为」对话框，自己选位置，不再丢进浏览器下载目录
  if(window.desktop && window.desktop.saveFile){
    blob.arrayBuffer().then(function(ab){
      return window.desktop.saveFile(name, new Uint8Array(ab));
    }).then(function(r){
      if(!r || r.canceled) return;
      if(r.ok) toast("已保存到：" + r.path, 8000);      // 保存位置要说清楚，尤其是长路径
      else toast("保存失败：" + (r.error || ""));
    }).catch(function(e){ console.error(e); toast("保存失败"); });
    return;
  }
  var u=URL.createObjectURL(blob), a=document.createElement("a");
  a.href=u; a.download=name; document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(u); document.body.removeChild(a); },500);
}
$("btnExport").onclick=function(){
  if(!state.vols.reduce(function(a,v){return a+v.items.length;},0)){ toast("还没有摘录"); return; }
  var vols = $("eOnlyCur").checked && state.vols[state.cur] ? [state.vols[state.cur]] : state.vols;
  var w = checkGaps(vols);
  var one = $("eOnlyCur").checked && state.vols[state.cur];
  $("expHint").innerHTML = (one
      ? ("单册导出：封面 + 目录 + 《"+esc(state.vols[state.cur].name)+"》正文。")
      : (state.vols.length>6
          ? "共 "+state.vols.length+" 册卷合一导出，文件会比较大；卷特别多建议分批。"
          : "将生成：封面 + 总目录 + 按卷排列的正文。"))
    + '<br>保存位置：点「开始导出」后弹出系统「另存为」窗口，默认在「文档」文件夹，可自己改。'
    + (w.length ? '<br><b>查漏提示</b><br>' + w.join("<br>") : "");
  $("dlgExp").classList.add("on");
};
$("btnExpClose").onclick=function(){ $("dlgExp").classList.remove("on"); };
$("eAll").onchange=$("eOnlyCur").onchange=function(){ if($("dlgExp").classList.contains("on")) $("btnExport").click(); };
$("btnExpGo").onclick=async function(){
  $("dlgExp").classList.remove("on");
  busy(true);
  try{
    var all=!$("eOnlyCur").checked;
    var r=await buildDocx(all);
    var nm=(state.case||"")+"阅卷摘录.docx";
    if(!all && state.vols[state.cur]) nm=(state.case||"")+"阅卷摘录-"+state.vols[state.cur].name+".docx";
    dl(nm, r.blob);
    toast("已导出："+r.n+" 条 / "+r.vols+" 卷 / "+r.pics+" 张图");
  }catch(e){ console.error(e); toast("导出失败："+(e&&e.message?e.message:e)); }
  finally{ busy(false); }
};

/* ============ 启动 ============ */
(async function(){
  await load();
  $("fCase").value=state.case||"";
  if(state.vols.length){ showOffsetInput(); }
  render();
  await loadDraft();          // 恢复上次没写完的草稿和没提交的截图
  render();
  // 上次停在哪一卷，就把那卷的 PDF 自动打开（桌面版记住了文件路径，不用再选一次）
  if(state.vols[state.cur] && state.vols[state.cur].pdfName && window.desktop && window.desktop.readFile){
    openPdfOfVol(state.cur);
  }
  if(window.desktop && window.desktop.on){         // 桌面版菜单
    window.desktop.on("menu-open-pdf", function(){ $("filePick").click(); });
    window.desktop.on("menu-export",   function(){ $("btnExport").click(); });
    window.desktop.on("menu-backup",   function(){ $("btnBackup").click(); });
    window.desktop.on("menu-toggle",   function(){ $("btnToggle").click(); });
    window.desktop.on("menu-import",   function(){ importDocxFile(); });
    window.desktop.on("menu-cover",    function(){ openCoverDlg(); });
  }
  selfCheck();
  var qPort=parseInt((location.search.match(/[?&]port=(\d+)/)||[])[1],10);
  if(qPort && qPort!==18737){
    // 端口变了 IndexedDB 就是另一个库，看上去像"数据丢了"，必须说清楚
    toast("注意：本次用备用端口 "+qPort+"，之前存的数据在 18737 端口下。若看不到旧摘录，请关掉占用 18737 的程序再打开。", 14000);
  }
  window.__setA4W(opt.a4w>0 ? opt.a4w : window.__a4DefaultW());   // 拖过就按记住的宽度，没拖过按窗口自适应
  setTimeout(buildA4, 400);
  var rsTimer=null, lastPdfW=$("pdfScroll").clientWidth;
  window.addEventListener("resize", function(){
    clearTimeout(rsTimer);
    rsTimer=setTimeout(function(){
      window.__setA4W(opt.a4w>0 ? opt.a4w : window.__a4DefaultW());   // 窗口宽度变了，A4 栏按新空间重新收放
      if(a4Mode) fitA4Pages($("a4Pages"));
      // PDF 区变宽变窄后，没手动缩放过就重新整页适应，别让页面卡在旧比例
      var w=$("pdfScroll").clientWidth;
      if(pdfDoc && !opt.pz && Math.abs(w-lastPdfW)>8){ lastPdfW=w; fitScale().then(refreshPdfPages).catch(function(){}); }
      else lastPdfW=w;
      // 手动放大过（opt.pz）或栏宽没变，页面尺寸不用重排，但横向居中得重新算一遍
      if(pdfDoc) requestAnimationFrame(function(){ centerPdfX(); });
    }, 220);
  });
  setInterval(saveDraft, 20000);                                  // 定时兜底
  window.addEventListener("beforeunload", function(){ saveDraft(); });
  document.addEventListener("visibilitychange", function(){
    if(document.hidden){ saveDraft(); save(); }                   // 切走/最小化时立即落盘
  });
})();

/* 启动自检：脚本若中途抛错，后面所有按钮都会"点了没反应"且毫无提示。
   这里逐个确认关键控件已绑定事件，缺了就在顶部亮红条说清楚。 */
function selfCheck(){
  var need = {
    btnPick:"onclick", filePick:"onchange", btnAdd:"onclick",
    btnExport:"onclick", volList:"onclick", itemList:"onclick", btnTakePage:"onclick",
    btnShot:"onclick", btnRectShot:"onclick", btnWipe:"onclick", btnWipeAll:"onclick",
    btnThumbs:"onclick", thumbs:"onclick", mvOk:"onclick",
    btnOcr:"onclick", vwOcr:"onclick",
    btnBackupZip:"onclick", btnOpenData:"onclick", a4Cur:"onclick", a4All:"onclick", a4Re:"onclick",
    btnUndo:"onclick", btnRedo:"onclick",
    volOk:"onclick", volCancel:"onclick", btnDrafts:"onclick", draftClose:"onclick",
    dlgDrafts:"onclick", draftList:"onclick",
    fSearchVol:"oninput", btnClearSearch:"onclick", zoomPct:"onclick",
    shotList:"onclick", dlgShot:"onclick"
  };
  var bad=[];
  for(var id in need){
    var el=document.getElementById(id);
    if(!el) { bad.push(id+"(元素缺失)"); continue; }
    if(typeof el[need[id]]!=="function") bad.push(id+"("+need[id]+"未绑定)");
  }
  if(bad.length){
    var b=document.getElementById("fatal");
    if(b){ b.style.display="block"; b.textContent="页面初始化不完整，以下功能不可用："+bad.join("、")+"　请重新打开软件或反馈给开发。"; }
    console.error("[致命] 初始化不完整:", bad);
  }
}
})();
