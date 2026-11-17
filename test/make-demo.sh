#!/bin/sh
# README screenshot repos in <dir>/demo: demo/tidepool (branches, tags, merges, a remote, a stash, WIP, an LFS chart when git-lfs is here, a submodule, a worktree, two pull requests for e2e/bin/gh in demo/gh) and demo/conflict/tidepool (merge stopped).
set -e
cd "${1:?usage: make-demo.sh <dir>}" && rm -rf demo && mkdir -p demo && cd demo
D=$(pwd)
git init -q --bare -b main origin.git
git init -q --bare -b main tidecalc.git
git init -q -b main tidepool && cd tidepool
git config commit.gpgSign false; git config tag.gpgSign false
# its submodule's URL is a local path
git config protocol.file.allow always
git remote add origin "$D/origin.git"
lfs=$(git lfs version >/dev/null 2>&1 && echo 1 || true)
[ -z "$lfs" ] || git lfs install --local >/dev/null
day=0 start=$(date -d "2026-09-20 09:00" +%s)
who() { # who <name>: the next commit's author, 19 hours after the last one
  day=$((day + 1))
  export GIT_AUTHOR_NAME="$1" GIT_AUTHOR_EMAIL="$(echo "$1" | cut -d' ' -f1 | tr A-Z a-z | sed s/é/e/)@example.com" GIT_AUTHOR_DATE="$(date -d @$((start + day * 19 * 3600)) -Iseconds)"
  export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL" GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
}
as() { # as <name> <subject> [body]: commit everything as that author
  who "$1"
  git add -A && git commit -q -m "$2" ${3:+-m "$3"}
}
chart() { # chart <png> <stations...>: a day of each station's tide, a curve each
  python3 -c 'import math, struct, sys, zlib
w, h, colors = 640, 220, {"brest": (26, 158, 166), "dover": (217, 125, 93)}
consts = {"brest": (4.1, 2.6, 3), "dover": (3.7, 2.9, 5)}
px = [[(246, 248, 250)] * w for _ in range(h)]
for y in (20, 110, 200):
    px[y] = [(208, 215, 222)] * w
for s in sys.argv[2:]:
    mean, amp, off = consts[s]
    for x in range(w):
        t = x / w * 24
        y = int(110 - (amp * math.cos(2 * math.pi * (t - off) / 12.42)) * 32)
        for dy in range(-2, 3):
            px[y + dy][x] = colors[s]
chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
rows = b"".join(b"\0" + bytes(c for p in r for c in p) for r in px)
open(sys.argv[1], "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))' "$@"
}
mkdir -p src tests
cat > Cargo.toml <<'E'
[package]
name = "tidepool"
version = "0.1.0"
edition = "2021"
E
cat > src/main.rs <<'E'
mod tide;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let station = args.get(1).map(String::as_str).unwrap_or("brest");
    for t in tide::today(station) {
        println!("{} {:>5.2} m", t.time, t.height);
    }
}
E
as "Ana Ferreira" "chore: cargo init"
printf 'MIT License\n\nCopyright (c) 2026 the tidepool authors\n' > LICENSE
as "Ana Ferreira" "chore: add the MIT licence"
cat > src/tide.rs <<'E'
/// A high or low water.
pub struct Tide {
    pub time: String,
    pub height: f64,
}

/// Harmonic constants of a station.
struct Constants {
    mean: f64,
    amplitude: f64,
    offset: u32,
}

fn constants(station: &str) -> Constants {
    match station {
        "brest" => Constants { mean: 4.1, amplitude: 2.6, offset: 3 },
        "dover" => Constants { mean: 3.7, amplitude: 2.9, offset: 5 },
        _ => Constants { mean: 2.0, amplitude: 1.0, offset: 0 },
    }
}

/// Today's high and low waters at `station`.
pub fn today(station: &str) -> Vec<Tide> {
    let k = constants(station);
    (0..4)
        .map(|i| {
            let hour = k.offset + i * 6;
            let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
            Tide { time: format!("{:02}:{:02}", hour, (i * 12) % 60), height: k.mean + sign * k.amplitude }
        })
        .collect()
}
E
as "Ana Ferreira" "feat: print today's tides for a station"
cat > stations.toml <<'E'
[brest]
mean = 4.1
amplitude = 2.6

[dover]
mean = 3.7
amplitude = 2.9
E
as "Ben Okafor" "feat(station): list the stations in stations.toml" "Each station has its mean level and amplitude; the code still has its own copy until the loader lands."
mkdir -p .github/workflows && printf 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: cargo test\n' > .github/workflows/ci.yml
as "Dev Raman" "ci: run the tests on push"
printf '# tidepool\n\nTide tables in the terminal.\n\n```sh\ntidepool brest\n```\n' > README.md
as "Ana Ferreira" "docs: add a README"
cat > tests/tide.rs <<'E'
#[test]
fn four_tides_a_day() {
    assert_eq!(tidepool::today("brest").len(), 4);
}
E
as "Ben Okafor" "test: four tides a day"
sed -i 's/unwrap_or("brest")/unwrap_or("brest") \/\/ the default until stations.toml is read/' src/main.rs
as "Chloé Martin" "fix(cli): say which station is the default"
git tag -a v0.1.0 -m v0.1.0
printf '\nHeights are in metres above chart datum, the lowest astronomical tide.\n' >> README.md
as "Chloé Martin" "docs: explain chart datum"
mkdir -p docs && cat > docs/design.md <<'E'
# How tidepool computes a day

A station's harmonic constants give its four tides of the day.

```mermaid
flowchart TD
  station[Station name] --> constants[Harmonic constants]
  constants --> tides[Four tides]
  tides --> print[Print the table]
```
E
as "Ana Ferreira" "docs: describe how a day is computed"
sed -i 's/        _ => Constants { mean: 2.0, amplitude: 1.0, offset: 0 },/        _ => panic!("unknown station {station}"),/' src/tide.rs
as "Ben Okafor" "fix(station): reject unknown stations" "A made-up station used to print plausible tides for nowhere. It now stops with the station's name, until the list in stations.toml is read."
git checkout -q -b feature/json-output
sed -i 's/    for t in tide::today(station) {/    if args.iter().any(|a| a == "--json") {\n        return println!("{}", tide::json(station));\n    }\n    for t in tide::today(station) {/' src/main.rs
printf '\n/// Today'"'"'s tides as JSON.\npub fn json(station: &str) -> String {\n    let rows: Vec<String> = today(station).iter().map(|t| format!("{{\\"time\\":\\"{}\\",\\"height\\":{}}}", t.time, t.height)).collect();\n    format!("[{}]", rows.join(","))\n}\n' >> src/tide.rs
as "Dev Raman" "feat(cli): --json output"
printf '\n#[test]\nfn json_lists_every_tide() {\n    assert_eq!(tidepool::json("brest").matches("time").count(), 4);\n}\n' >> tests/tide.rs
as "Dev Raman" "test(cli): json lists every tide"
git checkout -q main
sed -i 's/            let hour = k.offset + i \* 6;/            let hour = (k.offset + i * 6) % 24;/' src/tide.rs
as "Chloé Martin" "fix(tide): wrap times past midnight"
who "Ana Ferreira" && git merge -q --no-ff feature/json-output -m "Merge branch 'feature/json-output'"
sed -i 's/fn constants(station: \&str) -> Constants {/\/\/ looked up once per run: the table never changes while it runs\nfn constants(station: \&str) -> Constants {/' src/tide.rs
as "Ben Okafor" "perf(tide): note why constants are not cached"
# a picture: stored with LFS when git-lfs is here
[ -z "$lfs" ] || git lfs track '*.png' >/dev/null
chart docs/chart.png brest && printf '\n![A day of tides at Brest](docs/chart.png)\n' >> README.md
as "Dev Raman" "docs: a tide chart for Brest"
git checkout -q -b fix/rounding
sed -i 's/height: k.mean + sign \* k.amplitude }/height: ((k.mean + sign * k.amplitude) * 100.0).round() \/ 100.0 }/' src/tide.rs
as "Ben Okafor" "fix(tide): round heights to the centimetre"
git checkout -q main
who "Ana Ferreira" && git merge -q --no-ff fix/rounding -m "Merge branch 'fix/rounding'"
git branch -q -d fix/rounding
printf '\nAdd `--json` for one JSON array of the day'"'"'s tides.\n' >> README.md
as "Dev Raman" "docs: --json in the README"
chart docs/chart.png brest dover
as "Dev Raman" "docs: chart Dover beside Brest"
# the harmonics library, a submodule
who "Ben Okafor" && git clone -q "$D/tidecalc.git" "$D/tidecalc" 2>/dev/null && mkdir -p "$D/tidecalc/src" && printf '/// The main lunar semidiurnal constituent, in hours.\npub const M2: f64 = 12.42;\n' > "$D/tidecalc/src/lib.rs"
(cd "$D/tidecalc" && git add -A && git -c commit.gpgSign=false commit -q -m "feat: the M2 constituent" && git push -q origin HEAD:main) && rm -rf "$D/tidecalc"
git -c protocol.file.allow=always submodule add -q "$D/tidecalc.git" vendor/tidecalc
as "Ben Okafor" "chore: vendor tidecalc for the harmonics"
sed -i 's/version = "0.1.0"/version = "0.2.0"/' Cargo.toml
as "Ana Ferreira" "chore: release 0.2.0"
git tag -a v0.2.0 -m v0.2.0
git checkout -q -b feature/moon-phase
printf '/// Days since the last new moon, 0 to 29.\npub fn age(days_since_epoch: u32) -> u32 {\n    (days_since_epoch * 100 + 1_500) / 2_953 %% 30\n}\n' > src/moon.rs
sed -i 's/^mod tide;/mod moon;\nmod tide;/' src/main.rs
as "Chloé Martin" "feat(moon): compute the moon's age"
sed -i 's/        println!("{} {:>5.2} m", t.time, t.height);/        let spring = moon::age(t.day) < 3;\n        println!("{} {:>5.2} m{}", t.time, t.height, if spring { "  spring tide" } else { "" });/' src/main.rs
as "Chloé Martin" "feat(cli): mark spring tides" "Spring tides come within three days of the new or full moon: the line gets a mark so the big ranges stand out.

The moon's age is a mean-cycle estimate, good to a day; close enough for a mark."
printf '\nSpring tides, around the new and full moon, are marked.\n' >> README.md
as "Chloé Martin" "docs: spring tides in the README"
sed -i 's/  tides --> print\[Print the table\]/  moon[Moon age] --> spring{Spring tide?}\n  tides --> spring\n  spring --> print[Print the table]/' docs/design.md
as "Chloé Martin" "docs: the moon in the design note"
git checkout -q main
git checkout -q -b feature/tide-alerts
printf '/// Warn when the next high water passes `limit` metres.\npub fn alert(height: f64, limit: f64) -> Option<String> {\n    (height > limit).then(|| format!("high water {height:.2} m over {limit:.2} m"))\n}\n' > src/alert.rs
as "Dev Raman" "feat(alert): warn over a height limit"
git checkout -q main
mkdir -p src/stations && printf 'brest\nroscoff\nsaint-malo\n' > src/stations/brittany.txt && printf 'dover\nfolkestone\n' > src/stations/kent.txt
as "Dev Raman" "refactor(station): one file per region" "stations.toml grew past a hundred entries. One plain list per region is easier to review and to extend."
sed -i 's/edition = "2021"/edition = "2024"/' Cargo.toml
as "Ben Okafor" "chore: move to the 2024 edition"
git push -q origin main feature/moon-phase feature/tide-alerts 2>/dev/null
git branch -q -D feature/tide-alerts
git branch -q -u origin/feature/moon-phase feature/moon-phase
git branch -q -u origin/main main
# a worktree for the moon work, beside
git worktree add -q "$D/tidepool-moon" feature/moon-phase
# the project upstream, where pull requests go: no server answers there, e2e/bin/gh does from demo/gh
git remote add upstream https://github.invalid/tidepool/tidepool.git
git update-ref refs/remotes/upstream/main main
mkdir -p "$D/gh" && python3 -c 'import json, sys
gh, moon, alerts = sys.argv[1:]
url = "https://github.invalid/tidepool/tidepool/pull/"
run = lambda name, done=True: {"__typename": "CheckRun", "name": name, "workflowName": "CI", "status": "COMPLETED" if done else "IN_PROGRESS", "conclusion": "SUCCESS" if done else "", "detailsUrl": "https://github.invalid/tidepool/tidepool/actions"}
pr = lambda n, branch, sha, title, who, body, checks, draft=False: {"number": n, "title": title, "body": body, "author": {"login": who}, "createdAt": "2026-10-14T10:20:00Z", "url": url + str(n), "isDraft": draft, "isCrossRepository": False, "headRefName": branch, "headRefOid": sha, "baseRefName": "main", "statusCheckRollup": checks}
user = lambda login: {"login": login}
save = lambda name, data: json.dump(data, open(f"{gh}/{name}.json", "w"), indent=1)
save("prs", [
    pr(12, "feature/moon-phase", moon, "Mark spring tides", "chloe-martin", "Spring tides come within three days of the new or full moon: their lines get a mark, so the big ranges stand out.\n\n- `moon::age` estimates the moon age from the mean synodic month\n- the README says what the mark means\n- the design note gets the moon\n\nGood to a day, which is all a mark needs.", [run("build"), run("test"), run("clippy")]),
    pr(11, "feature/tide-alerts", alerts, "Warn over a height limit", "dev-raman", "A first cut of height alerts, for the harbour master.", [run("build", False)], True),
])
hunk = "@@ -5,6 +5,8 @@ fn main() {\n     let station = args.get(1).map(String::as_str).unwrap_or(\"brest\");\n     for t in tide::today(station) {\n-        println!(\"{} {:>5.2} m\", t.time, t.height);\n+        let spring = moon::age(t.day) < 3;"
save("pulls-12-reviews", [
    {"id": 1, "user": user("ben-okafor"), "body": "", "state": "COMMENTED", "submitted_at": "2026-10-14T15:02:00Z"},
    {"id": 2, "user": user("chloe-martin"), "body": "", "state": "COMMENTED", "submitted_at": "2026-10-14T16:40:00Z"},
    {"id": 3, "user": user("ana-ferreira"), "body": "Nice touch for the big ranges. Ship it.", "state": "APPROVED", "submitted_at": "2026-10-15T08:12:00Z"},
])
save("pulls-12-comments", [
    {"id": 10, "pull_request_review_id": 1, "user": user("ben-okafor"), "path": "src/main.rs", "line": 9, "original_line": 9, "diff_hunk": hunk, "body": "Only within three days of the **new** moon? The full moon gives spring tides too.", "created_at": "2026-10-14T15:02:00Z"},
    {"id": 11, "in_reply_to_id": 10, "pull_request_review_id": 2, "user": user("chloe-martin"), "path": "src/main.rs", "line": 9, "original_line": 9, "diff_hunk": hunk, "body": "It does: the full moon comes next, in its own pull request.", "created_at": "2026-10-14T16:40:00Z"},
])
save("issues-12-comments", [{"id": 20, "user": user("dev-raman"), "body": "Checked against the published tables for Brest: the marks line up.", "created_at": "2026-10-14T11:05:00Z"}])' "$D/gh" "$(git rev-parse feature/moon-phase)" "$(git rev-parse origin/feature/tide-alerts)"
sed -i 's/    for t in tide::today(station) {/    let days: u32 = args.iter().position(|a| a == "--days").and_then(|i| args.get(i + 1)?.parse().ok()).unwrap_or(1);\n    for t in (0..days).flat_map(|d| tide::on_day(station, d)) {/' src/main.rs
as "Ana Ferreira" "feat(cli): --days to print several days"
printf 'pub fn search(name: &str) -> Vec<&'"'"'static str> {\n    Vec::new()\n}\n' > src/search.rs
git stash push -q -u -m "station search"
# uncommitted work: two hunks in tide.rs, one new file
sed -i 's/        "dover" => Constants { mean: 3.7, amplitude: 2.9, offset: 5 },/        "dover" => Constants { mean: 3.7, amplitude: 2.9, offset: 5 },\n        "saint-malo" => Constants { mean: 6.8, amplitude: 4.9, offset: 4 },/; s/^\/\/\/ Today'"'"'s high and low waters at `station`./\/\/\/ Today'"'"'s high and low waters at `station`, heights in metres above chart datum./' src/tide.rs
printf '/// Metres to feet.\npub fn feet(metres: f64) -> f64 {\n    metres / 0.3048\n}\n' > src/units.rs
# the conflict copy: moon-phase merged into a main that changed the same loop
cd "$D" && mkdir conflict && git clone -q origin.git conflict/tidepool && cd conflict/tidepool
git config commit.gpgSign false
[ -z "$lfs" ] || git lfs install --local >/dev/null
git -C "$D/tidepool" format-patch -q -1 main -o "$D/p" && git -c user.name="Ana Ferreira" -c user.email=ana@example.com am -q "$D"/p/*.patch && rm -r "$D/p"
git -c user.name="Ana Ferreira" -c user.email=ana@example.com merge -q origin/feature/moon-phase >/dev/null 2>&1 || true
# its pull requests too: the same upstream, e2e/bin/gh reading the same folder
git remote add upstream https://github.invalid/tidepool/tidepool.git && git update-ref refs/remotes/upstream/main origin/main && ln -s ../gh "$D/conflict/gh"
git status --short
