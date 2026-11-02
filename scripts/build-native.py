"""Build source-only native candidates locally; no upload or module loading."""
import argparse
import json
from pathlib import Path
from native_rel_build import build

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('profile', choices=['audio', 'shell', 'link'])
parser.add_argument('--output', type=Path, required=True, help='Fresh output directory inside this checkout')
args = parser.parse_args()
out = args.output.resolve()
if not out.is_relative_to(root):
    parser.error('Output must stay inside the checkout')
directory = root / 'phone-research/native-audio'
if args.profile == 'link':
    names = ['private-link-service-043.c', 'private-link-wire.c', 'private-link-wire.h',
             'private-spp-043.h', 'event-wire.h', 'management-043.c', 'management-043.h',
             'shell-wire.c', 'shell-wire.h', 'rel-module-043.ld']
else:
    names = [args.profile + '-service-043.c',
             'shell-wire.c' if args.profile == 'shell' else 'event-wire.c',
             'shell-wire.h' if args.profile == 'shell' else 'event-wire.h', 'rel-module-043.ld']
if args.profile == 'shell':
    names.append('event-wire.h')
aliases, objects = None, None
if args.profile != 'link':
    aliases = {args.profile + '-service-043.c': 'event-service-043.c',
               ('shell-wire.c' if args.profile == 'shell' else 'event-wire.c'): 'event-wire.c'}
    objects = {'event-service-043.c': 'service.o', 'event-wire.c': 'wire.o'}
manifest = build(root, out, args.profile, [directory / name for name in names], 100000, aliases, objects)
manifest.update(firmware='3.101.043', profile=args.profile, deploymentAttempted=False)
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({k: manifest[k] for k in ['artifact', 'bytes', 'sha256', 'deviceTested']}))
