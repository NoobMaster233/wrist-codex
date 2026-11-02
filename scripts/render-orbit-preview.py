"""Render the ORBIT design sheet from vector shapes; illustrative, not screenshots."""
from pathlib import Path
from html import escape
import subprocess

root=Path(__file__).resolve().parents[1]
out=root/'artifacts/design/orbit';out.mkdir(parents=True,exist_ok=True)
ink='#080b10';white='#f4f1e9';muted='#929db0';violet='#c8cffb';lime='#d3efa2';card='#151b24'
def text(s,x,y,size=20,color=white,weight='normal'):
 return f'<text x="{x}" y="{y}" fill="{color}" font-size="{size}" font-weight="{weight}">{escape(s)}</text>'
def box(x,y,w,h,fill=card,r=20):return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"/>'
def header(title,home=False):
 s=box(0,0,336,480,ink,32)
 if home:
  s+=box(18,26,32,32,'#111620',10)+text('‹/›',22,48,17,violet,'bold')+text('CODEX',60,51,23,white,'bold')+box(266,24,52,42,'#171c26',18)+text('工具',274,51,17,violet)
 else:s+=box(18,24,38,42,'#10151e',18)+text('‹',29,54,30,violet)+text(title,65,51,23,white,'bold')
 s+='<circle cx="23" cy="82" r="3" fill="'+lime+'"/>'+text('手机通道已连接',33,87,15,muted)+text('10:28',267,87,17,violet)
 return s
screens=[]
s=header('',True)+text('10月28日  /  ON YOUR WRIST',22,121,13,'#aab3e4')+text('想法，',22,168,32,white,'bold')+text('从这里继续。',22,209,32,white,'bold')+text('把想法，向前一步。',22,244,16,muted)
s+=box(18,264,300,90,violet,24)+text('WORKSPACE',38,289,13,'#707fa4')+text('我的项目',38,329,28,'#13192b','bold')+text('↗',265,325,40,'#293555')
s+=box(18,366,300,76)+text('接着聊',49,389,13,'#94a1b6')+text('一起做点新东西',49,420,20,white,'bold')+'<circle cx="34" cy="402" r="4" fill="'+lime+'"/>'+text('›',293,413,27,violet)
screens.append(('home',s))
s=header('我的项目')+text('WORKSPACES',18,124,14,'#aab3e4')+text('2',298,125,21,violet)+text('选一个项目，接着往下做。',18,161,17,muted)
for i,(name,label) in enumerate([('腕上 Codex','打开工作区'),('我的工作台','打开工作区')]):
 y=185+i*100;s+=box(18,y,300,88)+box(34,y+20,38,46,'#222c40',12)+text('/',47,y+52,26,violet)+text(name,84,y+38,22,white,'bold')+text(label,84,y+67,15,muted)+text('›',293,y+52,28,violet)
s+=box(18,393,300,56,'#111721',20)+text('重新读取',128,428,18,muted);screens.append(('projects',s))
s=header('新的想法')+box(18,110,300,104,'#1e2923')+text('•  你',33,135,14,violet)+text('做一个真正属于手腕的',32,172,22)+text('Codex，怎么样？',32,202,22)
s+=box(18,226,300,160)+text('•  CODEX',33,252,14,violet)+text('把复杂的事，',32,290,22)+text('想清楚，再动手。',32,323,22)+text('我们从一个好想法开始。',32,356,22)
s+=text('保持连接，回复会自己来。',68,412,15,'#7c899e')+box(18,424,90,56,'#202837')+text('更新',43,459,21,'#d0d7ef')+box(117,424,201,56,lime)+text('说一句',183,459,21,'#17211c','bold');screens.append(('conversation',s))
s=header('说一句')+text('LISTENING',18,123,14,'#aab3e4')+text('一起做点新东西',18,160,17,muted)
for x,h in zip(range(110,229,17),[14,28,48,66,48,28,14]):s+=box(x,230-h/2,7,h,lime,4)
s+=text('我在听。',18,315,29,white,'bold')+text('说完之后，文字会先交给你核对。',18,354,17,muted)+box(18,380,300,64,lime)+text('说完了，转成文字',74,419,23,'#17211c','bold')
screens.append(('voice',s))
s=header('控制中心')+text('CONTROL ROOM',18,124,14,'#aab3e4')+text('一切，尽在腕上。',18,170,29,white,'bold')
s+=box(18,194,300,136)+text('手机连接',34,230,22,white,'bold')+text('手机通道已连接',34,265,18,muted)+box(34,278,268,38,'#252e40',14)+text('检测连接',131,303,18,violet)
s+=box(18,344,300,88)+text('›_',36,394,26,violet)+text('手环终端',87,379,22,white,'bold')+text('系统 · 存储 · 文件',87,410,15,muted)+text('›',293,398,28,violet)
screens.append(('tools',s))
font='font-family="Noto Sans CJK SC, sans-serif"'
for name,body in screens:
 svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="336" height="480" viewBox="0 0 336 480"><g {font}>{body}</g></svg>'
 p=out/(name+'.svg');p.write_text(svg);subprocess.run(['rsvg-convert','-o',str(p.with_suffix('.png')),str(p)],check=True)
body=box(0,0,1832,580,'#10131c',0)+text('CODEX  /  ORBIT 01',30,36,19,violet)
for i,(name,s) in enumerate(screens):body+=f'<g transform="translate({28+i*362},56)">{s}</g>'
body+=text('设计预览 · 示例内容，非真机截图',30,566,15,muted)
p=out/'orbit-design-sheet.svg';p.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="1832" height="580" viewBox="0 0 1832 580"><g {font}>{body}</g></svg>');subprocess.run(['rsvg-convert','-o',str(p.with_suffix('.png')),str(p)],check=True)
print(str(p.with_suffix('.png').relative_to(root)))
