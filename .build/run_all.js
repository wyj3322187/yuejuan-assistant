/* 一次跑完全部回归测试：逐个起 Electron，按输出判定通过与否
   用法：npm test   或   node .build/run_all.js
   每个测试都用随机端口 + 合成卷宗，不会读写真实案件数据
   注意：本脚本刻意写成纯 Node —— 环境里若存在 ELECTRON_RUN_AS_NODE，
   用 electron 直接跑它会被降级成 Node 进程，拿不到 app 对象。 */
const { spawn } = require('child_process');
const path = require('path');

const mod = require('electron');
const BIN = typeof mod === 'string' ? mod : process.execPath;   // Node 模式下拿到的是 electron 可执行文件路径

const SUITE = ['test_a4_empty.js','test_sidebar_clean.js','test_ui.js','test_ui_states.js','test_drafts.js','verify_release_ui.js'];

function run(script){
  return new Promise(resolve=>{
    const out=[];
    const env=Object.assign({},process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const p=spawn(BIN,['--no-sandbox','--disable-gpu',path.join(__dirname,script)],
      { env, stdio:['ignore','pipe','pipe'] });
    const grab=d=>{ const s=String(d); out.push(s); process.stdout.write(s); };
    p.stdout.on('data',grab); p.stderr.on('data',grab);
    p.on('error',e=>resolve({ script, ok:false, code:'SPAWN_ERR '+e.message, errs:'' }));
    p.on('close',code=>{
      const txt=out.join('');
      const errs=(txt.match(/ERRS=(\[[^\n]*\])/)||[])[1];
      const bad=code!==0 || /RESULT=FAIL/.test(txt) || (errs && errs.replace(/\s/g,'')!=='[]');
      resolve({ script, ok:!bad, code, errs });
    });
  });
}

(async ()=>{
  console.log('Electron: '+BIN);
  const results=[];
  for(const s of SUITE) results.push(await run(s));
  console.log('\n================ 回归汇总 ================');
  for(const r of results) console.log((r.ok?'  PASS  ':'  FAIL  ')+r.script+(r.ok?'':'  (exit='+r.code+' errs='+r.errs+')'));
  const fail=results.filter(r=>!r.ok).length;
  console.log('------------------------------------------');
  console.log(fail?('失败 '+fail+' / '+results.length):('全部通过 '+results.length+' / '+results.length));
  process.exit(fail?1:0);
})();
