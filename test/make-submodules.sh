#!/bin/sh
# Submodule test repos in <dir>/sub: sub/app has libs/core (in sync, bumped once in its history, with its own submodule vendor/fmt), libs/ui (moved to a newer commit), libs/net (edited inside), libs/docs (not initialized); core.git and fmt.git have a commit not taken yet, extra.git is left to add.
set -e
cd "${1:?usage: make-submodules.sh <dir>}" && rm -rf sub && mkdir -p sub/upstream && cd sub
# git refuses local paths as submodule URLs unless allowed
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always
id() { git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false; git config tag.gpgSign false; }
# upstream/<lib> plays the library's own developer
for l in fmt core ui net docs extra; do
  git init -q --bare -b main $l.git && git clone -q $l.git upstream/$l 2>/dev/null
  (cd upstream/$l && id && printf '# %s\n' $l > README.md && git add -A && git commit -qm "feat: start $l" && git push -q origin main)
done
# one level down: core has a submodule of its own
(cd upstream/core && git submodule add -q ../fmt.git vendor/fmt && git commit -qm "feat: vendor fmt" && git push -q origin main)
bump() { (cd upstream/$1 && printf '%s\n' "$2" >> README.md && git commit -qam "$2" && git push -q origin main); }
git init -q -b main app && cd app && id && git config protocol.file.allow always
printf '# app\n' > README.md && git add -A && git commit -qm "feat: start the app"
for l in core ui net docs; do git submodule add -q ../$l.git libs/$l; done
git commit -qm "feat: add the libraries as submodules"
git submodule update -q --init --recursive && git -C libs/core config protocol.file.allow always
# a bump in the history: the commit's diff of libs/core lists the commit it takes
(cd .. && bump core "feat: faster core")
git -C libs/core fetch -q && git -C libs/core checkout -q origin/main && git add libs/core && git commit -qm "chore: bump core"
(cd .. && bump core "fix: core crash" && bump ui "feat: dark theme" && bump fmt "feat: fmt v2")
git -C libs/ui fetch -q && git -C libs/ui checkout -q origin/main
printf 'draft\n' >> libs/net/README.md
git submodule deinit -q libs/docs
git submodule status --recursive && git status --short
