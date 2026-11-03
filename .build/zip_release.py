"""把 release/阅卷助理-win32-x64 目录重新打成 zip，并校验条目数与 md5"""
import os, zipfile, hashlib, sys

SRC = os.path.join("release", "阅卷助理-win32-x64")
ZIP = os.path.join("release", "阅卷助理-win32-x64.zip")

names = []
for root, dirs, files in os.walk(SRC):
    for f in files:
        p = os.path.join(root, f)
        names.append(os.path.relpath(p, os.path.dirname(SRC)))
names.sort()

if os.path.exists(ZIP):
    os.remove(ZIP)

with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel in names:
        z.write(os.path.join(os.path.dirname(SRC), rel), rel)

h = hashlib.md5(open(ZIP, "rb").read()).hexdigest()
size = os.path.getsize(ZIP)
with zipfile.ZipFile(ZIP) as z:
    bad = z.testzip()
    n = len(z.namelist())
mib = size / 1048576
print(f"entries={n} (files={len(names)}) size={mib:.2f}MiB md5={h} testzip={bad}")
# GitHub 单文件上限 100MiB，超了就传不上 Releases
LIMIT = 100 * 1024 * 1024
if size > LIMIT:
    print(f"超出 GitHub 单文件上限：{mib:.2f}MiB > 100MiB，请精简 locales 等大文件")
    sys.exit(1)
print(f"在 100MiB 上限内（余量 {(LIMIT-size)/1048576:.2f}MiB）")
