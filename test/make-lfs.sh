#!/bin/sh
# Git LFS test repos in <dir>/lfs, all cloned from lfs/origin.git: lfs/work has LFS changes, lfs/merge stops on LFS conflicts, lfs/pointers has nothing downloaded.
set -e
git lfs version >/dev/null
cd "${1:?usage: make-lfs.sh <dir>}" && rm -rf lfs && mkdir -p lfs/work && cd lfs
git init -q --bare -b main origin.git
# a w x w solid PNG of colour rrggbb
png() {
  python3 -c 'import struct, sys, zlib
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
w = 48
sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, w, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress((b"\0" + bytes.fromhex(sys.argv[1]) * w) * w)) + chunk(b"IEND", b""))' "$1" > "$2"
}
setup() {
  git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false; git config tag.gpgSign false
  git lfs install --local >/dev/null
}
cd work
git init -q -b main && setup && git remote add origin ../origin.git
git lfs track '*.png' '*.bin' 'data/*.csv' >/dev/null
mkdir assets data
png 46b1ab assets/logo.png
for i in $(seq 1 30); do printf 'node_%d,%d,%d\n' $i $((i * 7 % 13)) $((i * 3)); done > data/table.csv
head -c 4096 /dev/urandom > data/model.bin
printf '# LFS demo\nAssets and data are stored with Git LFS.\n' > README.md
git add -A && git commit -qm "feat: add the assets"
png d95d72 assets/logo.png && git commit -qam "feat: recolor the logo"
printf 'plain text, not in LFS\n' > notes.txt && git add notes.txt && git commit -qm "docs: add notes"
git checkout -qb feature
png 5d88d9 assets/logo.png && sed -i 's/^node_5,.*/node_5,99,99/' data/table.csv && git commit -qam "feat: blue logo, retune node 5"
git checkout -q main
png 5bc78e assets/logo.png && sed -i 's/^node_5,.*/node_5,0,0/' data/table.csv && git commit -qam "feat: green logo, reset node 5"
git push -q origin main feature >/dev/null 2>&1
# what is left to commit: an LFS text edit in two hunks, an LFS binary edit, a new LFS image
sed -i 's/^node_2,.*/node_2,1,1/; s/^node_28,.*/node_28,2,2/' data/table.csv
head -c 4096 /dev/urandom > data/model.bin
png d9ba5d assets/icon.png
cd .. && git clone -q --no-checkout origin.git merge && cd merge && setup && git checkout -q main
git merge -q origin/feature >/dev/null 2>&1 || true
# a clone that skipped the LFS download: only pointers
cd .. && GIT_LFS_SKIP_SMUDGE=1 git clone -q origin.git pointers && cd pointers && setup
cd .. && git -C work status --short && git -C merge status --short && git -C pointers lfs ls-files
