# Bundled models

## pp-doclayout-s.onnx

PP-DocLayout-S, a document-layout detector by PaddlePaddle (PaddleOCR),
<https://huggingface.co/PaddlePaddle/PP-DocLayout-S>, licensed under the
Apache License 2.0 (`LICENSE-Apache-2.0.txt`). ONNX export by stefanj0,
<https://huggingface.co/stefanj0/PP-DocLayout-S-ONNX> (Apache-2.0), unmodified.

Input `image` float32 [1,3,480,480] (resized without keeping the ratio,
ImageNet-normalised) and `scale_factor` [1,2] = [480/height, 480/width];
output [M,6] rows `class, score, x1, y1, x2, y2` in the original pixels and
`num_dets`. 23 classes, listed in `src/shared/layoutDetect.ts`.

Used by the PDF viewer's figure auto-detect (`src/ui/pdfViewer/layoutModel.ts`).

## pix2text-mfr/

pix2text-mfr-1.5, a mathematical-formula recognizer (TrOCR architecture) by
BreezeDeus (Pix2Text), <https://huggingface.co/breezedeus/pix2text-mfr-1.5>
(revision `1cef9f0bdcd6a4c63df7de1311fb0894593340cc`), licensed under the MIT
License (`LICENSE-MIT-Pix2Text.txt`). Modified: the published ONNX encoder and
decoder are rebuilt by `scripts/formula-model/build.sh` — the decoder's
cross-attention key/value projections move into the encoder
(`encoder_kv.onnx`), the decoder is rebuilt from its own weights to take one
token per step with a key/value cache (`decoder_with_past.onnx`, checked
against the original), and both are dynamically quantized to int8.
`tokenizer.json` is unmodified.

`encoder_kv.onnx`: `pixel_values` float32 [1,3,384,384] (RGB on white,
stretched to 384×384, `x/127.5 − 1`) → `cross_k_0..5`, `cross_v_0..5`
[1,578,256]. `decoder_with_past.onnx`: `input_ids` int64 [1,1], the twelve
`cross_*`, `past_k_l` / `past_v_l` [1,8,P,32] (P = 0 at first) → `logits`
[1,1,1868], `present_k_l` / `present_v_l` [1,8,P+1,32]. Start token 1, end 2.

Used by the PDF viewer's formula → LaTeX copy (`src/ui/pdfViewer/formulaOcr.ts`).
