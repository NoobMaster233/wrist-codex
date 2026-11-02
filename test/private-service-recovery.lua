-- Exercise the loader with fake files/timers, never execute device commands.
local realio,realos,realrequire=io,os,require
local f=assert(io.open(assert(arg[1]),'rb'));local source=f:read('a');f:close()
local defs={}
for name,path,sha,decoder,encoded,state,status,kind in source:gmatch("name='([^']+)',path='([^']+)',sha='([^']+)',bytes=([%w_]+)%('([^']+)'%),state='([^']+)',status='([^']+)',kind='([^']+)'")do
 local bytes
 if arg[#defs+2]then local f=assert(realio.open(arg[#defs+2],'rb'));bytes=f:read('a');f:close()
 else assert(decoder=='unhex','provide raw module files to verify base64 decoding');bytes=encoded:gsub('..',function(h)return string.char(tonumber(h,16))end)end
 defs[#defs+1]={name=name,path=path,sha=sha,state=state,status=status,kind=kind,bytes=bytes}
end
assert(#defs==3)
local migration_allowed=source:find('local ALLOW_LINK_MIGRATION=true',1,true)~=nil
local revision=tonumber(source:match('local RECOVERY_VERSION=(%d+)'))or 1
local link_version=tonumber(source:match('local LINK_STATUS_VERSION=(%d+)'))or 1
local P=assert(source:match("local P='([^']+)'"))
local key='/data/files/dev.bandcodex.remote/bc-private-link-v1.key'
local first_install=source:find('local key_source=',1,true)~=nil
local key_source=source:match("local key_source=assert%(read%('([^']+)'")
local function ready(d)
 if d.kind=='shell' then return 'ready:shell043-v1\n' end
 if d.kind=='link' then return string.pack('<c8I4I4i4i4i4','BCLN0431',link_version,5,42,0,-99)..string.rep('\0',44)end
 return string.pack('<c8I4I4I4I4','BCAP0432',2,16000,20,0)..string.rep('\0',36)..string.pack('<I4',2)
end
local function run(scenario)
 local files,loaded,timers,labels,loads={},{},{},{},0
 local present=scenario=='adopt' or scenario=='bad-resident' or scenario=='old-resident' or scenario:find('link',1,true)~=nil
 for _,d in ipairs(defs)do files[d.path]=d.bytes;files[d.state]='healthy:'..d.sha..'\n';if present then loaded[d.name]=true;files[d.status]=ready(d)end end
 files[key]=string.rep('k',32)
 if first_install then files[key_source]=string.rep('k',32)end
 if scenario=='fresh' then
  for _,d in ipairs(defs)do files[d.state]=nil end
  files[key]=nil
 end
 if scenario=='no-key-source' then files[key_source]=nil;files[key]=nil end
 if scenario=='key-mismatch' then files[key]=string.rep('x',32)end
 if scenario=='wrong-file' then files[defs[3].path]=files[defs[3].path]..'x'end
 if scenario=='no-key' then files[key]=nil end
 if scenario=='pending' then files[defs[1].state]='pending:'..defs[1].sha..'\n'end
 if scenario=='missing-state' then files[defs[1].state]=nil end
 if scenario=='bad-resident' then files[defs[1].status]='broken'end
 if scenario=='old-resident' then files[defs[3].status]=string.pack('<c8I4I4i4i4i4','BCLN0431',1,5,42,0,-99)..string.rep('\0',44)end
 if scenario=='migrate-link'or scenario=='pending-link'or scenario=='uncertain-link'then
  loaded[defs[3].name]=nil;files[defs[3].state]=scenario=='pending-link'and'pending:unknown\n'or nil
  files['/data/bc-private-link-bootstrap-043-v1.state']=scenario=='uncertain-link'and'pending:unknown\n'or'healthy:2dc58d207dbc6e2b4ee7f10f4f24884988a8ec373d18259dd66405ba17d7f381\n'
 end
 io={open=function(path,mode)
  if mode=='rb' then if not files[path]then return nil end;return{read=function(_,n)return files[path]:sub(1,n)end,close=function()return true end}end
  assert(not path:match('once') and not path:match('attempt'))
  assert(revision~=2 or path~='/data/bc-private-link-bootstrap-043-v1.state','legacy state must stay untouched')
  return{write=function(_,s)files[path]=s;return true end,close=function()return true end}
 end}
 os={date=function(fmt)return fmt=='%H:%M' and '12:34' or '10月28日'end,execute=function(cmd)
  if cmd=='getprop ro.build.version > '..P..'fw.txt' then files[P..'fw.txt']=scenario=='wrong-fw' and '3.999.0\n' or '3.101.043\n'
  elseif cmd=='lsmod > '..P..'modules.txt' then
   local s='NAME TEXT DATA\n';for name in pairs(loaded)do s=s..name..' 1 2\n'end;files[P..'modules.txt']=s
  else
   assert(cmd:match('^insmod '),'unexpected command '..cmd);loads=loads+1
   for _,d in ipairs(defs)do if cmd=='insmod '..d.path..' '..d.name..' > '..P..d.kind..'-load.txt' then
    assert(files[d.state]=='pending:'..d.sha..'\n')
    if scenario=='failed' then return nil,'exit',256 end
    loaded[d.name]=true;if scenario~='timeout' then files[d.status]=ready(d)end
   end end
  end
  return true,'exit',0
 end}
 local function obj(props)return{props=props,set=function(self,p)for k,v in pairs(p)do self.props[k]=v end end,clear_flag=function()end}end
 require=function(name)assert(name=='lvgl');return{
  Object=function(_,p)return obj(p)end,Label=function(_,p)local o=obj(p);labels[#labels+1]=o;return o end,
  OPA=function(v)return v end,FLAG={SCROLLABLE=1},Font=function()end,
  Timer=function(p)local t={cb=p.cb,pause=function(self)self.paused=true end,resume=function(self)self.paused=false end};timers[#timers+1]=t;return t end}
 end
 assert(load(source,'private-recovery-model'))()
 for _=1,100 do for _,t in ipairs(timers)do if not t.paused then t.cb()end end end
 assert(labels[2].props.text=='12:34','clock stays usable')
 pageOnPause();for _,t in ipairs(timers)do assert(t.paused)end
 pageOnResume();assert(not timers[1].paused)
 local report=assert(files[P..'report.txt'])
 io,os,require=realio,realos,realrequire
 return loads,report,files
end
if first_install then
 for _,s in ipairs({'adopt','fresh','wrong-fw','wrong-file','no-key-source','key-mismatch','pending','failed','timeout'})do
  local n,report,files=run(s)
  local expected=s=='fresh'and 3 or ((s=='failed'or s=='timeout')and 1 or 0)
  assert(n==expected,s..' load count '..n)
  assert(report:find('recovery-v2:'..((s=='adopt'or s=='fresh')and'ready'or'blocked'),1,true),s..' report')
  if s=='failed'or s=='timeout'then assert(files[defs[1].state]=='pending:'..defs[1].sha..'\n')end
 end
 print('First install: 9 offline scenarios passed; no hardware commands executed')
else
for _,s in ipairs({'adopt','reboot','wrong-fw','wrong-file','no-key','pending','missing-state','bad-resident','failed','timeout'})do
 local n,report,files=run(s)
 local expected=s=='reboot' and 3 or ((s=='failed' or s=='timeout') and 1 or 0)
 assert(n==expected,s..' load count '..n)
 assert(report:find('recovery-v'..revision..((s=='adopt' or s=='reboot')and':ready'or':blocked'),1,true),s..' report')
 if s=='failed' or s=='timeout' then assert(files[defs[1].state]=='pending:'..defs[1].sha..'\n')end
end
if revision==2 then
 for _,s in ipairs({'migrate-link','pending-link','uncertain-link','old-resident'})do
  local n,report=run(s);assert(n==(s=='migrate-link'and migration_allowed and 1 or 0),s..' load count')
  assert(report:find('recovery-v2:'..(s=='migrate-link'and migration_allowed and'ready'or'blocked'),1,true),s..' report')
 end
end
print('Private recovery: '..(revision==2 and 14 or 10)..' scenarios passed; exact files/firmware/key, adoption, reboot, pending guard, migration and clock/pause verified')

end
