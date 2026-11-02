-- Clock remains usable when service recovery is blocked. No real commands.
local real_io,real_os,real_require=io,os,require
local f=assert(real_io.open(assert(arg[1]),'rb'));local source=f:read('a');f:close()
local definitions={}
for name,path,sha,hex,state,status,kind in source:gmatch("name='([^']+)',path='([^']+)',sha='([^']+)',bytes=unhex%('([^']+)'%),%s*state='([^']+)',status='([^']+)',kind='([^']+)'")do
 definitions[#definitions+1]={name=name,path=path,sha=sha,state=state,status=status,kind=kind,bytes=hex:gsub('..',function(h)return string.char(tonumber(h,16))end)}
end
assert(#definitions==2)
local P=assert(source:match("local P='([^']+)'"))
local function audio_status(stage)
 return string.pack('<c8I4I4I4I4', 'BCAP0432',2,16000,20,0)..string.rep('\0',36)..string.pack('<I4',stage or 2)
end
local function ready(def)return def.kind=='shell' and 'ready:shell043-v1\n' or audio_status()end
local function run(files,loaded,scenario)
 local commands,labels,subscribers,objects={},{},{},{};local timer;local hour='20:36'
 io={open=function(path,mode)
  if mode=='rb' then
   if not files[path] then return nil end
   return {read=function(_,n)return files[path]:sub(1,n)end,close=function()return true end}
  end
  assert(not path:match('attempt') and not path:match('once'),'old marker must not change')
  return {write=function(_,s)files[path]=s;return true end,close=function()return true end}
 end}
 os={date=function(format)return ({['%H:%M']=hour,['%m月%d日']='10月26日',['%m']='10',['%d']='26',['%w']='1',['%S']='28'})[format]end,
  execute=function(command)
   commands[#commands+1]=command
   if command:match('^getprop ') then files[P..'fw.txt']=scenario=='wrong-fw' and 'new-version\n' or '3.101.043\n'
   elseif command:match('^lsmod ') then
    local names={'NAME TEXT DATA'};for name,value in pairs(loaded)do if value then names[#names+1]=name..' 1 2' end end
    files[P..'modules.txt']=table.concat(names,'\n')..'\n'
   elseif command:match('^insmod ') then
    if scenario=='failed-load' then return nil,'exit',256 end
    local found=false
    for _,def in ipairs(definitions)do if command=='insmod '..def.path..' '..def.name..' > '..P..def.kind..'-load.txt' then
     assert(files[def.state]=='pending:'..def.sha..'\n');loaded[def.name]=true;files[def.status]=ready(def);found=true
    end end
    assert(found,'unexpected native target')
   elseif command=='uptime > '..P..'uptime.txt' then files[P..'uptime.txt']='up 1:00\n'
   else assert(command=='sleep 1','unexpected command: '..command)end
   return true,'exit',0
  end}
 require=function(name)
  if name=='dataman' and scenario=='dataman' then return {
   subscribe=function(key,obj,cb)subscribers[key]={obj=obj,cb=cb};return key end,
   pause=function(key)subscribers[key].paused=true end,
   resume=function(key)subscribers[key].paused=false end
  }end
  assert(name=='lvgl')
  return {Object=function(_,props)
   local obj={props=props,clear_flag=function()end,set=function(self,p)for k,v in pairs(p)do self.props[k]=v end end}
   objects[#objects+1]=obj;return obj
  end,OPA=function(n)return n end,FLAG={SCROLLABLE=1},
   Font=function()end,ALIGN={CENTER=1},Label=function(_,props)
    local obj={props=props,set=function(self,p)for k,v in pairs(p)do self.props[k]=v end end};labels[#labels+1]=obj;return obj
   end,Timer=function(props)timer={cb=props.cb,pause=function(self)self.paused=true end,resume=function(self)self.paused=false end};return timer end}
 end
 assert(load(source,'daily-clock-model'))()
 local clock,hours,minutes
 for _,item in ipairs(labels)do
  if item.props.text=='20:36' then clock=item
  elseif item.props.text=='20' then hours=item
  elseif item.props.text=='36' then minutes=item end
 end
 local drawn=source:find('local function clock_render(time)',1,true)~=nil
 local function geometry()
  local values={}
  for _,obj in ipairs(objects)do
   local p=obj.props
   if p.x and p.bg_opa~=0 then
    assert(p.x>=0 and p.y>=0 and p.x+p.w<=336 and p.y+p.h<=480,'drawn shape outside screen')
    values[#values+1]=table.concat({p.x,p.y,p.w,p.h,p.bg_color},',')
   end
  end
  return table.concat(values,';')
 end
 local function clock_text()return clock and clock.props.text or (hours and hours.props.text..':'..minutes.props.text)end
 assert(timer and (drawn or clock or (hours and minutes)),'clock missing after bootstrap')
 if drawn then
  assert(files[P..'ui.json']:find('"clock":"20:36"',1,true),'drawn clock must start with current time')
  assert(#objects<1100,'bounded drawing object budget')
 else assert(clock_text()=='20:36')end
 local original=geometry()
 hour='21:37';timer.cb()
 if drawn then assert(geometry()~=original,'drawn digits must change with time')else assert(clock_text()=='21:37','clock must update')end
 if scenario=='dataman' then
  local values={systemStatusBattery=86,healthStepCount=12345,healthHeartRate=72}
  for key,value in pairs(values)do local sub=assert(subscribers[key]);sub.cb(sub.obj,value*256)end
  assert(subscribers.systemStatusBattery.obj.props.text=='86%')
  assert(subscribers.healthStepCount.obj.props.text=='12,345')
  assert(subscribers.healthHeartRate.obj.props.text=='72')
  local sub=subscribers.healthStepCount
  sub.cb(sub.obj,-256);sub.cb(sub.obj,0/0);sub.cb(sub.obj,math.huge)
  assert(sub.obj.props.text=='12,345','invalid data must not replace a valid reading')
  local hr=subscribers.healthHeartRate;hr.cb(hr.obj,0);assert(hr.obj.props.text=='--')
 end
 pageOnPause();assert(timer.paused)
 for _,sub in pairs(subscribers)do assert(sub.paused,'hidden subscriptions must pause')end
 local before_pause=geometry()
 hour='22:38';timer.cb()
 if drawn then assert(geometry()==before_pause,'hidden drawn clock must stay paused')
 elseif scenario=='dataman' then assert(clock_text()=='21:37','hidden clock must stay paused')end
 pageOnResume();assert(not timer.paused)
 if drawn then assert(geometry()~=before_pause,'resume must redraw time')else assert(clock_text()=='22:38')end
 for _,sub in pairs(subscribers)do assert(not sub.paused,'visible subscriptions must resume')end
 for _,item in ipairs(clock and {clock} or hours and {hours,minutes} or {})do
  local p=item.props
  assert(p.x>=0 and p.y>=0 and p.x+p.width<=336 and p.y+p.height<=480,'time must fit the screen')
 end
 if clock then assert(clock.props.text_align==2,'text alignment must not use object alignment enum')end
 if drawn then
  for _,value in ipairs({'00:00','11:11','22:22','03:33','04:44','05:55','06:06','07:07','08:08','09:09'})do
   hour=value;timer.cb();assert(#geometry()>0)
  end
 end
 io,os,require=real_io,real_os,real_require
 local count=0;for _,command in ipairs(commands)do if command:match('^insmod ')then count=count+1 end end
 return count
end
local function fixture(loaded)
 local files={};local modules={}
 for _,def in ipairs(definitions)do files[def.path]=def.bytes;files[def.state]='healthy:'..def.sha..'\n';files[def.status]=ready(def);modules[def.name]=loaded end
 return files,modules
end
local files,modules=fixture(true);assert(run(files,modules)==0 and files[P..'report.txt']:match('daily%-v1:ready'))
files,modules=fixture(false);assert(run(files,modules)==2);assert(run(files,modules)==0,'duplicate loads')
files,modules=fixture(false);assert(run(files,modules,'failed-load')==1);assert(run(files,modules)==0,'uncertain load replayed')
files,modules=fixture(true);modules.bc_shell043=false;files[definitions[2].state]='pending:'..definitions[2].sha..'\n';assert(run(files,modules)==0)
files,modules=fixture(true);modules.bc_shell043=false;files[definitions[2].state]=nil;assert(run(files,modules)==0)
files,modules=fixture(false);assert(run(files,modules,'wrong-fw')==0)
files,modules=fixture(false);files[definitions[2].path]=files[definitions[2].path]..'extra';assert(run(files,modules)==0)
if source:find("require,'dataman'",1,true)then files,modules=fixture(true);assert(run(files,modules,'dataman')==0)end
print('Daily clock/recovery: time update and pause/resume, live adoption, clean reboot, no duplicate/uncertain retry, firmware and exact module boundaries passed')
