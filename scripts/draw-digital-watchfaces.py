"""Draw three original numeral alphabets; generate identical Lua/SVG geometry."""
from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'assets/watchface'

# Original, optically adjusted centre lines, in an 84 x 128 em. These are
# drawings, not outlines copied from an installed or downloaded font.
FLOW = [
 'M42 9 C19 9 12 27 12 64 S19 119 42 119 S72 101 72 64 S65 9 42 9 Z',
 'M24 29 L46 9 L46 119',
 'M13 31 C16 13 30 7 46 9 C70 11 79 32 67 50 L14 111 Q10 119 20 119 L72 119',
 'M15 12 L62 12 Q76 12 66 24 L42 53 C80 48 84 83 66 107 C53 124 27 123 12 110',
 'M57 9 L13 78 Q9 85 18 85 L74 85 M58 41 L58 119',
 'M70 10 L20 10 L15 60 C34 46 59 51 69 67 C89 102 55 132 15 110',
 'M65 11 C27 6 11 34 11 73 C11 108 24 120 44 119 C83 117 83 65 45 62 C28 61 18 69 12 81',
 'M12 10 L72 10 L30 119',
 'M42 62 C6 62 3 10 42 9 C81 8 80 57 42 62 C1 66 2 119 42 119 C82 119 83 65 42 62 Z',
 'M18 117 C57 124 73 94 73 54 C73 20 60 8 40 9 C1 11 1 63 39 66 C56 67 66 59 72 47',
]
# The second alphabet is deliberately architectural: chamfered corners,
# open counters, square terminals and a subtle forward lean.
PRISM = [
 'M23 10 H61 L72 22 V106 L61 118 H23 L12 106 V22 Z',
 'M23 29 L44 10 V118',
 'M12 20 L23 10 H61 L72 22 V49 L12 102 V118 H72',
 'M12 10 H61 L72 22 V51 L55 64 L72 77 V106 L61 118 H12 M35 64 H55',
 'M58 10 L12 79 V84 H74 M58 44 V118',
 'M72 10 H12 V61 H60 L72 73 V106 L60 118 H12',
 'M68 10 H36 L12 35 V106 L24 118 H60 L72 106 V77 L60 65 H12',
 'M12 10 H72 V24 L30 118',
 'M24 10 H60 L72 22 V49 L57 64 L72 79 V106 L60 118 H24 L12 106 V79 L27 64 L12 49 V22 Z M27 64 H57',
 'M72 63 H24 L12 51 V22 L24 10 H60 L72 22 V93 L48 118 H17',
]
# Fine, high-contrast editorial numerals, each composed by hand. The wider
# strokes are intentional vertical stresses rather than a generic serif font.
SILK = [
 [('M42 7 C17 7 10 29 10 64 S17 121 42 121 S74 99 74 64 S67 7 42 7 Z',2.5),
  ('M23 18 C6 41 7 88 23 110 M61 18 C78 41 77 88 61 110',7)],
 [('M24 30 L47 7 V120 M26 120 H67',2.5),('M47 10 V119',8)],
 [('M12 30 C15 9 34 3 53 9 C78 17 76 42 61 57 L12 120 H73 V105',2.5),
  ('M68 27 Q72 41 59 56 L33 83',7)],
 [('M13 16 C47 -1 75 9 69 34 C66 51 54 57 38 61 C87 56 83 110 54 119 C38 125 21 120 11 110',2.5),
  ('M68 21 C73 42 57 54 47 58 M67 76 C77 95 64 113 53 117',7)],
 [('M56 7 L10 86 H76 M56 37 V120 M40 120 H74',2.5),('M56 39 V119',8)],
 [('M71 8 H20 L15 62 C37 44 67 54 73 77 C81 110 49 132 13 111',2.5),
  ('M66 69 C81 99 62 117 49 120',7)],
 [('M68 11 C27 -3 10 36 10 76 C10 108 25 123 45 121 C83 117 80 61 43 61 C27 61 15 70 11 83',2.5),
  ('M20 41 C9 76 17 111 32 118 M66 73 C76 98 60 118 50 119',7)],
 [('M12 25 V8 H74 L28 121',2.5),('M69 17 L33 108',7)],
 [('M42 61 C4 57 4 7 42 7 C82 7 81 55 42 61 C-1 68 0 121 42 121 C84 121 85 69 42 61 Z',2.5),
  ('M18 22 C9 43 28 56 42 61 C69 74 83 99 59 116 M64 16 C82 37 59 54 48 57 M20 77 C8 97 16 113 28 118',6)],
 [('M16 117 C55 132 74 91 74 52 C74 20 59 5 39 7 C1 11 4 67 41 67 C57 67 69 58 73 45',2.5),
  ('M19 55 C8 31 25 11 35 9 M64 17 C78 39 70 96 55 112',7)],
]

THEMES = [
 dict(version=6,id='219667872',name='流光',theme='lumen',bg=0x070e20,
      primary=0xe9f8ff,secondary=0x8eacc6,muted=0x68839e,accent=0x7bdcf4,
      rule=0x22334b,warning=0xffbb88,font=FLOW,stroke=12,em=(116,151),
      slots=[(46,87),(175,87),(46,244),(175,244)],gradient=(0xe8fbff,0x69b5f4),
      date=(33,34,216,27,18,0),battery=(258,35,48,26,16,3),
      steps=(33,421,145,31,21,0),heart=(229,421,77,31,21,3),
      step_label=(34,452,110,22,12,0),heart_label=(222,452,84,22,12,3),
      state=(133,42,1,1,1,0),seconds=(145,227,46,19,13,2)),
 dict(version=7,id='219667873',name='棱镜',theme='prism',bg=0x120d1c,
      primary=0xf1e5ff,secondary=0xb4a4c7,muted=0x80718e,accent=0xe7a6ff,
      rule=0x3d2a50,warning=0xffbb88,font=PRISM,stroke=15,em=(106,142),
      slots=[(34,89),(152,89),(68,249),(186,249)],gradient=(0xf5cfff,0xa192ff),
      date=(29,32,210,28,17,0),battery=(248,33,58,27,16,3),
      steps=(30,417,147,33,22,0),heart=(232,417,74,33,22,3),
      step_label=(30,450,110,24,12,0),heart_label=(221,450,85,24,12,3),
      state=(1,1,1,1,1,0),seconds=(277,219,32,25,16,3)),
 dict(version=8,id='219667874',name='绢白',theme='silk',bg=0xeee9df,
      primary=0x242a36,secondary=0x636977,muted=0x8b8d94,accent=0x576eaa,
      rule=0xd0cbbc,warning=0xa45136,font=SILK,stroke=0,em=(62,126),
      slots=[(26,161),(94,161),(182,161),(250,161)],gradient=(0x242a36,0x242a36),
      date=(30,112,276,29,19,2),battery=(249,33,57,26,16,3),
      steps=(30,366,147,40,27,0),heart=(231,366,75,40,27,3),
      step_label=(31,407,100,27,15,0),heart_label=(221,407,85,27,15,3),
      state=(29,32,180,27,16,0),seconds=(146,306,44,27,17,2)),
]

def hx(c): return f'#{c:06x}'
def blend(a,b,t):
    return sum(round(((a>>s)&255)*(1-t)+((b>>s)&255)*t)<<s for s in (16,8,0))

def glyphs(theme):
    w,h=theme['em']; result=[]
    for drawing in theme['font']:
        parts=drawing if isinstance(drawing,list) else [(drawing,theme['stroke'])]
        paths=''.join(f'<path d="{d}" stroke-width="{max(sw,3.3) if theme["theme"]=="silk" else sw}"/>' for d,sw in parts)
        shear='transform="matrix(1 0 -.06 1 4 0)"' if theme['theme']=='prism' else ''
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 84 128"><g {shear} fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">{paths}</g></svg>'
        png=subprocess.check_output(['rsvg-convert'],input=svg.encode())
        pixels=subprocess.check_output(['magick','png:-','-background','black','-alpha','remove','-depth','8','gray:-'],input=png)
        assert len(pixels)==w*h
        # Pixel-accurate silhouettes, coalesced vertically. Every run is bounded
        # by the em; no opaque full-screen image or new image decoder required.
        rectangles=[];previous={}
        for y in range(h):
            runs=[];x=0
            while x<w:
                if pixels[y*w+x]<96:x+=1;continue
                start=x
                while x<w and pixels[y*w+x]>=96:x+=1
                runs.append((start,x-start))
            current={}
            for x,length in runs:
                # Limit vertical merges to 4px so a row tint stays a smooth ramp.
                key=(x,length,y//4) if theme['gradient'][0]!=theme['gradient'][1] else (x,length)
                if key in previous:
                    index=previous[key];rectangles[index][3]+=1
                else:
                    index=len(rectangles);rectangles.append([x,y,length,1])
                current[key]=index
            previous=current
        assert rectangles and all(0<=x<x+rw<=w and 0<=y<y+rh<=h for x,y,rw,rh in rectangles)
        result.append(rectangles)
    return result

def decoration(t):
    """Static vector objects and one moving second highlight, no frame loop."""
    if t['theme']=='lumen':
        # Two subtle diagonal light trails; the large digits carry the colour.
        rects=[]
        for i in range(48):
            x=237+i; y=71+round(i*.67)
            rects.append((x,y,13,3,blend(t['bg'],0x375790,.12+i/85),1))
        rects += [(33,70,270,1,0x24334c,0),(139,238,58,1,0x24334c,0),
                  (33,410,270,1,0x24334c,0)]
        dots=[(168,238,3,3,0x7bdcf4,1)]
    elif t['theme']=='prism':
        rects=[(28,70,280,1,0x3d2a50,0),(28,238,280,2,0x3d2a50,0),
               (28,405,280,1,0x3d2a50,0)]
        # Off-axis folds and cut ends echo the numeral chamfers.
        rects += [(28+i,257+i*2,2,5,0x38234d,0) for i in range(23)]
        rects += [(294,99,12,86,0xe7a6ff,1),(300,88,6,8,0xe7a6ff,1)]
        dots=[(28,237,12,4,0xe7a6ff,1)]
    else:
        rects=[(30,79,276,1,0xd0cbbc,0),(30,347,276,1,0xd0cbbc,0),
               (157,205,3,3,0x576eaa,1),(157,226,3,3,0x576eaa,1)]
        # A quiet typographic underline, with six distinct decade marks.
        rects += [(39+i*43,315,8,1,0xb2b3b5,0) for i in range(7) if i!=3]
        rects += [(146,455,44,1,0x576eaa,0)]
        dots=[(39,314,8,3,0x576eaa,1)]
    return rects,dots

def lua_drawing(t,gs):
    code=['local glyphs={']
    for digit,rs in enumerate(gs):
        encoded=bytes(v for r in rs for v in r).hex()
        code.append(f" [{digit}]=unhex('{encoded}'),")
    code.append('}')
    maxrects=max(map(len,gs))
    positions=','.join('{'+str(x)+','+str(y)+'}' for x,y in t['slots'])
    code += [f'local slots={{{positions}}}',f'local glyph_capacity={maxrects}',
             f'local glyph_height={t["em"][1]}',
             f'local tint_top=0x{t["gradient"][0]:06x};local tint_bottom=0x{t["gradient"][1]:06x}',
             'local digit_objects={}',
             'for i,position in ipairs(slots)do',
             ' local pool={};digit_objects[i]=pool',
             ' for n=1,glyph_capacity do pool[n]=box(position[1],position[2],1,1,colors.background);pool[n]:set{bg_opa=0} end',
             'end',
             'local function tint(y)',
             ' local t=y/glyph_height;local color=0',
             ' for _,s in ipairs({16,8,0})do local a=(tint_top>>s)&255;local b=(tint_bottom>>s)&255;color=color|(math.floor(a*(1-t)+b*t+.5)<<s) end',
             ' return color',
             'end',
             'local previous_digits={}',
             'local function clock_render(time)',
             ' local text=time:sub(1,2)..time:sub(4,5)',
             ' for i,position in ipairs(slots)do',
             '  local digit=tonumber(text:sub(i,i))',
             '  if digit~=previous_digits[i] then',
             '   local data=assert(glyphs[digit]);local pool=digit_objects[i];local count=#data//4',
             '   for n=1,glyph_capacity do',
             '    if n<=count then',
             '     local x,y,w,h=data:byte((n-1)*4+1,n*4)',
             '     pool[n]:set{x=position[1]+x,y=position[2]+y,w=w,h=h,bg_color=tint(y+h/2),bg_opa=lvgl.OPA(100)}',
             '    else pool[n]:set{bg_opa=0} end',
             '   end',
             '   previous_digits[i]=digit',
             '  end',
             ' end',
             'end']
    return '\n'.join(code),maxrects*4

def svg_label(text,p,color):
    x,y,w,h,size,align=p
    anchor='middle' if align==2 else 'end' if align==3 else 'start'
    px=x+w/2 if align==2 else x+w if align==3 else x
    return f'<text x="{px}" y="{y+size*.97}" font-size="{size}" text-anchor="{anchor}" fill="{hx(color)}">{text}</text>'

def main():
    template=(ROOT/'device-probe/codex-digital-ui.lua.in').read_text()
    for t in THEMES:
        gs=glyphs(t);rects,dots=decoration(t);drawing,count=lua_drawing(t,gs)
        draw=[];svg=[]
        for x,y,w,h,c,r in rects:
            draw.append(f'box({x},{y},{w},{h},0x{c:06x},{r})')
            svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{hx(c)}"/>')
        for x,y,w,h,c,r in dots:
            draw.append(f'local second_light=box({x},{y},{w},{h},0x{c:06x},{r})')
        # Preview 20:36:28 and illustrative health data. Numeral geometry and
        # row colours below are exactly the data used by the Lua renderer.
        for position,digit in zip(t['slots'],'2036'):
            for x,y,w,h in gs[int(digit)]:
                c=blend(*t['gradient'],(y+h/2)/t['em'][1])
                svg.append(f'<rect x="{position[0]+x}" y="{position[1]+y}" width="{w}" height="{h}" fill="{hx(c)}"/>')
        if t['theme']=='lumen':
            second='second_light:set{x=139+math.floor(s/59*55)}';sx=139+round(28/59*55)
        elif t['theme']=='prism':
            second='second_light:set{x=28+math.floor(s/59*268)}';sx=28+round(28/59*268)
        else:
            second='second_light:set{x=39+math.floor(s/59*250)}';sx=39+round(28/59*250)
        for x,y,w,h,c,r in dots:
            svg.append(f'<rect x="{sx}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{hx(c)}"/>')
        fields={k:t[k] for k in ['version','theme','name']}
        fields.update({k:f'0x{t[k]:06x}' for k in ['bg','primary','secondary','muted','accent','rule','warning']})
        for key in ['date','battery','steps','heart','step_label','heart_label','state','seconds']:
            p=t[key];fields[key+'_args']=','.join(map(str,(*p[:5],)))
            fields[key+'_align']=p[5]
        fields.update(drawing='\n'.join(draw)+'\n'+drawing,second_update=second,draw_objects=count)
        result=template
        for key,value in fields.items():result=result.replace('@'+key.upper()+'@',str(value))
        assert '@' not in result
        (ROOT/f'device-probe/codex-daily-v{t["version"]}-ui.lua').write_text(result)
        svg += [svg_label('10月27日 · 周二',t['date'],t['secondary']),
                svg_label('86%',t['battery'],t['secondary']),
                svg_label('6,842',t['steps'],t['primary']),svg_label('72',t['heart'],t['primary']),
                svg_label('步数',t['step_label'],t['muted']),svg_label('心率',t['heart_label'],t['muted']),
                svg_label('28',t['seconds'],t['accent'])]
        if t['theme']=='silk':svg.append(svg_label('绢 白',t['state'],t['accent']))
        doc=f'<svg xmlns="http://www.w3.org/2000/svg" width="336" height="480" viewBox="0 0 336 480"><rect width="336" height="480" fill="{hx(t["bg"])}"/><g font-family="sans-serif">'+''.join(svg)+'</g></svg>'
        (ASSETS/f'{t["theme"]}-preview.svg').write_text(doc+'\n')
        print(json.dumps(dict(name=t['name'],version=t['version'],glyphRectangles=list(map(len,gs)),digitObjectPool=count,uiBytes=len(result.encode())),ensure_ascii=False))

if __name__=='__main__':main()
