#!/usr/bin/env python3
"""Static + simulated checks for .github/workflows/build-apk.yml  (needs PyYAML; keytool optional).
Run:  python3 tests/check-workflow.py
It does NOT run GitHub Actions or the Android toolchain. It verifies structure, bash/python syntax,
and executes the keystore / version / themes / signing-loop steps against fake inputs and fake build-tools."""
import json, os, re, shutil, stat, subprocess, sys, tempfile, textwrap
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF = os.path.join(ROOT, ".github", "workflows", "build-apk.yml")
text = open(WF, encoding="utf-8").read()
d = yaml.safe_load(text)
job = d["jobs"]["build"]
steps = {s.get("name"): s for s in job["steps"]}
fails = []

def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(extra)))
    if not cond: fails.append(name)

trig = d.get("on", d.get(True))
check("triggers: workflow_dispatch + push tags v*", set(trig) == {"workflow_dispatch", "push"} and trig["push"]["tags"] == ["v*"])
check("arch options + default", trig["workflow_dispatch"]["inputs"]["arch"]["options"] == ["aarch64", "armv7", "x86_64", "all"] and trig["workflow_dispatch"]["inputs"]["arch"]["default"] == "aarch64")
check("permissions contents: write", d["permissions"] == {"contents": "write"})
check("runs-on is ubuntu-24.04 (not latest)", job["runs-on"] == "ubuntu-24.04" and "ubuntu-latest" not in text)
uses = [s["uses"] for s in job["steps"] if "uses" in s]
check("does not use android-actions/setup-android", not any("setup-android" in u for u in uses))
check("no global npm install of the CLI", not re.search(r"npm\s+(i|install)\s+(-g|--global)", text))
check("tauri CLI installed with cargo, guarded by command -v", "command -v cargo-tauri" in steps["Install Tauri CLI via cargo"]["run"] and 'cargo install tauri-cli --version "^2" --locked' in steps["Install Tauri CLI via cargo"]["run"])
check("all tauri commands use `cargo tauri`", all(re.search(r"\bcargo tauri\b", s.get("run", "")) for n, s in steps.items() if re.search(r"\btauri (icon|android|--version)", s.get("run", ""))))
check("rust targets: all four android", all(t in steps["Install Rust (stable) with Android targets"]["with"]["targets"] for t in ["aarch64-linux-android", "armv7-linux-androideabi", "i686-linux-android", "x86_64-linux-android"]))
check("Java 17 temurin", [s for s in job["steps"] if s.get("uses", "").startswith("actions/setup-java")][0]["with"] == {"distribution": "temurin", "java-version": "17"})
sdk = steps["Install Android SDK components"]["run"]
check("sdk packages", all(p in sdk for p in ['"platform-tools"', "platforms;android-34", "platforms;android-35", "build-tools;34.0.0", "ndk;${NDK_VERSION}"]) and d["env"]["NDK_VERSION"] == "26.1.10909125")
check("NDK_HOME & ANDROID_NDK_HOME exported to GITHUB_ENV", 'NDK_HOME=$NDK" >> "$GITHUB_ENV"' in sdk and 'ANDROID_NDK_HOME=$NDK" >> "$GITHUB_ENV"' in sdk)
names = [s.get("name") for s in job["steps"]]
order = ["Generate icons", "Init Android project", "Dark window background (optional)", "Build APK", "Align and sign APK", "Upload APK artifact"]
idx = [names.index(n) for n in order]
check("step order icon -> init -> themes -> build -> sign -> upload", idx == sorted(idx))
check("release step only on v* tags", "refs/tags/v" in steps["Attach APK to GitHub Release"]["if"] and steps["Attach APK to GitHub Release"]["uses"].startswith("softprops/action-gh-release"))
check("keystore alias fixed", d["env"]["KEY_ALIAS"] == "myscale")
check("secrets named as requested", "ANDROID_KEYSTORE_B64" in text and "ANDROID_KEYSTORE_PASSWORD" in text)

# ---- bash -n on every run block
bad = 0
for n, s in steps.items():
    r = s.get("run")
    if not r: continue
    r2 = re.sub(r"\$\{\{.*?\}\}", "X", r)
    p = tempfile.mktemp(suffix=".sh"); open(p, "w").write(r2)
    res = subprocess.run(["bash", "-n", p], capture_output=True, text=True); os.unlink(p)
    if res.returncode: bad += 1; print("   bash -n error in", n, res.stderr)
check("bash -n passes for every run block", bad == 0)

def run_step(name, env=None, cwd=None, subs=None):
    r = steps[name]["run"]
    for k, v in (subs or {}).items(): r = r.replace(k, v)
    r = re.sub(r"\$\{\{.*?\}\}", "X", r)
    e = dict(os.environ); e.update(env or {})
    return subprocess.run(["bash", "-eo", "pipefail", "-c", r], cwd=cwd, env=e, capture_output=True, text=True)

tmp = tempfile.mkdtemp()
try:
    # ---- version-from-tag
    os.makedirs(os.path.join(tmp, "src-tauri"))
    shutil.copy(os.path.join(ROOT, "src-tauri", "tauri.conf.json"), os.path.join(tmp, "src-tauri"))
    r = run_step("Use tag as app version", {"GITHUB_REF_NAME": "v1.2.3"}, tmp)
    ver = json.load(open(os.path.join(tmp, "src-tauri", "tauri.conf.json")))["version"]
    check("tag v1.2.3 -> tauri.conf.json version 1.2.3 (and file stays valid JSON)", r.returncode == 0 and ver == "1.2.3", r.stderr)
    r = run_step("Use tag as app version", {"GITHUB_REF_NAME": "v-beta"}, tmp)
    check("non-semver tag keeps version", r.returncode == 0 and json.load(open(os.path.join(tmp, "src-tauri", "tauri.conf.json")))["version"] == "1.2.3")

    # ---- themes.xml patch
    res_dir = os.path.join(tmp, "src-tauri/gen/android/app/src/main/res/values")
    os.makedirs(res_dir)
    xml = '<resources>\n  <style name="Theme.myscale" parent="Theme.MaterialComponents.DayNight.NoActionBar">\n  </style>\n</resources>\n'
    open(os.path.join(res_dir, "themes.xml"), "w").write(xml)
    r = run_step("Dark window background (optional)", cwd=tmp)
    out = open(os.path.join(res_dir, "themes.xml")).read()
    check("themes.xml gets dark windowBackground, still well-formed XML", r.returncode == 0 and "#FF0B0D14" in out and __import__("xml.dom.minidom").dom.minidom.parseString(out) is not None, r.stderr)
    r = run_step("Dark window background (optional)", cwd=tmp)
    check("themes patch is idempotent", open(os.path.join(res_dir, "themes.xml")).read().count("myscale-dark") == 1)
    shutil.rmtree(os.path.join(tmp, "src-tauri/gen"))
    r = run_step("Dark window background (optional)", cwd=tmp)
    check("themes patch skips quietly when file is missing", r.returncode == 0)

    # ---- arch resolution
    for a, expect in [("", "--target aarch64"), ("armv7", "--target armv7"), ("all", "--target aarch64 --target armv7 --target x86_64")]:
        go = os.path.join(tmp, "go"); open(go, "w").close()
        r = run_step("Resolve target architectures", {"INPUT_ARCH": a, "GITHUB_OUTPUT": go}, tmp)
        got = open(go).read()
        check(f"arch '{a or '(tag push)'}' -> {expect}", r.returncode == 0 and f"args={expect}\n" in got, got + r.stderr)
    r = run_step("Resolve target architectures", {"INPUT_ARCH": "mips", "GITHUB_OUTPUT": os.path.join(tmp, "go")}, tmp)
    check("unknown arch fails", r.returncode != 0)

    # ---- keystore generation (needs keytool)
    if shutil.which("keytool"):
        home = os.path.join(tmp, "home"); os.makedirs(home)
        genv = os.path.join(tmp, "genv"); open(genv, "w").close()
        env = {"HOME": home, "GITHUB_ENV": genv, "HAS_KEYSTORE_SECRET": "false", "KEY_ALIAS": "myscale", "RUNNER_TEMP": tmp, "KS_B64": "", "KS_SECRET_PASS": ""}
        r = run_step("Prepare keystore", env, tmp)
        ks = os.path.join(home, ".myscale-keystore", "myscale.keystore")
        listing = subprocess.run(["keytool", "-list", "-keystore", ks, "-storepass", "myscale-auto-key"], capture_output=True, text=True).stdout
        check("auto-generated keystore is valid and uses alias 'myscale'", r.returncode == 0 and "myscale," in listing, r.stderr + listing)
        mtime = os.path.getmtime(ks)
        r = run_step("Prepare keystore", env, tmp)
        check("second run reuses the cached keystore (not regenerated)", r.returncode == 0 and os.path.getmtime(ks) == mtime and "缓存" in open(genv).read())
        # secrets path: base64 of that keystore
        import base64
        env2 = dict(env, HAS_KEYSTORE_SECRET="true", KS_B64=base64.b64encode(open(ks, "rb").read()).decode(), KS_SECRET_PASS="myscale-auto-key", GITHUB_ENV=os.path.join(tmp, "genv2"))
        open(env2["GITHUB_ENV"], "w").close()
        r = run_step("Prepare keystore", env2, tmp)
        k2 = open(os.path.join(tmp, "release.keystore"), "rb").read() if os.path.exists(os.path.join(tmp, "release.keystore")) else b""
        check("secrets path decodes the keystore byte-for-byte", r.returncode == 0 and k2 == open(ks, "rb").read(), r.stderr)
    else:
        print("SKIP keystore tests (keytool not installed)")

    # ---- sign loop with fake build-tools
    ah = os.path.join(tmp, "android"); bt = os.path.join(ah, "build-tools", "34.0.0"); os.makedirs(bt)
    def fake(name, body):
        p = os.path.join(bt, name); open(p, "w").write("#!/usr/bin/env bash\n" + body); os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    fake("zipalign", 'for a; do last="$a"; prev2="$prev"; prev="$a"; done; cp "${@: -2:1}" "${@: -1}"\n')
    fake("apksigner", 'if [ "$1" = sign ]; then while [ $# -gt 0 ]; do [ "$1" = --out ] && out="$2"; last="$1"; shift; done; cp "$last" "$out"; else echo "Verifies"; fi\n')
    work = os.path.join(tmp, "w1"); outd = os.path.join(work, "src-tauri/gen/android/app/build/outputs/apk/universal/release"); os.makedirs(outd)
    open(os.path.join(outd, "app-universal-release-unsigned.apk"), "wb").write(b"PK-fake")
    senv = {"ANDROID_HOME": ah, "RUNNER_TEMP": tmp, "APP_NAME": "MyScale", "KEY_ALIAS": "myscale", "KS_PATH": "x", "KS_PASS": "y", "KS_SOURCE": "test", "HAS_KEYSTORE_SECRET": "true", "GITHUB_STEP_SUMMARY": os.path.join(tmp, "sum.md")}
    r = run_step("Align and sign APK", senv, work, {"${{ steps.arch.outputs.arch }}": "aarch64"})
    check("single APK is delivered as dist/MyScale.apk", r.returncode == 0 and os.path.exists(os.path.join(work, "dist", "MyScale.apk")), r.stdout + r.stderr)
    # no APK -> must fail loudly
    work2 = os.path.join(tmp, "w2"); os.makedirs(os.path.join(work2, "src-tauri/gen/android/app/build/outputs"))
    r = run_step("Align and sign APK", senv, work2, {"${{ steps.arch.outputs.arch }}": "aarch64"})
    check("missing APK fails the step with an error", r.returncode != 0 and "No APK" not in r.stdout and "没有找到" in r.stdout)
    # two APKs -> suffix naming
    work3 = os.path.join(tmp, "w3")
    for flavor in ("arm64", "x86_64"):
        dd = os.path.join(work3, "src-tauri/gen/android/app/build/outputs/apk", flavor, "release"); os.makedirs(dd); open(os.path.join(dd, "a-release-unsigned.apk"), "wb").write(b"PK")
    r = run_step("Align and sign APK", senv, work3, {"${{ steps.arch.outputs.arch }}": "all"})
    check("multiple APKs get distinct names", r.returncode == 0 and sorted(os.listdir(os.path.join(work3, "dist"))) == ["MyScale-arm64.apk", "MyScale-x86_64.apk"], r.stdout + r.stderr)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)
