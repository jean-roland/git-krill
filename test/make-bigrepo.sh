#!/bin/sh
# Big test repo in <dir>/big: 60k commits with merges, 300 local branches tracking origin, 3300 remote branches, 1500 tags, 20k files.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "${1:?usage: make-bigrepo.sh <dir>}" && rm -rf big && git init -q -b main big && cd big
python3 "$here/bigrepo.py" 60000 20000 .git/open-branches | git fast-import --quiet
git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false; git config tag.gpgSign false
git checkout -q main
git remote add origin https://example.invalid/big.git
# each open branch one commit ahead of its upstream
for b in $(cat .git/open-branches); do
  git config "branch.$b.remote" origin; git config "branch.$b.merge" "refs/heads/$b"
  git update-ref "refs/remotes/origin/$b" "$(git rev-parse "$b~1")"
done
git rev-list --all --count
