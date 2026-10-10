# Split the pix2text-mfr decoder so the cross-attention K/V projections of the
# encoder output (constant across decoding steps) run once, inside the encoder model.
#   in : <dir>/encoder_model.onnx, <dir>/decoder_model.onnx
#   out: <out>/encoder_kv.onnx  (pixel_values -> cross_k_{0..5}, cross_v_{0..5})
#        <out>/decoder_step.onnx (input_ids, cross_k_*, cross_v_* -> logits)
import sys, re, onnx
from onnx import helper, TensorProto, compose
src, out = sys.argv[1], sys.argv[2]
dec = onnx.load(f'{src}/decoder_model.onnx')
g = dec.graph
const_like = {i.name for i in g.initializer} | {o for n in g.node if n.op_type == 'Constant' for o in n.output}
enc = {'encoder_hidden_states'}
changed = True
while changed:
    changed = False
    for n in g.node:
        if any(i in enc for i in n.input) and all(i in enc or i in const_like or i == '' for i in n.input):
            for o in n.output:
                if o not in enc: enc.add(o); changed = True
cons = {}
for n in g.node:
    for i in n.input: cons.setdefault(i, []).append(n)
front = sorted(t for t in enc if any(not all(i in enc or i in const_like or i == '' for i in n.input) for n in cons.get(t, [])))
def new_name(t):
    m = re.search(r'layers\.(\d+)/encoder_attn/([kv])_proj', t); return f'cross_{m.group(2)}_{m.group(1)}'
names = {t: new_name(t) for t in front}
enc_nodes = [n for n in g.node if n.output and all(o in enc for o in n.output)]
# Constants used only by encoder-only nodes must travel with them
needed = {i for n in enc_nodes for i in n.input}
enc_const_nodes = [n for n in g.node if n.op_type == 'Constant' and n.output[0] in needed and all(c in enc_nodes for c in cons.get(n.output[0], []))]
moved = set(map(id, enc_nodes + enc_const_nodes))
inits = {i.name: i for i in g.initializer}
# cross_kv subgraph
kv_inits = [inits[i] for i in needed if i in inits]
vi = lambda name: helper.make_tensor_value_info(name, TensorProto.FLOAT, ['batch_size', 'encoder_sequence_length', 256])
kv_nodes = enc_const_nodes + enc_nodes
for n in kv_nodes:
    for k, o in enumerate(n.output):
        if o in names: n.output[k] = names[o]
kv_graph = helper.make_graph(kv_nodes, 'cross_kv',
    [helper.make_tensor_value_info('encoder_hidden_states', TensorProto.FLOAT, ['batch_size', 'encoder_sequence_length', 384])],
    [vi(names[t]) for t in sorted(front, key=names.get)], kv_inits)
kv = helper.make_model(kv_graph, opset_imports=dec.opset_import, ir_version=dec.ir_version)
# decoder_step
rest = [n for n in g.node if id(n) not in moved]
for n in rest:
    for k, i in enumerate(n.input):
        if i in names: n.input[k] = names[i]
used = {i for n in rest for i in n.input}
step_inputs = [x for x in g.input if x.name != 'encoder_hidden_states'] + [vi(names[t]) for t in sorted(front, key=names.get)]
step_graph = helper.make_graph(rest, 'decoder_step', step_inputs, list(g.output), [i for i in g.initializer if i.name in used])
step = helper.make_model(step_graph, opset_imports=dec.opset_import, ir_version=dec.ir_version)
onnx.checker.check_model(step); onnx.checker.check_model(kv)
# merge encoder + cross_kv
e = onnx.load(f'{src}/encoder_model.onnx')
print('encoder opset', [(o.domain, o.version) for o in e.opset_import], 'ir', e.ir_version, '| decoder opset', [(o.domain, o.version) for o in dec.opset_import], 'ir', dec.ir_version)
if e.ir_version != kv.ir_version: kv.ir_version = e.ir_version
kv = compose.add_prefix(kv, 'kv/', rename_inputs=False, rename_outputs=False)
merged = compose.merge_models(e, kv, io_map=[('last_hidden_state', 'encoder_hidden_states')], outputs=[names[t] for t in sorted(front, key=names.get)])
del merged.opset_import[:]
merged.opset_import.extend(e.opset_import)  # merge_models duplicates the default-domain entry
onnx.checker.check_model(merged)
onnx.save(merged, f'{out}/encoder_kv.onnx'); onnx.save(step, f'{out}/decoder_step.onnx')
print('moved nodes', len(kv_nodes), 'outputs', sorted(names.values()))
