import json,sys
for line in sys.stdin:
    line=line.strip()
    if not line.startswith('{'): continue
    d=json.loads(line)
    m=(d.get('meta') or {}).get('meta') or {}
    print('URL  ', d['url'])
    print('STRIP', d.get('stripText') or d.get('message') or d.get('error'))
    print('META ', 'title=',repr(m.get('title'))[:80],'| year=',m.get('year'),'| doi=',m.get('doi'),'| venue=',m.get('venue'),'| refs=',m.get('references'))
    print('DET  ', (d.get('detection') or {}).get('ids'), [t[:50] for t in (d.get('detection') or {}).get('titles',[])])
    print('REFS ', d.get('refsHeader'), d.get('refCount'))
    c=d.get('copies') or {}
    print('APA  ', (c.get('APA') or '')[:230])
    print('BIB  ', (c.get('BibTeX') or '').replace('\n',' ')[:230])
    print('LOG  ', [l for l in d.get('log',[]) if 'ignored' in l or 'PDF' in l][:4])
    print()
