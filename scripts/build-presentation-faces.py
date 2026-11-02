"""Build UI-only editions of the five existing designs; no deployment or native loading."""
import argparse,hashlib,json,subprocess
from pathlib import Path
from lua_face import pack_lua_face
root=Path(__file__).resolve().parents[1]
styles={4:('Mint','mint'),5:('余晖','afterglow'),6:('流光','lumen'),7:('棱镜','prism'),8:('绢白','silk')}
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--revision',type=int,default=1);args=p.parse_args()
assert 1<=args.revision<=99
out=root/('artifacts/research/presentation-faces-043-v'+str(args.revision))
if out.exists():raise SystemExit('Preserve the existing presentation build')
out.mkdir(mode=0o700,parents=True)
prefix="""-- Daily display only. Native services are managed by the unified recovery entry.
local lvgl=require('lvgl')
-- Compact rectangle glyphs used by the original custom digit designs.
local function unhex(s)return(s:gsub('..',function(h)return string.char(tonumber(h,16))end))end
local P='/data/files/dev.bandcodex.remote/bc-presentation-ui@VERSION@-'
local function write(path,text)
 assert(path==P..'ui.json','diagnostic path differs')
 local f=assert(io.open(path,'wb'));assert(f:write(text));assert(f:close())
end
"""
manifest={'firmware':'3.101.043','nativeLoads':0,'nativeCommands':0,'healthMeasurementsStarted':False,'designs':[]}
for version,(title,theme)in styles.items():
 source=(root/('device-probe/codex-daily-v'+str(version)+'-ui.lua')).read_text()
 source=source[:source.index('local function service_state(ok)')]
 source=source.replace('serviceReady=false,','').replace(',serviceReady=false','')
 source=source.replace(',"serviceReady":%s','').replace(',tostring(ui.serviceReady)','')
 script=prefix.replace('@VERSION@',str(version))+source+'\nsave_ui()\n'
 assert 'os.execute'not in script and 'insmod'not in script
 identifier=str(219667877+version);folder=out/str(version);folder.mkdir()
 lua=folder/'main.lua';lua.write_text(script)
 subprocess.run(['luac','-p',str(lua)],check=True)
 subprocess.run(['lua',str(root/'test/presentation-face.lua'),str(lua)],check=True)
 old=root/'assets/watchface'
 # This field is the menu thumbnail, not the Lua canvas. Keep the proven
 # 336x480 UI and rasterize its preview at the supported 84x120 thumbnail size.
 preview=folder/'preview.png'
 subprocess.run(['rsvg-convert','--width','84','--height','120','--output',str(preview),str(old/('preview-v'+str(version)+'.svg'))],check=True)
 rgba=subprocess.check_output(['magick',str(preview),'-depth','8','rgba:-'])
 bgra=bytearray(rgba)
 for i in range(0,len(bgra),4):bgra[i],bgra[i+2]=bgra[i+2],bgra[i]
 data=pack_lua_face(script.encode(),identifier,title,width=84,height=120,preview_rgba=bytes(bgra))
 artifact=folder/(theme+'.face');artifact.write_bytes(data)
 manifest['designs'].append({'name':title,'theme':theme,'watchfaceId':identifier,'previousId':str(219667866+version),
  'artifact':str(artifact.relative_to(root)),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),
  'luaSha256':hashlib.sha256(script.encode()).hexdigest(),'nativeLoads':0,'nativeCommands':0,'canvasSize':[336,480],'thumbnailSize':[84,120]})
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(manifest,ensure_ascii=False))
