import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Kernel-owned lock: a terminated process cannot leave a stale owner. Every
// project client of the factory channel shares this lock, including App wake.
export class FactoryLease {
  constructor(root){this.path=join(root,'.local/factory-channel.lock');}
  async acquire(){
    if(this.child)throw new Error('Factory lease already acquired');
    const child=this.child=spawn('flock',['--exclusive','--nonblock','--conflict-exit-code','75',
      this.path,process.execPath,'--input-type=commonjs','-e',
      'process.stdin.resume(); process.stdout.write("locked\\n");'],{stdio:['pipe','pipe','pipe']});
    child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
    const ready=new Promise((resolve,reject)=>{
      let text='';
      const timer=setTimeout(()=>reject(new Error('Factory channel lock timed out')),5000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',(code,signal)=>{this.exited=true;clearTimeout(timer);reject(new Error(code===75?
        'Own factory channel is in use; retry after the current operation':
        'Factory channel lock helper exited ('+(signal||code)+'); check flock and the local runtime'));});
      child.stdout.on('data',bytes=>{text+=bytes.toString();if(text.includes('locked\n')){clearTimeout(timer);resolve();}});
    });
    try{await ready;}catch(error){await this.release();throw error;}
  }
  async release(){
    if(!this.child||this.exited)return;
    this.child.stdin.end();const until=Date.now()+1000;
    while(!this.exited&&Date.now()<until)await delay(5);
    if(!this.exited)this.child.kill('SIGTERM');
  }
}
