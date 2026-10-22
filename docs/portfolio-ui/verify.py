"""Read-only: historical Git blobs and current UI delivery have separate scopes."""
from pathlib import Path
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]
BASE = 'd60fd8dac8a7f9df63d679c4b58d347ecb2b07ed'

def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True).stdout

def validate(data, entry):
    if entry['hash_mode'] == 'utf8-crlf-to-lf':
        data.decode('utf-8')
        data = data.replace(b'\r\n', b'\n')
    assert len(data) == entry['bytes'], entry['path']
    assert hashlib.sha256(data).hexdigest() == entry['sha256'], entry['path']

historical_path = 'docs/phase2d-evidence/manifest.json'
historical_bytes = git('show', f'{BASE}:{historical_path}')
assert (ROOT / historical_path).read_bytes() == historical_bytes, 'Historical manifest changed'
historical = json.loads(historical_bytes)
for entry in historical['files']:
    validate(git('show', f"{BASE}:{entry['path']}"), entry)
print(f"Historical baseline: {len(historical['files'])} hashes PASS at {BASE}")

current_path = 'docs/portfolio-ui/manifest.json'
current = json.loads((ROOT / current_path).read_text(encoding='utf-8'))
for entry in current['files']:
    relative = Path(entry['path'])
    assert not relative.is_absolute() and '..' not in relative.parts, entry['path']
    validate((ROOT / relative).read_bytes(), entry)
expected = {entry['path'] for entry in current['files']} | {current_path}
actual = {p.decode('utf-8') for p in git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0') if p}
assert expected == actual, f"Delivery inventory mismatch: {sorted(expected ^ actual)}"
assert len(current['files']) == len(expected) - 1, 'Duplicate entries'
print(f"Current delivery: {len(current['files'])} hashes PASS; inventory {len(expected)}; manifest excluded from self-hash")
