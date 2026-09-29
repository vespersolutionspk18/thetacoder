import json
from collections import Counter

rows = []
with open('instances.jsonl', encoding='utf-8') as f:
    for line in f:
        rows.append(json.loads(line))

def patch_lines(p):
    if not p:
        return 0
    return sum(1 for ln in p.splitlines() if ln.startswith('+') or ln.startswith('-'))

easy_repos = ['psf/requests', 'pallets/flask', 'pytest-dev/pytest', 'pylint-dev/pylint', 'mwaskom/seaborn']
print(f"{'instance_id':60s}  repo  pl  ps  f2p p2p")
for r in rows:
    if r['repo'] not in easy_repos: continue
    if r['difficulty'] != '<15 min fix': continue
    pl = patch_lines(r['patch'])
    ps_len = len(r['problem_statement'])
    repo_short = r['repo'].split('/')[1]
    print(f"{r['instance_id']:60s}  {repo_short:8s}  {pl:4d}  {ps_len:5d}  {len(json.loads(r['FAIL_TO_PASS'])):2d}  {len(json.loads(r['PASS_TO_PASS'])):3d}")
