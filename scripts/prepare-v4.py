#!/usr/bin/env python3
"""Stream the v4 archive into individually compressed, date-indexed packs."""
import argparse, datetime, hashlib, json, os, struct, subprocess, tarfile, tempfile
from pathlib import Path
TOPICS = ('overview', 'personality', 'love', 'career', 'wealth', 'health', 'family', 'children', 'move', 'friends', 'home', 'spirit', 'parents')

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=Path)
parser.add_argument('--output', type=Path, default=Path('data/v4-ready'))
parser.add_argument('--year', type=int, choices=range(1950, 2027), help='prepare one year for testing')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
with tarfile.open(args.archive, 'r:') as archive:
    for year in ([args.year] if args.year else range(1950, 2027)):
        source = archive.extractfile(archive.getmember(f'year-{year}.jsonl.zst'))
        pack_path = args.output / f'{year}.pack'
        index_path = args.output / f'{year}.json'
        pack_tmp = pack_path.with_suffix('.pack.tmp')
        index_tmp = index_path.with_suffix('.json.tmp')
        hash_path = args.output / f'{year}.sha256.json'
        hash_tmp = hash_path.with_suffix('.tmp')
        def digest(file):
            with file.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()
        if pack_path.exists() and index_path.exists() and hash_path.exists():
            saved = json.loads(index_path.read_text())
            expected_days = (datetime.date(year + 1, 1, 1) - datetime.date(year, 1, 1)).days
            end = max((offset + length for offset, length in saved.values()), default=0)
            hashes = json.loads(hash_path.read_text())
            if len(saved) != expected_days or end != pack_path.stat().st_size or hashes != {'pack': digest(pack_path), 'index': digest(index_path)}:
                raise ValueError(f'{year} pack/index inconsistent; remove that year pack, json, and sha256.json then retry')
            print(f'{year}: already prepared, skipping', flush=True)
            continue
        if pack_path.exists() or index_path.exists() or hash_path.exists():
            raise FileExistsError(f'{year} incomplete output; remove that year pack, json, and sha256.json then retry')
        try:
            with tempfile.TemporaryFile() as compressed, pack_tmp.open('wb') as pack:
                while chunk := source.read(1024 * 1024): compressed.write(chunk)
                compressed.seek(0)
                proc = subprocess.Popen(['zstd', '-dc'], stdin=compressed, stdout=subprocess.PIPE)
                compressor = subprocess.Popen(['node', str(Path(__file__).with_name('v4-compress.cjs'))], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
                current, rows, index, total = None, [], {}, 0
                def flush():
                    global total
                    if not rows: return
                    if len(rows) != 24 or len({r['k'] for r in rows}) != 24: raise ValueError(f'incomplete day {current}')
                    raw = json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()
                    compressor.stdin.write(struct.pack('>I', len(raw)) + raw)
                    compressor.stdin.flush()
                    header = compressor.stdout.read(4)
                    if len(header) != 4: raise RuntimeError('compression worker failed')
                    size = struct.unpack('>I', header)[0]
                    data = compressor.stdout.read(size)
                    if len(data) != size: raise RuntimeError('compression worker truncated output')
                    index[current] = [pack.tell(), len(data)]
                    pack.write(data)
                    total += len(rows)
                for line in proc.stdout:
                    row = json.loads(line)
                    date = datetime.date(row['y'], row['m'], row['d'])
                    if date.year != year or type(row['h']) is not int or row['h'] not in range(12) or row['g'] not in ('male', 'female') or row['k'] != f"{date.isoformat()}-{row['h']}-{row['g']}" or any(not isinstance(row['c'].get(k), str) or not row['c'][k] for k in TOPICS): raise ValueError('invalid record')
                    if current != date.isoformat():
                        flush()
                        if date.isoformat() in index: raise ValueError('repeated date')
                        current, rows = date.isoformat(), []
                    rows.append(row)
                flush()
                if proc.wait() != 0: raise RuntimeError('zstd failed')
                compressor.stdin.close()
                if compressor.wait() != 0: raise RuntimeError('compression worker failed')
                expected = (datetime.date(year + 1, 1, 1) - datetime.date(year, 1, 1)).days * 24
                if total != expected: raise ValueError(f'unexpected record count: {total} != {expected}')
            index_tmp.write_text(json.dumps(index, separators=(',', ':')))
            hashes = {'pack': digest(pack_tmp), 'index': digest(index_tmp)}
            hash_tmp.write_text(json.dumps(hashes))
            os.replace(pack_tmp, pack_path)
            os.replace(index_tmp, index_path)
            os.replace(hash_tmp, hash_path)
            print(f'{year}: {total} records, {pack_path.stat().st_size / 1024 / 1024:.1f} MiB', flush=True)
        finally:
            if 'compressor' in locals() and compressor.poll() is None:
                compressor.kill()
                compressor.wait()
            if 'proc' in locals() and proc.poll() is None:
                proc.kill()
                proc.wait()
            pack_tmp.unlink(missing_ok=True)
            index_tmp.unlink(missing_ok=True)
            hash_tmp.unlink(missing_ok=True)
