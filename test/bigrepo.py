# bigrepo.py <commits> <files> <open-list>: a git fast-import stream on stdout for a large synthetic repo; the open branches go to <open-list>
# main line with a feature branch merged every 20 commits, 300 features left open, a tag every 40 main commits
import random, sys

COMMITS, FILES = int(sys.argv[1]), int(sys.argv[2])
rnd = random.Random(7)
out = sys.stdout.buffer
authors = [f"Dev {chr(65 + i % 26)}{i // 26} <dev{i}@example.com>" for i in range(60)]
mark = 0
t = 1_600_000_000


def w(s):
    out.write(s.encode() if isinstance(s, str) else s)


def blob(data: bytes):
    global mark
    mark += 1
    w(f"blob\nmark :{mark}\ndata {len(data)}\n")
    w(data)
    w("\n")
    return mark


def path(i):
    return f"src/m{i % 50:02}/d{i % 400:03}/f{i:05}.c"


hot = [f"int line_{n} = {n};\n" for n in range(5000)]


def commit(ref, parents, changes, msg):
    global mark, t
    t += 600
    a = rnd.choice(authors)
    blobs = [(p, blob(d)) for p, d in changes]
    mark += 1
    w(f"commit {ref}\nmark :{mark}\nauthor {a} {t} +0000\ncommitter {a} {t} +0000\ndata {len(msg)}\n{msg}\n")
    if parents:
        w(f"from :{parents[0]}\n")
        for p in parents[1:]:
            w(f"merge :{p}\n")
    for p, b in blobs:
        w(f"M 100644 :{b} {p}\n")
    w("\n")
    return mark


def edit():
    if rnd.random() < 0.02:
        k = rnd.randrange(len(hot))
        hot[k] = f"int line_{k} = {rnd.randrange(10**6)};\n"
        return [("src/hot.c", "".join(hot).encode())]
    i = rnd.randrange(FILES)
    return [(path(i), f"/* file {i} */\nint f{i}(void) {{ return {rnd.randrange(10**6)}; }}\n".encode())]


head = commit("refs/heads/main", [], [(path(i), f"/* file {i} */\nint f{i}(void) {{ return 0; }}\n".encode()) for i in range(FILES)] + [("src/hot.c", "".join(hot).encode())], "init")
n, feature, tags, open_features = 1, 0, 0, []
while n < COMMITS:
    head = commit("refs/heads/main", [head], edit(), f"main change {n}")
    n += 1
    if n % 40 == 0:
        tags += 1
        w(f"reset refs/tags/v{tags}\nfrom :{head}\n\n")
    if n % 20 == 0:
        feature += 1
        ref = f"refs/remotes/origin/feature/f{feature:04}"
        tip = head
        for k in range(rnd.randrange(2, 6)):
            tip = commit(ref, [tip], edit(), f"feature {feature} step {k}")
            n += 1
        if feature % 7 == 0 and len(open_features) < 300:
            open_features.append(feature)
            w(f"reset refs/heads/feature/f{feature:04}\nfrom :{tip}\n\n")
        else:
            head = commit("refs/heads/main", [head, tip], [], f"Merge branch 'feature/f{feature:04}'")
            n += 1
w(f"reset refs/remotes/origin/main\nfrom :{head}\n\n")
sys.stderr.write(f"{n} commits, {feature} features, {len(open_features)} open, {tags} tags\n")
open(sys.argv[3], "w").write("\n".join(f"feature/f{f:04}" for f in open_features))
