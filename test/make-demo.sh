#!/bin/sh
# README screenshot repos in <dir>/demo: demo/tidepool (branches, tags, merges, a remote, a stash, WIP) and demo/conflict/tidepool (merge stopped).
set -e
cd "${1:?usage: make-demo.sh <dir>}" && rm -rf demo && mkdir -p demo && cd demo
D=$(pwd)
git init -q --bare origin.git
git init -q -b main tidepool && cd tidepool
git config commit.gpgSign false; git config tag.gpgSign false
git remote add origin "$D/origin.git"
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
git checkout -q -b fix/rounding
sed -i 's/height: k.mean + sign \* k.amplitude }/height: ((k.mean + sign * k.amplitude) * 100.0).round() \/ 100.0 }/' src/tide.rs
as "Ben Okafor" "fix(tide): round heights to the centimetre"
git checkout -q main
who "Ana Ferreira" && git merge -q --no-ff fix/rounding -m "Merge branch 'fix/rounding'"
git branch -q -d fix/rounding
printf '\nAdd `--json` for one JSON array of the day'"'"'s tides.\n' >> README.md
as "Dev Raman" "docs: --json in the README"
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
git -C "$D/tidepool" format-patch -q -1 main -o "$D/p" && git -c user.name="Ana Ferreira" -c user.email=ana@example.com am -q "$D"/p/*.patch && rm -r "$D/p"
git -c user.name="Ana Ferreira" -c user.email=ana@example.com merge -q origin/feature/moon-phase >/dev/null 2>&1 || true
git status --short
