# Dynamic int8 quantization (weights int8, activations quantized at runtime).
import sys
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst = sys.argv[1], sys.argv[2]
quantize_dynamic(src, dst, weight_type=QuantType.QInt8 if len(sys.argv) < 4 else QuantType.QUInt8)
