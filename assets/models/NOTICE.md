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
