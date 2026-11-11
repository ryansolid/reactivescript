import re, random, json
rows={}
for l in open('summary.txt'):
    a,n,h,o,z=re.match(r'(\w+)-(\d) hidden/overlap=(\d+)/77 (\d+)/38\s+fuzz=(\d+)/20',l).groups()
    rows[(a,int(n))]=dict(h=77-int(h),o=38-int(o),z=int(z))
excl={}   # fuzz holes traced to legal holds: (arm,n) -> count
def D(k): r=rows[k]; return r['h']+r['o']+r['z']-excl.get(k,0)
def perm(x,y,seed=11,N=100000):
    random.seed(seed); obs=sum(y)/len(y)-sum(x)/len(x); pool=x+y; c=0
    for _ in range(N):
        random.shuffle(pool); xx=pool[:len(x)]; yy=pool[len(x):]
        if sum(yy)/len(yy)-sum(xx)/len(xx)>=obs-1e-12: c+=1
    return (c+1)/(N+1)
def boot(x,y,seed=11,N=10000):
    random.seed(seed); d=[]
    for _ in range(N):
        xx=[random.choice(x) for _ in x]; yy=[random.choice(y) for _ in y]
        d.append(sum(xx)/len(xx)-sum(yy)/len(yy))
    d.sort(); return d[int(.05*N)], d[int(.95*N)-1]
usd=json.load(open('usd.json'))
small=range(4,10); front=range(1,4); A=('rx','react','vanilla','foldkit')
for a in A:
    for tier,rg in (('frontier',front),('small',small)):
        v=[D((a,n)) for n in rg]; c=sum(1 for x in v if x==0)
        hz=[sum(rows[(a,n)][k] for n in rg)/len(rg) for k in 'hoz']
        cost=[x[0] for x in usd[f'{a}-{tier}']]; m=sum(cost)/len(cost)
        cpc=f"${sum(cost)/c:.3f}" if c else "undefined"
        print(f"  {a:8}{tier:9} mean {sum(v)/len(v):5.2f}  per desk {v}  h/o/z {hz[0]:.1f}/{hz[1]:.1f}/{hz[2]:.1f}  correct {c}  $/run {m:.3f}  $/correct {cpc}")
S={a:[D((a,n)) for n in small] for a in A}
ps={'H11a rx<react':perm(S['rx'],S['react']),'H11b rx<plain':perm(S['rx'],S['vanilla']),'H11b rx<foldkit':perm(S['rx'],S['foldkit'])}
order=sorted(ps.items(),key=lambda kv:kv[1]); m=len(order); prev=0
for i,(k,p) in enumerate(order):
    adjp=max(prev,min(1,(m-i)*p)); prev=adjp; print(f"  {k}: p={p:.5f} Holm {adjp:.5f}")
F={a:[D((a,n)) for n in front] for a in A}
lo,hi=boot(F['rx'],F['react']); print(f"  H11c frontier rx - frontier react: {sum(F['rx'])/3-sum(F['react'])/3:.2f}, 90% CI [{lo:.2f}, {hi:.2f}] -> holds if upper < 1: {hi<1}")
lo,hi=boot(S['rx'],F['react']); print(f"  (H10c again) small rx - frontier react: {sum(S['rx'])/6-sum(F['react'])/3:.2f}, 90% CI [{lo:.2f}, {hi:.2f}] -> upper < 1: {hi<1}")
