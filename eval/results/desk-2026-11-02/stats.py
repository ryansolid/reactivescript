import re, random, json
rows={}
for l in open('summary.txt'):
    a,n,h,o,z=re.match(r'(\w+)-(\d) hidden/overlap=(\d+)/77 (\d+)/38\s+fuzz=(\d+)/20',l).groups()
    rows[(a,int(n))]=dict(h=77-int(h),o=38-int(o),z=int(z))
legal={('rx',n):1 for n in (1,3,5,8,9)}           # L1: H-11 hold, replay-verified
amb=set()                                           # rename-reload test failing only because retry shows only on error
for l in open('full/ov.tsv'):
    d,t,e=l.rstrip('\n').split('\t')
    if 'a detail that loads while a rename is out' in t and 'Timeout' in e:
        a,n=d.replace('desk10-','').split('-'); amb.add((a,int(n)))
def D(k,adj=False):
    r=rows[k]; return r['h']+r['o']+r['z']-legal.get(k,0)-(1 if adj and k in amb else 0)
def perm(x,y,seed=10,N=100000):
    random.seed(seed); obs=sum(y)/len(y)-sum(x)/len(x); pool=x+y; c=0
    for _ in range(N):
        random.shuffle(pool); xx=pool[:len(x)]; yy=pool[len(x):]
        if sum(yy)/len(yy)-sum(xx)/len(xx)>=obs-1e-12: c+=1
    return (c+1)/(N+1)
def boot(x,y,seed=10,N=10000):
    random.seed(seed); d=[]
    for _ in range(N):
        xx=[random.choice(x) for _ in x]; yy=[random.choice(y) for _ in y]
        d.append(sum(xx)/len(xx)-sum(yy)/len(yy))
    d.sort(); return d[int(.05*N)], d[int(.95*N)-1]
small=range(4,10); front=range(1,4)
for adj in (False,True):
    print("=== adjusted for retry-visibility ambiguity" if adj else "=== as pre-registered")
    for a in ('rx','react','vanilla','foldkit'):
        for tier,rg in (('frontier',front),('small',small)):
            v=[D((a,n),adj) for n in rg]; c=sum(1 for x in v if x==0)
            print(f"  {a:8}{tier:9} mean {sum(v)/len(v):5.2f}  per desk {v}  correct {c}")
    S={a:[D((a,n),adj) for n in small] for a in ('rx','react','vanilla','foldkit')}
    ps={'H10a rx<react':perm(S['rx'],S['react']),'H10b rx<plain':perm(S['rx'],S['vanilla']),'H10b rx<foldkit':perm(S['rx'],S['foldkit'])}
    order=sorted(ps.items(),key=lambda kv:kv[1]); m=len(order); prev=0
    for i,(k,p) in enumerate(order):
        adjp=max(prev,min(1,(m-i)*p)); prev=adjp; print(f"  {k}: p={p:.5f} Holm {adjp:.5f}")
    fr=[D(('react',n),adj) for n in front]; lo,hi=boot(S['rx'],fr)
    print(f"  H10c small rx - frontier react: {sum(S['rx'])/6-sum(fr)/3:.2f}, 90% CI [{lo:.2f}, {hi:.2f}] -> holds if upper < 1: {hi<1}")
