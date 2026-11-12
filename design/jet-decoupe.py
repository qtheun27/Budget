import numpy as np
from PIL import Image, ImageDraw, ImageFilter
SRC='/tmp/claude-0/-home-user-budget/83ad18b3-79aa-508a-8ca8-42c0d62ae3b2/images/19.jpg'
OUT='/home/user/budget/assets/jet/'
im=Image.open(SRC).convert('RGB'); a=np.asarray(im).astype(np.int16)
lum=a.mean(2); sat=a.max(2)-a.min(2); H,W=lum.shape
def flood(mask, seeds):
    m=Image.fromarray((mask*255).astype(np.uint8)).copy()
    for s in seeds:
        if m.getpixel(s)==255: ImageDraw.floodfill(m,s,128)
    return np.asarray(m)==128
seeds=[(0,0),(W-1,0),(0,H-1),(W-1,H-1),(W//2,0),(W//2,H-1),(0,H//2),(W-1,H//2)]
bg=flood((lum>=247)&(sat<=10), seeds)          # fond pur (la feuille du dossier est ~239 : protégée)
boxes={'bravo':(60,80,680,720),'reflechit':(900,80,1380,720),'alerte':(520,700,1010,1310),'fete':(100,1190,700,1960),'arrive':(800,1315,1400,1940)}
for n,(x0,y0,x1,y1) in boxes.items():
    sub_bg=bg[y0:y1,x0:x1].copy(); L=lum[y0:y1,x0:x1]; S=sat[y0:y1,x0:x1]
    if n=='fete': sub_bg[0:125, 520:]=True     # pieds du personnage voisin
    fg=~sub_bg; ys,xs=np.where(fg); bottom=ys.max(); top=ys.min()
    # ombres au sol : gris clair sous les pieds, reliés au fond
    zone=np.zeros_like(fg); zone[int(bottom-(bottom-top)*0.16):,:]=True
    shadow=zone & (S<=20) & (L>=110)
    sh=flood(shadow|sub_bg, [(0,sub_bg.shape[0]-1),(sub_bg.shape[1]-1,sub_bg.shape[0]-1)])
    alpha=np.where(sub_bg|sh,0,255).astype(np.uint8)
    # retirer les petits fragments isolés (bouts d'ombre, morceaux des voisins)
    lab=Image.fromarray(alpha).copy(); k=1
    ys2,xs2=np.where(alpha[::6,::6]==255)
    for yy2,xx2 in zip(ys2*6,xs2*6):
        if lab.getpixel((int(xx2),int(yy2)))==255 and k<250:
            ImageDraw.floodfill(lab,(int(xx2),int(yy2)),k); 
            arr=np.asarray(lab)
            if (arr==k).sum()<2500: alpha[arr==k]=0
            k+=1
    A=Image.fromarray(alpha).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    c=im.crop((x0,y0,x1,y1)).convert('RGBA'); c.putalpha(A)
    al=np.asarray(c)[:,:,3]; yy,xx=np.where(al>30)
    pad=10; c=c.crop((max(0,xx.min()-pad),max(0,yy.min()-pad),min(c.width,xx.max()+pad),min(c.height,yy.max()+pad)))
    s=max(c.width,c.height); sq=Image.new('RGBA',(s,s),(0,0,0,0)); sq.paste(c,((s-c.width)//2,s-c.height))
    sq.resize((512,512),Image.LANCZOS).save(OUT+n+'.png',optimize=True); print(n,c.size)
names=['arrive','bravo','reflechit','alerte','fete']
sheet=Image.new('RGBA',(5*260,2*260),(0,0,0,255))
for i,n in enumerate(names):
    j=Image.open(OUT+n+'.png').resize((250,250))
    for k,col in enumerate([(242,242,247,255),(28,28,30,255)]):
        t=Image.new('RGBA',(260,260),col); t.alpha_composite(j,(5,5)); sheet.paste(t,(i*260,k*260))
sheet.save('/tmp/claude-0/-home-user-budget/83ad18b3-79aa-508a-8ca8-42c0d62ae3b2/scratchpad/jet-check.png')
