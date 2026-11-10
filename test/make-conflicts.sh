#!/bin/sh
# Conflict test repos in <dir>/cf: cf/rebase stops on a rebase conflict, cf/merge on a merge one.
set -e
cd "${1:?usage: make-conflicts.sh <dir>}" && rm -rf cf && mkdir -p cf/rebase && cd cf/rebase
git init -q -b main
git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false; git config tag.gpgSign false
mkdir src
cat > src/radio.c <<'C'
#include "radio.h"

#define RADIO_RETRIES 3
#define RADIO_TIMEOUT_MS 100

static int radio_state = 0;

int radio_init(void)
{
    radio_state = 1;
    return 0;
}

int radio_send(const uint8_t *buf, size_t len)
{
    for (int i = 0; i < RADIO_RETRIES; i++) {
        if (radio_tx(buf, len) == 0) {
            return 0;
        }
    }
    return -1;
}

int radio_recv(uint8_t *buf, size_t len)
{
    return radio_rx(buf, len, RADIO_TIMEOUT_MS);
}
C
for i in $(seq 1 60); do printf 'int filler_%d(void) { return %d; }\n' $i $i; done >> src/radio.c
printf '#pragma once\n#define CHANNEL 11\n#define POWER_DBM 14\n' > src/config.h
printf 'old helper\n' > src/legacy.c
printf '# Radio\nDummy radio driver.\n' > README.md
git add -A && git commit -qm "feat: radio driver"
git checkout -qb feature
sed -i 's/#define RADIO_RETRIES 3/#define RADIO_RETRIES 5/; s/    radio_state = 1;/    radio_state = 1;\n    radio_calibrate();/; s/return 50; }/return 500; }/' src/radio.c
git commit -qam "feat(radio): calibrate at init, 5 retries"
sed -i 's/#define POWER_DBM 14/#define POWER_DBM 20/' src/config.h && printf 'old helper, still used\n' > src/legacy.c
git commit -qam "feat(config): raise the power"
printf 'int feature_only(void);\n' > src/feature.c && printf 'int both = 1;\nint feature_side;\n' > src/both.c && git add src/feature.c src/both.c && git commit -qm "feat: feature only file"
git checkout -q main
sed -i 's/#define RADIO_RETRIES 3/#define RADIO_RETRIES 4/; s/    radio_state = 1;/    radio_state = 2;\n    radio_reset();/; s/return 50; }/return -50; }\nint filler_extra(void);/' src/radio.c
git commit -qam "fix(radio): reset at init"
sed -i 's/#define POWER_DBM 14/#define POWER_DBM 10/' src/config.h && printf 'int both = 2;\n' > src/both.c && git add src/both.c && git rm -q src/legacy.c && printf '# Radio\nDummy radio driver, now documented.\n' > README.md
git commit -qam "fix(config): lower the power, drop legacy"
cd .. && git clone -q --no-local rebase merge && cd merge
git config user.name "Dummy Dev"; git config user.email dummy@test; git config commit.gpgSign false
git checkout -q -b feature origin/feature && git checkout -q main
git merge -q feature >/dev/null 2>&1 || true
cd ../rebase && git checkout -q feature && git rebase -q main >/dev/null 2>&1 || true
git -C ../merge status --short; git status --short
