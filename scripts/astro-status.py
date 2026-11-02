"""Read sanitized local relay status without printing its pairing secret or transcript."""
from pathlib import Path
import json
import argparse
import urllib.request

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--last', type=int, default=40, help='Number of recent diagnostic entries')
args = parser.parse_args()
token = (root / '.local/astro-plugin-token').read_text().strip()
request = urllib.request.Request('http://127.0.0.1:32179/status', headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(request, timeout=3) as response:
    status = json.load(response)
    status['diagnostics'] = status.get('diagnostics', [])[-max(0, args.last):] if args.last > 0 else []
    print(json.dumps(status, ensure_ascii=False, indent=2))
