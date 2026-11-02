-- Afterglow: stacked typography and a sunset with an orbiting second hand.
-- Native LVGL geometry; no raster background, sensor activation or frame loop.
local colors={background=0x171215,primary=0xf4e6d2,secondary=0xbaa79c,
 accent=0xeda37a,orbit=0x60433c,rule=0x382b2b,muted=0xa68f83,warning=0xffbd82}
local root=lvgl.Object(nil,{w=336,h=480,bg_color=colors.background,bg_opa=lvgl.OPA(100),border_width=0,pad_all=0})
root:clear_flag(lvgl.FLAG.SCROLLABLE)
local fonts={}
local function font(size)
 if fonts[size] then return fonts[size] end
 local ok,value=pcall(lvgl.Font,'MiSans-Regular',size)
 if not ok or not value then value=lvgl.Font('MiSans-Regular',24) end
 fonts[size]=value;return value
end
local function box(x,y,w,h,color,radius)
 local object=lvgl.Object(root,{x=x,y=y,w=w,h=h,bg_color=color,bg_opa=lvgl.OPA(100),
  border_width=0,pad_all=0,radius=radius or 0})
 object:clear_flag(lvgl.FLAG.SCROLLABLE)
 object:clear_flag(lvgl.FLAG.CLICKABLE)
 return object
end
local function label(text,x,y,w,h,size,color,align)
 return lvgl.Label(root,{text=text,x=x,y=y,width=w,height=h,text_color=color,
  text_font=font(size),text_align=align or 0})
end
local date=label('',29,34,211,30,18,colors.secondary)
local battery=label('--%',242,33,65,29,17,colors.secondary,3)
-- The single-pixel orbit and flat sun are drawn with the same primitives as
-- the proven daily clock. The lower cutouts form a quiet horizon.
box(200,151,130,130,colors.orbit,65)
box(201,152,128,128,colors.background,64)
box(223,174,84,84,colors.accent,42)
box(223,230,84,3,colors.background)
box(223,238,84,4,colors.background)
box(223,246,84,5,colors.background)
box(223,254,84,5,colors.background)
local second_hand=box(261,148,8,8,colors.primary,4)
local hours=label('--',22,75,180,160,126,colors.primary)
local minutes=label('--',22,202,180,160,126,colors.primary)
local state=label('余 晖',201,295,128,33,18,0xc88c70,2)
box(30,369,276,1,colors.rule)
local steps=label('--',30,385,152,43,28,colors.primary)
local heart=label('--',214,385,92,43,28,colors.primary,3)
label('步数',31,426,100,29,16,colors.muted)
label('心率',205,426,100,29,16,colors.muted,3)
local weekdays={'周日','周一','周二','周三','周四','周五','周六'}
local ui={version=5,clock='--:--',date='',tickCount=0,battery=false,steps=false,heart=false,
 subscriptions=0,paused=false,serviceReady=false,screenWidth=336,screenHeight=480}
local function save_ui()
 -- Presence flags only; no health readings, and no per-second flash writes.
 local value=string.format('{"version":5,"theme":"afterglow","clock":"%s","date":"%s","tickCount":%d,"battery":%s,"steps":%s,"heart":%s,"subscriptions":%d,"paused":%s,"serviceReady":%s}\n',
  ui.clock,ui.date,ui.tickCount,tostring(ui.battery),tostring(ui.steps),tostring(ui.heart),
  ui.subscriptions,tostring(ui.paused),tostring(ui.serviceReady))
 pcall(write,P..'ui.json',value)
end
local last_time,last_date,last_seconds
local function tick()
 if ui.paused then return end
 local t=os.date('%H:%M')
 local d=tonumber(os.date('%m'))..'月'..tonumber(os.date('%d'))..'日 · '..weekdays[tonumber(os.date('%w'))+1]
 local s=os.date('%S')
 if t~=last_time then
  hours:set{text=t:sub(1,2)};minutes:set{text=t:sub(4,5)};last_time=t;ui.clock=t
 end
 if d~=last_date then date:set{text=d};last_date=d;ui.date=d end
 if s~=last_seconds then
  local angle=tonumber(s)*math.pi/30-math.pi/2
  second_hand:set{x=math.floor(265+64.5*math.cos(angle)-4+.5),
   y=math.floor(216+64.5*math.sin(angle)-4+.5)}
  last_seconds=s
 end
 ui.tickCount=ui.tickCount+1
end
local data_ok,dataman=pcall(require,'dataman')
local subscriptions={}
local function subscribe(key,object,callback)
 if not data_ok or type(dataman.subscribe)~='function' then return end
 local ok,token=pcall(dataman.subscribe,key,object,function(obj,raw)
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
 obj:set{text=tostring(value)..'%',text_color=value<=15 and colors.warning or colors.secondary}
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
 state:set{text=ok and '余 晖' or '语音待恢复',text_color=ok and 0xc88c70 or colors.warning}
 save_ui()
end
