local fio,fos,freq=io,os,require
local f=assert(io.open(arg[1],'rb'));local source=f:read('a');f:close()
assert(not source:find('os.execute',1,true)and not source:find('insmod',1,true))
local files,subscriptions,timers,labels,objects={},{},{},{},{}
local hour='20:36'
io={open=function(path,mode)assert(mode=='wb'and path:match('bc%-presentation%-ui%d+%-ui.json$'));return{write=function(_,s)files[path]=s;return true end,close=function()return true end}end}
os={date=function(fmt)return({['%H:%M']=hour,['%m']='10',['%d']='28',['%w']='3',['%S']='28'})[fmt]end,execute=function()error('display must not execute commands')end}
local function obj(p)local o={props=p,clear_flag=function()end,set=function(self,s)for k,v in pairs(s)do self.props[k]=v end end};objects[#objects+1]=o;return o end
require=function(name)
 if name=='dataman'then return{subscribe=function(key,o,cb)subscriptions[key]={obj=o,cb=cb};return key end,pause=function(k)subscriptions[k].paused=true end,resume=function(k)subscriptions[k].paused=false end}end
 assert(name=='lvgl');return{Object=function(_,p)return obj(p)end,Label=function(_,p)local o=obj(p);labels[#labels+1]=o;return o end,Font=function()end,OPA=function(n)return n end,FLAG={SCROLLABLE=1},Timer=function(p)local t={cb=p.cb,pause=function(self)self.paused=true end,resume=function(self)self.paused=false end};timers[#timers+1]=t;return t end}
end
assert(load(source,'pure-presentation'))()
local path,text=next(files);assert(path and text:find('"clock":"20:36"',1,true))
assert(not text:find('serviceReady',1,true),'display must not invent service health')
assert(#timers==1 and #objects<1100)
local function health(key,value)local s=assert(subscriptions[key]);s.cb(s.obj,value*256);return s.obj.props.text end
assert(health('systemStatusBattery',86)=='86%');assert(health('healthStepCount',12345)=='12,345');assert(health('healthHeartRate',72)=='72')
assert(health('healthHeartRate',0)=='--')
hour='21:37';timers[1].cb();pageOnPause();assert(timers[1].paused)
for _,s in pairs(subscriptions)do assert(s.paused)end
pageOnResume();assert(not timers[1].paused)
for _,s in pairs(subscriptions)do assert(not s.paused)end
assert(files[path]:find('"clock":"21:37"',1,true))
io,os,require=fio,fos,freq
print('UI-only dial: real clock, health values, pause/resume, no native execution passed')
