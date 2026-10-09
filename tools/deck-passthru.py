# deck-passthru.py <deck.pptx> <deck-powerpoint.pdf> <slide> [<slide> ...]
#
# Finds connectors that run *through* boxes they are not attached to — the case
# a slide image cannot disambiguate. Matches each connector in the deck XML to
# its drawn outline in the PowerPoint PDF (connectors export as filled outlines)
# and reports, per crossed box: offset of the line from the box's centre line,
# whether it passes fully through, whether it is drawn behind the box, and
# own-links = how many links that box gets from a box of the same kind as the
# connector's source. See TRANSCRIBE.md for how to read the evidence.
# Needs pymupdf. Prints only pass-through crossings with at least one attached end.
import sys, zipfile, math, re
from xml.etree import ElementTree as ET
import pymupdf
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
PPTX, PDF = sys.argv[1], sys.argv[2]
E=12700  # EMU per PDF point
zf=zipfile.ZipFile(PPTX); doc=pymupdf.open(PDF)
def txt(el): return ' '.join((t.text or '').strip() for t in el.iter('{%s}t'%NS['a']) if (t.text or '').strip())

def load(n):
    root=ET.fromstring(zf.read(f"ppt/slides/slide{n}.xml"))
    shapes={}; conns=[]; z=[0]
    def walk(el, tf):
        for ch in el:
            tag=ch.tag.split('}')[1]
            if tag=='grpSp':
                xf=ch.find('p:grpSpPr/a:xfrm',NS)
                o=xf.find('a:off',NS);e=xf.find('a:ext',NS);co=xf.find('a:chOff',NS);ce=xf.find('a:chExt',NS)
                sx=int(e.get('cx'))/max(1,int(ce.get('cx'))); sy=int(e.get('cy'))/max(1,int(ce.get('cy')))
                ox,oy,cx,cy=int(o.get('x')),int(o.get('y')),int(co.get('x')),int(co.get('y'))
                walk(ch, lambda x,y,tf=tf,sx=sx,sy=sy,ox=ox,oy=oy,cx=cx,cy=cy: tf(ox+(x-cx)*sx, oy+(y-cy)*sy))
            elif tag in ('sp','cxnSp'):
                z[0]+=1
                xf=ch.find('.//a:xfrm',NS)
                if xf is None: continue
                o=xf.find('a:off',NS);e=xf.find('a:ext',NS)
                x,y,w,h=int(o.get('x')),int(o.get('y')),int(e.get('cx')),int(e.get('cy'))
                x0,y0=tf(x,y);x1,y1=tf(x+w,y+h)
                r=(x0/E,y0/E,x1/E,y1/E)
                cid=ch.find('./*/p:cNvPr',NS).get('id')
                if tag=='sp':
                    t=txt(ch)
                    sp=ch.find('p:spPr',NS)
                    filled = sp is not None and (sp.find('a:solidFill',NS) is not None or sp.find('a:gradFill',NS) is not None) \
                        or (ch.find('p:style/a:fillRef',NS) is not None and ch.find('p:style/a:fillRef',NS).get('idx') not in ('0',None) and (sp is None or sp.find('a:noFill',NS) is None))
                    if t and filled and (r[2]-r[0])<300: shapes[cid]=dict(text=t[:50],rect=r,z=z[0])
                else:
                    st=ch.find('.//a:stCxn',NS); en=ch.find('.//a:endCxn',NS)
                    ln=ch.find('.//p:spPr/a:ln',NS); heads=[]
                    col=None
                    if ln is not None:
                        cc=ln.find('.//a:srgbClr',NS); cc=cc if cc is not None else ln.find('.//a:schemeClr',NS)
                        col=cc.get('val') if cc is not None else None
                    if col is None:
                        cc=ch.find('p:style/a:lnRef//a:schemeClr',NS); col=cc.get('val') if cc is not None else None
                    if ln is not None:
                        for k in ('headEnd','tailEnd'):
                            t=ln.find('a:'+k,NS)
                            if t is not None and t.get('type') not in (None,'none'): heads.append(k)
                    conns.append(dict(id=cid,st=st.get('id') if st is not None else None,en=en.get('id') if en is not None else None,rect=r,z=z[0],heads=heads,col=col))
    walk(root.find('.//p:spTree',NS), lambda x,y:(x,y))
    return shapes, conns

def segs_of(drawing):
    out=[]
    for it in drawing['items']:
        if it[0]=='l': out.append((it[1],it[2]))
        elif it[0]=='c': out.append((it[1],it[4]))
    return out

def crosses(seg, r, m=2.0):
    (a,b)=seg; x0,y0,x1,y1=r[0]+m,r[1]+m,r[2]-m,r[3]-m
    # Liang-Barsky clip
    dx,dy=b.x-a.x,b.y-a.y; t0,t1=0.0,1.0
    for p,q in ((-dx,a.x-x0),(dx,x1-a.x),(-dy,a.y-y0),(dy,y1-a.y)):
        if abs(p)<1e-9:
            if q<0: return None
        else:
            t=q/p
            if p<0: t0=max(t0,t)
            else: t1=min(t1,t)
    if t0>t1: return None
    return (t0,t1)

def s_id_in(o,sid): return sid in (o['st'],o['en'])

def analyse(n):
    shapes,conns=load(n)
    page=doc[n-1]; drs=[d for d in page.get_drawings() if not (len(d['items'])==1 and d['items'][0][0]=='re')]
    res=[]
    for c in conns:
        cr=c['rect']; bx=(min(cr[0],cr[2]),min(cr[1],cr[3]),max(cr[0],cr[2]),max(cr[1],cr[3]))
        best=None
        for d in drs:
            R=d['rect']; err=abs(R.x0-bx[0])+abs(R.y0-bx[1])+abs(R.x1-bx[2])+abs(R.y1-bx[3])
            if best is None or err<best[0]: best=(err,d)
        if not best or best[0]>12: continue
        d=best[1]; segs=segs_of(d)
        for sid,s in shapes.items():
            if sid in (c['st'],c['en']): continue
            hit=[(i,crosses(sg,s['rect'])) for i,sg in enumerate(segs)]
            hit=[(i,h) for i,h in hit if h]
            if not hit: continue
            r=s['rect']; w,h=r[2]-r[0],r[3]-r[1]
            hs=[segs[i] for i,_ in hit]
            horiz=sum(abs(a.x-b.x) for a,b in hs) > sum(abs(a.y-b.y) for a,b in hs)
            if horiz: off=(sum((a.y+b.y)/2 for a,b in hs)/len(hs)-(r[1]+r[3])/2)/h
            else: off=(sum((a.x+b.x)/2 for a,b in hs)/len(hs)-(r[0]+r[2])/2)/w
            # through = the outline extends beyond the box on both sides along the crossing axis
            pts=[q for sg in segs for q in sg]
            if horiz: through = min(q.x for q in pts) < r[0]-1 and max(q.x for q in pts) > r[2]+1
            else: through = min(q.y for q in pts) < r[1]-1 and max(q.y for q in pts) > r[3]+1
            # does the crossed box get a link from a box of the same kind as the source?
            kind=' '.join(shapes.get(c['st'],{}).get('text','').split()[:3])
            def other_end(o): return o['en'] if o['st']==sid else o['st']
            other=[o for o in conns if o is not c and s_id_in(o,sid) and kind and
                   ' '.join(shapes.get(other_end(o),{}).get('text','').split()[:3])==kind]
            res.append(dict(other=len(other),conn=c['id'],src=shapes.get(c['st'],{}).get('text','?'),dst=shapes.get(c['en'],{}).get('text','?'),
                            box=s['text'],offset=round(off,2),through=through,behind=c['z']<s['z'],dashed=len(d['items'])>40))
    return res

if __name__=='__main__':
    for n in map(int,sys.argv[3:]):
        for r in analyse(n):
            if not r['through'] or (r['src']=='?' and r['dst']=='?'): continue
            print(f"s{n} c{r['conn']}: {r['src'][:28]!r} -> {r['dst'][:28]!r} crosses {r['box'][:30]!r} off={r['offset']:+.2f} {'through' if r['through'] else 'ends-in'} {'behind' if r['behind'] else 'OVER'}{' dashed' if r['dashed'] else ''} own-links={r['other']}")
