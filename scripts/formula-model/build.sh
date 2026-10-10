#!/usr/bin/env bash
# Build the browser-ready pix2text-mfr-1.5 package (int8, KV-cached) from the
# published HF files. Build-time only (Python: onnx, onnxruntime, torch CPU).
#   build.sh <python> <work_dir> <out_dir>
set -euo pipefail
PY=$1; WORK=$2; OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
REV=1cef9f0bdcd6a4c63df7de1311fb0894593340cc
BASE=https://huggingface.co/breezedeus/pix2text-mfr-1.5/resolve/$REV
mkdir -p "$WORK/src" "$WORK/fp32" "$OUT"
for f in encoder_model.onnx decoder_model.onnx config.json tokenizer.json; do
  [ -s "$WORK/src/$f" ] || curl -sfL -o "$WORK/src/$f" "$BASE/$f"
done
echo "080a3f660f08bc9ebcacdd96e34be6b6400f8c7e62d7cd0dd8251badc37f610b  $WORK/src/encoder_model.onnx
917deb98e91a0453c5f234f58a0f32f9fb037de8527c7eb4ed394daf9e692f2a  $WORK/src/decoder_model.onnx" | sha256sum -c -
"$PY" -I "$HERE/hoist.py"   "$WORK/src" "$WORK/fp32"            # encoder_kv.onnx (+ decoder_step.onnx)
"$PY" -I "$HERE/kvcache.py" "$WORK/src" "$WORK/fp32"            # decoder_with_past.onnx (checked vs original)
"$PY" -I "$HERE/quant.py"   "$WORK/fp32/encoder_kv.onnx"        "$OUT/encoder_kv.onnx"
"$PY" -I "$HERE/quant.py"   "$WORK/fp32/decoder_with_past.onnx" "$OUT/decoder_with_past.onnx"
cp "$WORK/src/config.json" "$WORK/src/tokenizer.json" "$OUT/"
ls -l "$OUT"; sha256sum "$OUT"/*.onnx
