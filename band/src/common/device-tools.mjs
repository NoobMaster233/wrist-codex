export const shellPresets=[
  {name:'系统概览',hint:'固件与运行时间',command:'uname -a'},
  {name:'可用内存',hint:'查看运行资源',command:'free'},
  {name:'存储空间',hint:'查看文件系统',command:'df'},
  {name:'运行任务',hint:'查看手环进程',command:'ps'},
  {name:'应用文件',hint:'查看 Codex 的存储',command:'ls -l /data/files/dev.bandcodex.remote'}
];
export function shellSummary(state){
  if(!state)return '尚未执行命令';
  if(state.phase==='unknown')return '结果待核实 · 命令不会重发';
  if(state.phase==='failed')return state.error||'命令未完成';
  if(state.phase!=='complete')return ({sending:'正在准备命令',executing:'正在手环执行','receiving-status':'正在读取回执','receiving-output':'正在读取输出'})[state.phase]||'正在处理';
  if(state.status?.outcome==='timeout')return '已超时并结束';
  if(state.status?.outcome==='output-limit')return '输出已截断 · '+(state.status?.outputBytes||0)+' 字节';
  const code=(state.status?.rawStatus||0)>>>8;
  return '退出 '+code+' · '+(state.status?.elapsedMs||0)+' ms';
}
