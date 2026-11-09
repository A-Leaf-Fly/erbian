#!/usr/bin/env bash
# 耳边 · 本地版 APK 构建（内置 Node 运行时，无 Gradle）
# 产物: 耳边-本地版-2.3.0.apk
set -e
cd "$(dirname "$0")"

SDK="${ANDROID_SDK:-/path/to/android-sdk}"   # 含 build-tools/34.0.0、platforms/android-34、ndk/26.x
BT="$SDK/build-tools/34.0.0"
AJ="$SDK/platforms/android-34/android.jar"
NDK="$(ls -d "$SDK"/ndk/*/toolchains/llvm/prebuilt/* 2>/dev/null | head -1)"
CXX="$NDK/bin/aarch64-linux-android23-clang++"
NODEDIR="${NODE_ANDROID_SO:-/path/to/node-android}"  # 需包含 libnode18-arm64.so
PROJ="$(cd .. && pwd)"

export JAVA_HOME="${JAVA_HOME:-/path/to/jdk17}"
export PATH="$JAVA_HOME/bin:$PATH"

VER_CODE=12
VER_NAME=2.5.3
ABI=arm64-v8a
LIBDIR="jniLibs/$ABI"
OUT=out

# 便携工具
PY=python

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" assets/node "$LIBDIR"

echo "[1/7] 收集 assets（页面 + 服务端 + 依赖）"
cp "$PROJ/listen.html" assets/node/
cp "$PROJ/listen-server.js" assets/node/
rm -rf assets/node/node_modules
mkdir -p assets/node/node_modules
cp -r "$PROJ/node_modules/abogus" assets/node/node_modules/
cp "$PROJ/package.json" assets/node/ 2>/dev/null || true
du -sh assets/node | awk '{print "      assets 体积: "$1}'

echo "[2/7] 放置运行时库"
[ -f "$LIBDIR/libnode.so" ] || cp "$NODEDIR/libnode18-arm64.so" "$LIBDIR/libnode.so"
[ -f "$LIBDIR/libc++_shared.so" ] || cp "$NDK/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" "$LIBDIR/"
ls -lh "$LIBDIR" | awk 'NR>1{printf "      %-22s %s\n", $9, $5}'

echo "[3/7] 编译 JNI 胶水层"
"$CXX" -shared -fPIC -O2 -std=c++17 \
  -o "$LIBDIR/libnodestart.so" \
  native/native-lib.cpp \
  -L "$LIBDIR" -lnode -llog -landroid \
  -Wl,-soname,libnodestart.so
"$NDK/bin/llvm-strip.exe" --strip-unneeded "$LIBDIR/libnodestart.so" 2>/dev/null || true

echo "[4/7] aapt2 compile/link"
"$BT/aapt2.exe" compile --dir res -o "$OUT/res.zip"
"$BT/aapt2.exe" link -o "$OUT/base.apk" -I "$AJ" \
  --manifest AndroidManifest.xml -R "$OUT/res.zip" --java "$OUT/gen" \
  -A assets --auto-add-overlay \
  --min-sdk-version 23 --target-sdk-version 34 \
  --version-code "$VER_CODE" --version-name "$VER_NAME"

echo "[5/7] javac + d8"
find src "$OUT/gen" -name "*.java" > "$OUT/sources.txt"
javac -encoding UTF-8 --release 11 -cp "$AJ" -d "$OUT/classes" @"$OUT/sources.txt"
find "$OUT/classes" -name "*.class" > "$OUT/classes.txt"
"$BT/d8.bat" --lib "$AJ" --min-api 23 --output "$OUT/dex" @"$OUT/classes.txt" >/dev/null

echo "[6/7] 打包 dex + .so（deflate 压缩，装机时解压）"
"$PY" - "$OUT/base.apk" "$OUT/dex/classes.dex" "$LIBDIR" "$ABI" <<'PY'
import os, sys, zipfile
apk, dex, libdir, abi = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    z.write(dex, 'classes.dex')
    for name in sorted(os.listdir(libdir)):
        if not name.endswith('.so'):
            continue
        p = os.path.join(libdir, name)
        with open(p, 'rb') as f:
            data = f.read()
        zi = zipfile.ZipInfo('lib/%s/%s' % (abi, name), date_time=(2026, 1, 1, 0, 0, 0))
        zi.compress_type = zipfile.ZIP_DEFLATED
        zi.external_attr = 0o644 << 16
        z.writestr(zi, data)
        print('      + lib/%s/%s  %.1f MB -> %.1f MB' % (abi, name, len(data)/1048576, 0))
PY

echo "[7/7] zipalign + 签名"
"$BT/zipalign.exe" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
APK="耳边-本地版-$VER_NAME.apk"
# 签名密码从环境变量读取，不写入仓库：
#   export KS_PASS=你的密码
if [ -z "$KS_PASS" ]; then
  echo "[ERROR] 未设置 KS_PASS 环境变量（keystore 密码）。示例: export KS_PASS=your-password"
  exit 1
fi
if [ ! -f erbian.jks ]; then
  keytool -genkeypair -keystore erbian.jks -alias erbian -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Erbian, OU=Personal, O=Erbian, C=CN"
fi
"$BT/apksigner.bat" sign --ks erbian.jks --ks-pass "pass:$KS_PASS" \
  --key-pass "pass:$KS_PASS" --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner.bat" verify "$APK"

ls -lh "$APK" | awk '{print "DONE -> "$9"  "$5}'
