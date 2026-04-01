#!/usr/bin/env python3
"""
generate_test_data.py — Generate realistic test datasets for RedMan.

Creates a diverse filesystem with photos, videos, documents, databases,
code files, and edge cases for testing SSD Backup, Hyper Backup,
and Media Import features.

Usage:
    python generate_test_data.py --size small      # ~2 GB
    python generate_test_data.py --size medium     # ~5 GB
    python generate_test_data.py --size large      # ~10 GB
    python generate_test_data.py --evolve 1        # Apply evolution 1
    python generate_test_data.py --evolve 2        # Apply evolution 2
    python generate_test_data.py --evolve 3        # Apply evolution 3
    python generate_test_data.py --size small --force  # Regenerate

Requires: pip install -r requirements.txt  (Pillow, piexif)
"""

import argparse
import json
import os
import random
import shutil
import sqlite3
import struct
import sys
import time
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("❌ Missing Pillow — install with: pip install -r requirements.txt")

try:
    import piexif
except ImportError:
    piexif = None
    print("⚠ piexif not installed — EXIF will be skipped. pip install -r requirements.txt")

# Handle Pillow version differences
try:
    BILINEAR = Image.Resampling.BILINEAR
except AttributeError:
    BILINEAR = Image.BILINEAR

# ── Configuration ──────────────────────────────────────────────────────

SEED = 42
BASE_DIR = Path(__file__).parent / "data" / "source"

CAMERAS = [
    {"make": "Canon",     "model": "Canon EOS R5",         "dcim": "100CANON", "raw": ".cr2"},
    {"make": "Canon",     "model": "Canon EOS 5D Mark IV", "dcim": "100EOS5D", "raw": ".cr3"},
    {"make": "Nikon",     "model": "Nikon Z6 II",          "dcim": "100NIKON", "raw": ".nef"},
    {"make": "Sony",      "model": "Sony A7 IV",           "dcim": "100MSDCF", "raw": ".arw"},
    {"make": "Apple",     "model": "iPhone 14 Pro",        "dcim": "100APPLE", "raw": None},
    {"make": "Samsung",   "model": "Samsung Galaxy S23",   "dcim": None,       "raw": None},
    {"make": "Google",    "model": "Google Pixel 8",       "dcim": None,       "raw": None},
    {"make": "Fujifilm",  "model": "Fujifilm X-T5",        "dcim": None,       "raw": ".raf"},
    {"make": "GoPro",     "model": "GoPro HERO12",         "dcim": "100GOPRO", "raw": None},
    {"make": "Panasonic", "model": "Panasonic GH6",        "dcim": "100_PANA", "raw": ".rw2"},
    {"make": "DJI",       "model": "DJI Mavic 3",          "dcim": "100MEDIA", "raw": None},
]

RESOLUTIONS = [
    (4032, 3024),  # iPhone 12+
    (3840, 2160),  # 4K landscape
    (3024, 4032),  # iPhone portrait
    (6000, 4000),  # Sony A7
    (5472, 3648),  # Canon EOS R5
    (2048, 1536),  # compact camera
    (1920, 1080),  # Full HD
    (4000, 3000),  # standard DSLR
]

PROFILES = {
    "small": {
        "target_gb": 2,
        "photos": 100,
        "videos": 3,
        "documents": 100,
        "databases": 3,
        "code_files": 30,
        "edge_cases": 10,
    },
    "medium": {
        "target_gb": 5,
        "photos": 250,
        "videos": 8,
        "documents": 250,
        "databases": 8,
        "code_files": 75,
        "edge_cases": 20,
    },
    "large": {
        "target_gb": 10,
        "photos": 500,
        "videos": 15,
        "documents": 500,
        "databases": 15,
        "code_files": 150,
        "edge_cases": 30,
    },
}

LOREM = (
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor "
    "incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud "
    "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure "
    "dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. "
    "Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt "
    "mollit anim id est laborum. Curabitur pretium tincidunt lacus. Nulla gravida orci a "
    "odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus "
    "magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida. Duis ac "
    "tellus et risus vulputate vehicula. Donec lobortis risus a elit. Etiam tempor. Ut "
    "ullamcorper, ligula ut dictum pharetra, nisi nunc fringilla magna, in commodo elit "
    "erat nec turpis. Ut pharetra auctor nisi. Nam eget dui. Etiam rhoncus maecenas "
    "tempus. Praesent blandit laoreet nibh. Fusce convallis metus id felis luctus adipiscing."
)


# ── Helpers ────────────────────────────────────────────────────────────

def write_file(path, data):
    """Write bytes or string to file, creating dirs as needed."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = 'wb' if isinstance(data, (bytes, bytearray)) else 'w'
    with open(path, mode) as f:
        f.write(data)


def format_size(n):
    """Format byte count as human-readable string."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def dir_size(path):
    """Calculate total size of directory."""
    total = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                fp = os.path.join(root, f)
                if not os.path.islink(fp):
                    total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def lorem_text(rng, paragraphs=5):
    """Generate lorem ipsum text."""
    words = LOREM.split()
    result = []
    for _ in range(paragraphs):
        length = rng.randint(30, 80)
        start = rng.randint(0, max(0, len(words) - length))
        result.append(' '.join(words[start:start + length]))
    return '\n\n'.join(result)


# ── Photo generation ──────────────────────────────────────────────────

def make_photo(width, height, quality=92):
    """Generate a test photo using upscaled random pixels. Returns JPEG bytes."""
    sw = max(4, width // 32)
    sh = max(4, height // 32)
    raw = os.urandom(sw * sh * 3)
    small = Image.frombytes('RGB', (sw, sh), raw)
    img = small.resize((width, height), BILINEAR)
    buf = BytesIO()
    img.save(buf, format='JPEG', quality=quality)
    return buf.getvalue()


def make_photo_with_exif(width, height, dt, camera, quality=92):
    """Generate a photo with EXIF metadata in a single pass."""
    sw = max(4, width // 32)
    sh = max(4, height // 32)
    raw = os.urandom(sw * sh * 3)
    small = Image.frombytes('RGB', (sw, sh), raw)
    img = small.resize((width, height), BILINEAR)

    buf = BytesIO()
    if piexif:
        exif_dict = {
            "0th": {
                piexif.ImageIFD.Make: camera["make"].encode(),
                piexif.ImageIFD.Model: camera["model"].encode(),
                piexif.ImageIFD.Software: b"RedMan TestGen",
            },
            "Exif": {
                piexif.ExifIFD.DateTimeOriginal: dt.strftime("%Y:%m:%d %H:%M:%S").encode(),
                piexif.ExifIFD.DateTimeDigitized: dt.strftime("%Y:%m:%d %H:%M:%S").encode(),
            },
        }
        img.save(buf, format='JPEG', quality=quality, exif=piexif.dump(exif_dict))
    else:
        img.save(buf, format='JPEG', quality=quality)

    return buf.getvalue()


# ── Video generation ──────────────────────────────────────────────────

def write_video(path, size_bytes):
    """Write a fake MP4 video file of specified size."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # ftyp box (32 bytes) — makes it look like a valid MP4
    ftyp = b'\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41'
    # mdat box header (8 bytes)
    mdat_data_size = max(0, size_bytes - len(ftyp) - 8)
    mdat_header = struct.pack('>I', mdat_data_size + 8) + b'mdat'

    with open(path, 'wb') as f:
        f.write(ftyp)
        f.write(mdat_header)
        remaining = mdat_data_size
        chunk_size = 1024 * 1024  # 1 MB
        while remaining > 0:
            n = min(chunk_size, remaining)
            f.write(os.urandom(n))
            remaining -= n


# ── Document generation ───────────────────────────────────────────────

def make_json_doc(rng):
    return json.dumps({
        "name": f"Project {rng.randint(1, 100)}",
        "version": f"{rng.randint(1, 5)}.{rng.randint(0, 20)}.{rng.randint(0, 99)}",
        "description": ' '.join(LOREM.split()[:rng.randint(5, 20)]),
        "settings": {
            "debug": rng.choice([True, False]),
            "max_retries": rng.randint(1, 10),
            "timeout_ms": rng.randint(1000, 30000),
            "features": rng.sample(
                ["auth", "cache", "logging", "metrics", "notifications", "search"],
                rng.randint(1, 5)
            ),
        },
        "created_at": datetime(2023, rng.randint(1, 12), rng.randint(1, 28)).isoformat(),
    }, indent=2)


def make_csv_doc(rng, rows=100):
    headers = ["id", "name", "email", "department", "salary", "start_date"]
    departments = ["Engineering", "Marketing", "Sales", "HR", "Finance", "Operations"]
    lines = [','.join(headers)]
    for i in range(rows):
        lines.append(','.join([
            str(i + 1),
            f"Employee {i + 1}",
            f"emp{i + 1}@company.com",
            rng.choice(departments),
            str(rng.randint(40000, 150000)),
            f"20{rng.randint(15, 24)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}",
        ]))
    return '\n'.join(lines)


def make_xml_doc(rng):
    items = []
    for i in range(rng.randint(5, 20)):
        items.append(f'  <item id="{i + 1}" status="{rng.choice(["active", "archived", "draft"])}">')
        items.append(f'    <title>Item {i + 1}</title>')
        items.append(f'    <description>{" ".join(LOREM.split()[:rng.randint(5, 15)])}</description>')
        items.append(f'  </item>')
    return '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n' + '\n'.join(items) + '\n</root>\n'


def make_html_doc(rng):
    title = f"Report {rng.randint(1, 100)}"
    paragraphs = '\n'.join(f'<p>{lorem_text(rng, 1)}</p>' for _ in range(rng.randint(3, 8)))
    return (
        f'<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="UTF-8">'
        f'<title>{title}</title></head>\n<body>\n<h1>{title}</h1>\n{paragraphs}\n</body></html>\n'
    )


def make_md_doc(rng):
    title = f"Meeting Notes — {rng.randint(1, 30):02d}/{rng.randint(1, 12):02d}/20{rng.randint(22, 25)}"
    headings = ["Agenda", "Discussion", "Action Items", "Decisions", "Next Steps"]
    sections = []
    for heading in rng.sample(headings, rng.randint(2, 5)):
        sections.append(f"## {heading}\n\n{lorem_text(rng, 2)}")
    return f"# {title}\n\n" + '\n\n'.join(sections) + '\n'


# ── Database generation ───────────────────────────────────────────────

def make_database(path, seed_val):
    """Create a SQLite database with random tables and data."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()

    rng = random.Random(seed_val)
    conn = sqlite3.connect(str(path))
    cur = conn.cursor()

    # Users
    cur.execute(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, created_at TEXT)'
    )
    roles = ['admin', 'user', 'editor', 'viewer']
    for i in range(rng.randint(200, 2000)):
        cur.execute(
            'INSERT INTO users VALUES (?, ?, ?, ?, ?)',
            (i, f'User {i}', f'user{i}@example.com', rng.choice(roles),
             f'20{rng.randint(20, 25)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}')
        )

    # Products
    cur.execute(
        'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL, stock INTEGER)'
    )
    categories = ['Electronics', 'Books', 'Clothing', 'Food', 'Tools', 'Toys']
    for i in range(rng.randint(100, 1000)):
        cur.execute(
            'INSERT INTO products VALUES (?, ?, ?, ?, ?)',
            (i, f'Product {i}', rng.choice(categories),
             round(rng.uniform(0.99, 999.99), 2), rng.randint(0, 5000))
        )

    # Logs
    cur.execute('CREATE TABLE logs (id INTEGER PRIMARY KEY, level TEXT, message TEXT, ts TEXT)')
    levels = ['DEBUG', 'INFO', 'WARN', 'ERROR']
    for i in range(rng.randint(500, 5000)):
        cur.execute(
            'INSERT INTO logs VALUES (?, ?, ?, ?)',
            (i, rng.choice(levels),
             f'Log {i}: {" ".join(LOREM.split()[:rng.randint(3, 12)])}',
             f'20{rng.randint(23, 25)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}'
             f'T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}')
        )

    # Metrics
    cur.execute('CREATE TABLE metrics (id INTEGER PRIMARY KEY, key TEXT, value REAL, recorded_at TEXT)')
    keys = ['cpu_usage', 'memory_mb', 'disk_io', 'network_bytes', 'request_count', 'error_rate']
    for i in range(rng.randint(1000, 10000)):
        cur.execute(
            'INSERT INTO metrics VALUES (?, ?, ?, ?)',
            (i, rng.choice(keys), round(rng.uniform(0, 100), 3),
             f'20{rng.randint(23, 25)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}')
        )

    conn.commit()
    conn.close()


# ── Code/config file generation ───────────────────────────────────────

CODE_TEMPLATES = {
    '.py': '''#!/usr/bin/env python3
"""Module {name} — auto-generated test file."""

import os
import json
from datetime import datetime

CONFIG = {{
    "name": "{name}",
    "version": "{version}",
    "debug": {debug},
}}

def process(data):
    results = []
    for item in data:
        if item.get("status") == "active":
            results.append({{"id": item["id"], "at": datetime.now().isoformat()}})
    return results

if __name__ == "__main__":
    print(f"Running {{CONFIG['name']}} v{{CONFIG['version']}}")
''',

    '.js': '''// {name}.js — auto-generated test file
const config = {{
  name: '{name}',
  version: '{version}',
  debug: {debug_js},
}};

function processItems(items) {{
  return items
    .filter(item => item.status === 'active')
    .map(item => ({{ id: item.id, processedAt: new Date().toISOString() }}));
}}

module.exports = {{ processItems, config }};
''',

    '.sh': '''#!/usr/bin/env bash
# {name}.sh — auto-generated test script
set -euo pipefail
echo "Running {name} v{version}"
LOG_DIR="${{LOG_DIR:-/tmp/{name}}}"
mkdir -p "$LOG_DIR"
for file in "$@"; do
    echo "Processing: $file"
    cp "$file" "$LOG_DIR/"
done
echo "Done. Processed $# files."
''',

    '.yml': '''# {name} configuration
name: {name}
version: "{version}"
server:
  host: 0.0.0.0
  port: {port}
  workers: {workers}
database:
  url: sqlite:///data/{name}.db
  pool_size: 5
logging:
  level: info
  format: json
''',

    '.toml': '''# {name} configuration
[package]
name = "{name}"
version = "{version}"

[server]
host = "0.0.0.0"
port = {port}

[database]
url = "sqlite:///data/{name}.db"

[features]
debug = {debug_toml}
cache = true
metrics = true
''',

    '.env': '''# {name} environment
APP_NAME={name}
APP_VERSION={version}
APP_DEBUG={debug_env}
DATABASE_URL=sqlite:///data/{name}.db
PORT={port}
LOG_LEVEL=info
SECRET_KEY=test-secret-{name}-{version}
''',
}


def make_code_file(file_type, seed_val):
    rng = random.Random(seed_val)
    name = f"module_{seed_val % 10000}"
    version = f"{rng.randint(1, 5)}.{rng.randint(0, 20)}.{rng.randint(0, 99)}"
    debug = rng.choice([True, False])
    return CODE_TEMPLATES.get(file_type, CODE_TEMPLATES['.py']).format(
        name=name,
        version=version,
        debug=debug,
        debug_js=str(debug).lower(),
        debug_yml=str(debug).lower(),
        debug_toml=str(debug).lower(),
        debug_env=str(debug).upper(),
        port=rng.randint(3000, 9999),
        workers=rng.randint(1, 8),
    )


# ── Structure generators ──────────────────────────────────────────────
# Each returns total bytes written so we can calculate remaining space for videos.

def gen_camera_dcim(base, count, rng):
    """Generate DCIM camera folder structure with photos + optional RAW files."""
    dcim_base = base / "DCIM"
    total_bytes = 0

    dcim_cameras = [c for c in CAMERAS if c.get("dcim")]
    cameras_to_use = rng.sample(dcim_cameras, min(4, len(dcim_cameras)))
    photos_per_cam = count // len(cameras_to_use)
    remainder = count % len(cameras_to_use)

    for ci, camera in enumerate(cameras_to_use):
        folder = dcim_base / camera["dcim"]
        n = photos_per_cam + (1 if ci < remainder else 0)

        for i in range(n):
            w, h = rng.choice(RESOLUTIONS)
            dt = datetime(2023, 1, 1) + timedelta(
                days=rng.randint(0, 730),
                hours=rng.randint(0, 23),
                minutes=rng.randint(0, 59),
            )
            data = make_photo_with_exif(w, h, dt, camera, quality=rng.randint(88, 95))
            name = f"IMG_{rng.randint(1000, 9999)}.jpg"
            write_file(folder / name, data)
            total_bytes += len(data)

            # ~15% chance of a RAW sidecar
            if camera.get("raw") and rng.random() < 0.15:
                raw_size = rng.randint(15_000_000, 35_000_000)
                raw_name = f"IMG_{rng.randint(1000, 9999)}{camera['raw']}"
                write_file(folder / raw_name, os.urandom(raw_size))
                total_bytes += raw_size

    # Thumbnails (should be ignored by importers)
    for i in range(5):
        small = Image.new('RGB', (160, 120), tuple(rng.randint(0, 255) for _ in range(3)))
        buf = BytesIO()
        small.save(buf, format='JPEG', quality=60)
        write_file(dcim_base / ".thumbnails" / f"thumb_{i:03d}.jpg", buf.getvalue())
        total_bytes += buf.tell()

    return total_bytes


def gen_photo_library(base, count, rng):
    """Generate organized photo library under photos/YYYY/event/."""
    total_bytes = 0
    events = [
        "vacation", "birthday", "christmas", "wedding", "garden",
        "city_trip", "hiking", "cooking", "pets", "random",
        "concert", "sport", "beach", "snow", "family",
    ]
    years = [2022, 2023, 2024, 2025]

    for i in range(count):
        year = rng.choice(years)
        event = rng.choice(events)
        month = rng.randint(1, 12)
        dt = datetime(year, month, rng.randint(1, 28), rng.randint(8, 22), rng.randint(0, 59))
        camera = rng.choice(CAMERAS)
        w, h = rng.choice(RESOLUTIONS)

        data = make_photo_with_exif(w, h, dt, camera, quality=rng.randint(88, 95))

        # Varied naming styles
        style = rng.choice(['img', 'dsc', 'phone', 'dated'])
        if style == 'img':
            name = f"IMG_{rng.randint(1000, 9999)}.jpg"
        elif style == 'dsc':
            name = f"DSC{rng.randint(10000, 99999)}.jpg"
        elif style == 'phone':
            name = f"IMG_{dt.strftime('%Y%m%d_%H%M%S')}_{rng.randint(0, 999):03d}.jpg"
        else:
            name = f"{dt.strftime('%Y-%m-%d_%H%M%S')}.jpg"

        # ~10% as PNG
        if rng.random() < 0.1:
            img = Image.open(BytesIO(data))
            buf = BytesIO()
            img.save(buf, format='PNG')
            data = buf.getvalue()
            name = os.path.splitext(name)[0] + '.png'

        write_file(base / "photos" / str(year) / event / name, data)
        total_bytes += len(data)

        if (i + 1) % 50 == 0:
            print(f"    Photos: {i + 1}/{count} ({format_size(total_bytes)})", flush=True)

    return total_bytes


def gen_videos(base, count, target_bytes, rng):
    """Generate fake video files that fill the remaining target space."""
    video_dir = base / "videos"
    total_bytes = 0
    per_video = max(1_048_576, target_bytes // max(count, 1))

    extensions = ['.mp4', '.mov', '.avi']
    names = [
        'family_dinner', 'vacation_clip', 'concert', 'birthday_party',
        'drone_footage', 'timelapse', 'gopro_ride', 'tutorial',
        'presentation', 'home_tour', 'sunset', 'fireworks',
        'wedding_speech', 'road_trip', 'cooking_video',
    ]

    for i in range(count):
        ext = rng.choice(extensions)
        name = f"{rng.choice(names)}_{rng.randint(1, 99):02d}{ext}"
        size = int(per_video * rng.uniform(0.6, 1.4))
        size = max(size, 1_048_576)  # at least 1 MB

        print(f"    Video: {name} ({format_size(size)})", flush=True)
        write_video(video_dir / name, size)
        total_bytes += size

    return total_bytes


def gen_documents(base, count, rng):
    """Generate documents in organized folders (work, personal, financial)."""
    total_bytes = 0
    doc_types = [
        ('work', ['.txt', '.md', '.json', '.csv', '.xml']),
        ('personal', ['.txt', '.md', '.html']),
        ('financial', ['.csv', '.json', '.txt']),
    ]

    generators = {
        '.txt': lambda r: lorem_text(r, r.randint(3, 10)),
        '.md':  lambda r: make_md_doc(r),
        '.json': lambda r: make_json_doc(r),
        '.csv': lambda r: make_csv_doc(r, r.randint(50, 500)),
        '.xml': lambda r: make_xml_doc(r),
        '.html': lambda r: make_html_doc(r),
    }

    for i in range(count):
        category, exts = rng.choice(doc_types)
        ext = rng.choice(exts)
        doc_rng = random.Random(SEED + 10000 + i)
        content = generators[ext](doc_rng)
        data = content.encode('utf-8') if isinstance(content, str) else content
        write_file(base / "documents" / category / f"doc_{i + 1:04d}{ext}", data)
        total_bytes += len(data)

    return total_bytes


def gen_databases(base, count, rng):
    """Generate SQLite databases with random tables and data."""
    total_bytes = 0
    db_dir = base / "databases"
    names = [
        'app', 'inventory', 'analytics', 'users', 'logs',
        'metrics', 'catalog', 'archive', 'tracking', 'config',
        'sessions', 'cache', 'reports', 'audit', 'tasks',
    ]

    for i in range(count):
        name = f"{rng.choice(names)}_{i + 1}.db"
        path = db_dir / name
        make_database(path, SEED + 20000 + i)
        total_bytes += os.path.getsize(path)

    return total_bytes


def gen_code_project(base, count, rng):
    """Generate a fake code project with various file types."""
    total_bytes = 0
    project_base = base / "projects" / "webapp"
    file_types = ['.py', '.js', '.sh', '.yml', '.toml', '.env']
    subdirs = ['src', 'src/utils', 'src/models', 'config', 'scripts', 'tests']

    for i in range(count):
        ext = rng.choice(file_types)
        subdir = rng.choice(subdirs)
        content = make_code_file(ext, SEED + 30000 + i)
        data = content.encode('utf-8')
        write_file(project_base / subdir / f"module_{i + 1:03d}{ext}", data)
        total_bytes += len(data)

    return total_bytes


def gen_edge_cases(base, count, rng):
    """Generate edge case files for robustness testing."""
    total_bytes = 0
    edge_base = base / "edge_cases"
    generated = 0

    # 1. Corrupt JPEG files
    for i in range(min(3, count)):
        data = b'\xff\xd8\xff\xe0' + os.urandom(rng.randint(1000, 50000))
        write_file(edge_base / "corrupt" / f"corrupt_{i + 1}.jpg", data)
        total_bytes += len(data)
        generated += 1

    # 2. Zero-byte files
    for ext in ['.jpg', '.txt', '.db', '.mp4']:
        if generated >= count:
            break
        write_file(edge_base / "empty" / f"empty{ext}", b'')
        generated += 1

    # 3. Very long filename (200 chars)
    if generated < count:
        long_name = "a" * 200 + ".txt"
        write_file(edge_base / "long_names" / long_name, b"long filename test")
        total_bytes += 18
        generated += 1

    # 4. Deep nesting (25 levels)
    if generated < count:
        deep_path = edge_base / "deep"
        for level in range(25):
            deep_path = deep_path / f"level_{level:02d}"
        write_file(deep_path / "deeply_nested.txt", b"found me at level 25!")
        total_bytes += 20
        generated += 1

    # 5. Unicode filenames
    unicode_names = [
        "café_résumé.txt",
        "日本語ファイル.txt",
        "émojis_🎉🎊.txt",
        "Ñoño_año_2024.txt",
    ]
    for name in unicode_names:
        if generated >= count:
            break
        try:
            content = f"Unicode filename test: {name}"
            write_file(edge_base / "unicode" / name, content.encode('utf-8'))
            total_bytes += len(content.encode('utf-8'))
            generated += 1
        except OSError:
            pass

    # 6. System junk files
    junk = {
        '.DS_Store': os.urandom(8192),
        'Thumbs.db': os.urandom(16384),
        '.hidden_file': b'hidden content',
        'desktop.ini': b'[.ShellClassInfo]\r\nIconResource=icon.ico\r\n',
    }
    for name, data in junk.items():
        if generated >= count:
            break
        write_file(edge_base / "system" / name, data)
        total_bytes += len(data)
        generated += 1

    # 7. Symlink
    if generated < count:
        try:
            link_dir = edge_base / "symlinks"
            link_dir.mkdir(parents=True, exist_ok=True)
            link_path = link_dir / "link_to_docs"
            if not link_path.exists():
                os.symlink(base / "documents", link_path)
            generated += 1
        except OSError:
            pass

    # 8. Files with spaces and special characters
    if generated < count:
        write_file(edge_base / "special_chars" / "file with spaces (1).txt", b"spaces")
        write_file(edge_base / "special_chars" / "file.multiple.dots.txt", b"dots")
        write_file(edge_base / "special_chars" / "file-with-dashes_and_underscores.txt", b"mixed")
        total_bytes += 17
        generated += 3

    return total_bytes


# ── Evolution mutations ───────────────────────────────────────────────

def scan_files(base, exclude=None):
    """Scan directory and return list of relative file paths."""
    if exclude is None:
        exclude = {'manifest.json'}
    files = []
    for root, dirs, filenames in os.walk(base):
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(root, d))]
        for f in filenames:
            if f in exclude:
                continue
            full = os.path.join(root, f)
            if not os.path.islink(full):
                files.append(os.path.relpath(full, base))
    return files


def evolve_1(base, rng):
    """Evolution 1: Small changes — modify docs, add photos, delete a few, rename some."""
    print("\n🔄 Evolution 1: Small changes")
    base = Path(base)
    files = scan_files(base)

    # Modify ~15% of documents
    docs = [f for f in files if f.startswith('documents/')]
    to_modify = rng.sample(docs, min(max(1, int(len(docs) * 0.15)), len(docs)))
    for f in to_modify:
        try:
            with open(base / f, 'a') as fh:
                fh.write(f"\n\n--- Updated on {datetime.now().isoformat()} ---\n")
                fh.write(lorem_text(rng, 2))
            print(f"  ✏️  Modified: {f}")
        except (OSError, UnicodeDecodeError):
            pass

    # Add 20 new photos
    photos_dir = base / "photos" / "2025" / "new_batch"
    for i in range(20):
        w, h = rng.choice(RESOLUTIONS)
        camera = rng.choice(CAMERAS)
        dt = datetime(2025, rng.randint(1, 6), rng.randint(1, 28), rng.randint(8, 22))
        data = make_photo_with_exif(w, h, dt, camera)
        write_file(photos_dir / f"IMG_NEW_{i + 1:04d}.jpg", data)
    print("  ➕ Added 20 new photos to photos/2025/new_batch/")

    # Delete 5 random photos
    photos = [f for f in files if f.endswith('.jpg') and 'edge_cases' not in f]
    to_delete = rng.sample(photos, min(5, len(photos)))
    for f in to_delete:
        try:
            os.remove(base / f)
            print(f"  🗑️  Deleted: {f}")
        except OSError:
            pass

    # Rename 10 files
    renameable = [f for f in files if f.endswith(('.txt', '.md', '.json')) and 'edge_cases' not in f]
    to_rename = rng.sample(renameable, min(10, len(renameable)))
    for f in to_rename:
        name, ext = os.path.splitext(f)
        dst = base / f"{name}_renamed{ext}"
        try:
            os.rename(base / f, dst)
            print(f"  📝 Renamed: {f}")
        except OSError:
            pass

    print("  ✅ Evolution 1 complete")


def evolve_2(base, rng):
    """Evolution 2: Medium changes — new DB, delete corrupt dir, add photos, modify code."""
    print("\n🔄 Evolution 2: Medium changes")
    base = Path(base)
    files = scan_files(base)

    # Add a new database
    make_database(base / "databases" / "new_analytics.db", SEED + 99999)
    print("  ➕ Added: databases/new_analytics.db")

    # Delete corrupt_files directory
    corrupt_dir = base / "edge_cases" / "corrupt"
    if corrupt_dir.exists():
        shutil.rmtree(corrupt_dir)
        print("  🗑️  Deleted: edge_cases/corrupt/")

    # Add 30 new photos
    photos_dir = base / "photos" / "2025" / "summer"
    for i in range(30):
        w, h = rng.choice(RESOLUTIONS)
        camera = rng.choice(CAMERAS)
        dt = datetime(2025, rng.randint(6, 8), rng.randint(1, 28))
        data = make_photo_with_exif(w, h, dt, camera)
        write_file(photos_dir / f"SUMMER_{i + 1:04d}.jpg", data)
    print("  ➕ Added 30 new photos to photos/2025/summer/")

    # Modify ~30% of code files
    code_files = [f for f in files if f.endswith(('.py', '.js', '.sh'))]
    to_modify = rng.sample(code_files, min(max(1, int(len(code_files) * 0.3)), len(code_files)))
    for f in to_modify:
        try:
            with open(base / f, 'a') as fh:
                fh.write(f"\n# Modified in evolution 2 — {datetime.now().isoformat()}\n")
            print(f"  ✏️  Modified: {f}")
        except (OSError, UnicodeDecodeError):
            pass

    print("  ✅ Evolution 2 complete")


def evolve_3(base, rng):
    """Evolution 3: Major restructure — move folders, update JSON, add many photos."""
    print("\n🔄 Evolution 3: Major restructure")
    base = Path(base)

    # Move documents/personal/ → documents/archive/personal/
    src_dir = base / "documents" / "personal"
    dst_dir = base / "documents" / "archive" / "personal"
    if src_dir.exists():
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src_dir), str(dst_dir))
        print("  📦 Moved: documents/personal/ → documents/archive/personal/")

    # Update all JSON files with evolution marker
    for root, _, filenames in os.walk(base):
        for f in filenames:
            if f.endswith('.json') and f != 'manifest.json':
                path = os.path.join(root, f)
                try:
                    with open(path) as fh:
                        data = json.load(fh)
                    data['_evolution'] = 3
                    data['_updated'] = datetime.now().isoformat()
                    with open(path, 'w') as fh:
                        json.dump(data, fh, indent=2)
                except (json.JSONDecodeError, OSError):
                    pass
    print("  ✏️  Updated all JSON files with evolution marker")

    # Add ~50 new photos across multiple events
    events = ['autumn_trip', 'birthday_2025', 'home_renovation']
    total_added = 0
    for event in events:
        photos_dir = base / "photos" / "2025" / event
        n = rng.randint(15, 20)
        for i in range(n):
            w, h = rng.choice(RESOLUTIONS)
            camera = rng.choice(CAMERAS)
            dt = datetime(2025, rng.randint(9, 12), rng.randint(1, 28))
            data = make_photo_with_exif(w, h, dt, camera)
            write_file(photos_dir / f"{event.upper()}_{i + 1:04d}.jpg", data)
        total_added += n
        print(f"  ➕ Added {n} photos to photos/2025/{event}/")

    # Create new project
    new_proj = base / "projects" / "api_service"
    for i in range(10):
        ext = rng.choice(['.py', '.js', '.yml'])
        content = make_code_file(ext, SEED + 50000 + i)
        write_file(new_proj / "src" / f"service_{i + 1:03d}{ext}", content.encode('utf-8'))
    print("  ➕ Added new project: projects/api_service/")

    print("  ✅ Evolution 3 complete")


# ── Main ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate realistic test datasets for RedMan backup testing.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python generate_test_data.py --size small      # ~2 GB dataset
  python generate_test_data.py --size medium     # ~5 GB dataset
  python generate_test_data.py --size large      # ~10 GB dataset
  python generate_test_data.py --evolve 1        # Small changes
  python generate_test_data.py --evolve 2        # Medium changes
  python generate_test_data.py --evolve 3        # Major restructure
  python generate_test_data.py --size small --force  # Regenerate
        """,
    )
    parser.add_argument('--size', choices=['small', 'medium', 'large'],
                        help='Size profile for initial generation')
    parser.add_argument('--evolve', type=int, choices=[1, 2, 3],
                        help='Apply evolution N to existing dataset')
    parser.add_argument('--force', action='store_true',
                        help='Force regeneration (deletes existing data)')
    args = parser.parse_args()

    if args.size is None and args.evolve is None:
        parser.error("Specify --size for initial generation or --evolve N for mutations")

    base = Path(BASE_DIR)
    manifest_path = base / "manifest.json"

    # ── Evolution mode ────────────────────────────────────────────────
    if args.evolve is not None:
        if not manifest_path.exists():
            print("❌ No existing dataset found. Run with --size first.")
            sys.exit(1)

        with open(manifest_path) as f:
            manifest = json.load(f)

        rng = random.Random(SEED + args.evolve * 1000)

        if args.evolve == 1:
            evolve_1(base, rng)
        elif args.evolve == 2:
            evolve_2(base, rng)
        elif args.evolve == 3:
            evolve_3(base, rng)

        manifest['evolution'] = args.evolve
        manifest['evolved_at'] = datetime.now().isoformat()
        manifest['total_size'] = dir_size(base)
        manifest['total_size_human'] = format_size(dir_size(base))

        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)

        print(f"\n📊 Dataset size: {format_size(dir_size(base))}")
        return

    # ── Initial generation mode ───────────────────────────────────────
    profile = PROFILES[args.size]

    if manifest_path.exists() and not args.force:
        print(f"❌ Dataset already exists at {base}")
        print(f"   Use --force to regenerate, or --evolve N to mutate.")
        sys.exit(1)

    if base.exists() and args.force:
        print("🗑️  Removing existing data...")
        shutil.rmtree(base)

    print("🔨 RedMan Test Data Generator")
    print(f"   Profile: {args.size} (~{profile['target_gb']} GB)")
    print(f"   Output:  {base}")
    print()

    random.seed(SEED)
    rng = random.Random(SEED)
    t0 = time.time()

    target_bytes = profile['target_gb'] * 1024 * 1024 * 1024
    generated_bytes = 0

    # 1. Camera DCIM folders (40% of photos)
    dcim_count = int(profile['photos'] * 0.4)
    print(f"📸 Generating {dcim_count} DCIM camera photos...")
    generated_bytes += gen_camera_dcim(base, dcim_count, rng)

    # 2. Organized photo library (60% of photos)
    lib_count = profile['photos'] - dcim_count
    print(f"📸 Generating {lib_count} organized photos...")
    generated_bytes += gen_photo_library(base, lib_count, rng)

    # 3. Documents
    print(f"📄 Generating {profile['documents']} documents...")
    generated_bytes += gen_documents(base, profile['documents'], rng)

    # 4. Databases
    print(f"🗃️  Generating {profile['databases']} databases...")
    generated_bytes += gen_databases(base, profile['databases'], rng)

    # 5. Code project
    print(f"💻 Generating {profile['code_files']} code files...")
    generated_bytes += gen_code_project(base, profile['code_files'], rng)

    # 6. Edge cases
    print(f"⚠️  Generating {profile['edge_cases']} edge cases...")
    generated_bytes += gen_edge_cases(base, profile['edge_cases'], rng)

    # 7. Videos (fill remaining space)
    remaining = target_bytes - generated_bytes
    if remaining > 0:
        print(f"🎬 Generating {profile['videos']} videos ({format_size(remaining)} to fill)...")
        generated_bytes += gen_videos(base, profile['videos'], remaining, rng)

    elapsed = time.time() - t0
    actual_size = dir_size(base)

    # Write manifest
    manifest = {
        "generated_at": datetime.now().isoformat(),
        "profile": args.size,
        "evolution": 0,
        "target_size": target_bytes,
        "target_size_human": format_size(target_bytes),
        "total_size": actual_size,
        "total_size_human": format_size(actual_size),
        "elapsed_seconds": round(elapsed, 1),
        "categories": {
            "dcim_photos": dcim_count,
            "library_photos": lib_count,
            "videos": profile['videos'],
            "documents": profile['documents'],
            "databases": profile['databases'],
            "code_files": profile['code_files'],
            "edge_cases": profile['edge_cases'],
        },
    }
    with open(manifest_path, 'w') as f:
        json.dump(manifest, f, indent=2)

    print(f"\n{'=' * 60}")
    print(f"✅ Test data generated in {elapsed:.1f}s")
    print(f"   Profile:  {args.size}")
    print(f"   Target:   {format_size(target_bytes)}")
    print(f"   Actual:   {format_size(actual_size)}")
    print(f"   Location: {base}")
    print(f"\nTo evolve the dataset (for versioning tests):")
    print(f"   python generate_test_data.py --evolve 1  # small changes")
    print(f"   python generate_test_data.py --evolve 2  # medium changes")
    print(f"   python generate_test_data.py --evolve 3  # major restructure")


if __name__ == "__main__":
    main()
