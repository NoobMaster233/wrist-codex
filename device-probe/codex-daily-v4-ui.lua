-- Daily Mint: native LVGL objects, no image animation or sensor activation.
local colors={background=0x000000,primary=0xf4f6f7,secondary=0x82908e,
 accent=0x9ce8cc,track=0x1e2926,card=0x101715,warning=0xffbf69}
local root=lvgl.Object(nil,{w=336,h=480,bg_color=colors.background,bg_opa=lvgl.OPA(100),border_width=0,pad_all=0})
root:clear_flag(lvgl.FLAG.SCROLLABLE)
local function font(size)
 local ok,value=pcall(lvgl.Font,'MiSans-Regular',size)
 if ok and value then return value end
 return lvgl.Font('MiSans-Regular',24)
end
local function box(x,y,w,h,color,radius)
 local object=lvgl.Object(root,{x=x,y=y,w=w,h=h,bg_color=color,bg_opa=lvgl.OPA(100),
  border_width=0,pad_all=0,radius=radius or 0})
 object:clear_flag(lvgl.FLAG.SCROLLABLE)
 return object
end
local function label(text,x,y,w,h,size,color,align)
 return lvgl.Label(root,{text=text,x=x,y=y,width=w,height=h,text_color=color,
  text_font=font(size),text_align=align or 0})
end
label('CODEX  /  DAILY',28,31,190,26,17,colors.secondary)
local battery=label('--%',220,29,88,30,21,colors.accent,2)
box(226,60,76,3,colors.track,1)
local battery_fill=box(226,60,1,3,colors.accent,1)
local date=label('',28,86,280,38,25,colors.primary,2)
local clock=label('--:--',8,124,320,124,96,colors.primary,2)
local seconds=label('-- SEC',28,247,280,28,18,colors.secondary,2)
box(28,286,280,3,colors.track,1)
local second_fill=box(28,286,1,3,colors.accent,1)
box(20,316,144,100,colors.card,18)
box(172,316,144,100,colors.card,18)
label('今日步数',34,329,116,27,19,colors.secondary,2)
local steps=label('--',28,359,128,43,31,colors.primary,2)
label('最近心率',186,329,116,27,19,colors.secondary,2)
local heart=label('--',180,359,128,43,31,colors.primary,2)
local state=label('CODEX',28,437,280,26,17,colors.secondary,2)
local weekdays={'周日','周一','周二','周三','周四','周五','周六'}
local ui={version=4,clock='--:--',date='',tickCount=0,battery=false,steps=false,heart=false,
 subscriptions=0,paused=false,serviceReady=false,screenWidth=336,screenHeight=480}
local function save_ui()
 -- Only presence flags, clock and lifecycle; no health readings in reports.
 local value=string.format('{"version":4,"clock":"%s","date":"%s","tickCount":%d,"battery":%s,"steps":%s,"heart":%s,"subscriptions":%d,"paused":%s,"serviceReady":%s}\n',
  ui.clock,ui.date,ui.tickCount,tostring(ui.battery),tostring(ui.steps),tostring(ui.heart),
  ui.subscriptions,tostring(ui.paused),tostring(ui.serviceReady))
 pcall(write,P..'ui.json',value)
end
local last_time,last_date,last_seconds
local function tick()
 if ui.paused then return end
 local t=os.date('%H:%M')
 local d=tonumber(os.date('%m'))..'月'..tonumber(os.date('%d'))..'日  '..weekdays[tonumber(os.date('%w'))+1]
 local s=os.date('%S')
 if t~=last_time then clock:set{text=t};last_time=t;ui.clock=t end
 if d~=last_date then date:set{text=d};last_date=d;ui.date=d end
 if s~=last_seconds then
  seconds:set{text=s..' SEC'}
  second_fill:set{w=math.max(1,math.floor(280*(tonumber(s)+1)/60))}
  last_seconds=s
 end
 ui.tickCount=ui.tickCount+1
end
local data_ok,dataman=pcall(require,'dataman')
local subscriptions={}
local function subscribe(key,object,callback)
 if not data_ok or type(dataman.subscribe)~='function' then return end
 local ok,token=pcall(dataman.subscribe,key,object,function(obj,raw)
  -- dataman values are signed fixed point (8 fraction bits).
  if type(raw)~='number' or raw~=raw or raw==math.huge or raw==-math.huge then return end
  pcall(callback,obj,math.floor(raw/256))
 end)
 if ok then
  ui.subscriptions=ui.subscriptions+1
  if token~=nil then subscriptions[#subscriptions+1]=token end
 end
end
local function first_value(key)
 if not ui[key] then ui[key]=true;save_ui() end
end
subscribe('systemStatusBattery',battery,function(obj,value)
 if value<0 or value>100 then return end
 local color=value<=15 and colors.warning or colors.accent
 obj:set{text=tostring(value)..'%',text_color=color}
 battery_fill:set{w=math.max(1,math.floor(76*value/100)),bg_color=color}
 first_value('battery')
end)
subscribe('healthStepCount',steps,function(obj,value)
 if value<0 or value>999999 then return end
 local text=tostring(value)
 if value>=100000 then text=string.format('%.1f万',value/10000)
 elseif value>=1000 then text=tostring(math.floor(value/1000))..','..string.format('%03d',value%1000) end
 obj:set{text=text};first_value('steps')
end)
subscribe('healthHeartRate',heart,function(obj,value)
 -- Zero/missing values are shown as unavailable; no measurement starts here.
 if value<30 or value>240 then obj:set{text='--'};return end
 obj:set{text=tostring(value)};first_value('heart')
end)
tick()
local timer=lvgl.Timer{period=1000,cb=tick}
local function pause_data(method)
 if data_ok and type(dataman[method])=='function' then
  for _,token in ipairs(subscriptions)do pcall(dataman[method],token) end
 end
end
pageOnPause=function()
 ui.paused=true;timer:pause();pause_data('pause');save_ui()
end
pageOnResume=function()
 ui.paused=false;tick();pause_data('resume');timer:resume();save_ui()
end
local function service_state(ok)
 ui.serviceReady=ok
 state:set{text=ok and 'CODEX  ·  语音就绪' or 'CODEX  ·  服务待恢复',
  text_color=ok and colors.accent or colors.warning}
 save_ui()
end
