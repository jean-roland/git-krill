#!/bin/sh
# Worktree test repo in <dir>/wt: wt/main has agent-a (uncommitted changes), agent-b (a commit ahead) and gone (folder deleted).
set -e
cd "${1:?usage: make-worktrees.sh <dir>}" && rm -rf wt && mkdir -p wt/main && cd wt/main
git init -q -b main
git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false; git config tag.gpgSign false
mkdir src
printf 'int parse(const char *s)\n{\n    return s[0];\n}\n' > src/parser.c
printf '# demo\n' > README.md
git add -A && git commit -q -m "feat: add the parser"
git worktree add -q ../agent-a -b agent-a
git worktree add -q ../agent-b -b agent-b
git worktree add -q ../gone -b gone
# what an agent leaves behind: an edit and a new file, nothing committed
printf 'int parse(const char *s)\n{\n    return s ? s[0] : -1;\n}\n' > ../agent-a/src/parser.c
printf 'int lex(void);\n' > ../agent-a/src/lexer.h
(cd ../agent-b && printf 'parser handles empty input\n' >> README.md && git commit -q -am "docs: note empty input")
rm -rf ../gone
git worktree list
