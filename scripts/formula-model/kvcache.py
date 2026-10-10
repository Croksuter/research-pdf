# Build a KV-cached, one-token-per-step decoder for breezedeus/pix2text-mfr(-1.5)
# from the weights inside the published decoder_model.onnx (the PyTorch weights
# are not public), check it against the original decoder, and export it.
#
#   python kvcache.py <src_dir with decoder_model.onnx + config.json> <out_dir>
#   -> <out_dir>/decoder_with_past.onnx
#      inputs : input_ids int64 [B,1]
#               cross_k_{0..L-1}, cross_v_{0..L-1} float32 [B,S_enc,D]  (from encoder_kv.onnx)
#               past_k_{0..L-1},  past_v_{0..L-1}  float32 [B,H,P,D/H]   (P = 0 on the first step)
#      outputs: logits float32 [B,1,V]; present_k_*, present_v_* float32 [B,H,P+1,D/H]
import json, sys, math
import numpy as np, onnx, torch, onnxruntime as ort
from onnx import numpy_helper

src, out = sys.argv[1], sys.argv[2]
cfg = json.load(open(f'{src}/config.json'))['decoder']
D, H, L, V = cfg['d_model'], cfg['decoder_attention_heads'], cfg['decoder_layers'], cfg['vocab_size']
HD = D // H
m = onnx.load(f'{src}/decoder_model.onnx')
inits = {i.name: numpy_helper.to_array(i) for i in m.graph.initializer}
W = {k: v for k, v in inits.items() if not k.startswith('onnx::')}
for n in m.graph.node:  # anonymous MatMul weights: name them after their node ([in, out] layout)
    if n.op_type == 'MatMul':
        for i in n.input:
            if i in inits and i.startswith('onnx::'):
                W[n.name.replace('/decoder/decoder/', 'decoder.model.decoder.').replace('/decoder/output_projection', 'decoder.output_projection').replace('/MatMul', '.W').replace('/', '.')] = inits[i]
P = 'decoder.model.decoder.'
T = lambda k: torch.from_numpy(np.ascontiguousarray(W[k]))
assert cfg.get('scale_embedding') and cfg.get('layernorm_embedding') and cfg['activation_function'] == 'relu'


class Step(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.p = torch.nn.ParameterDict()
        for k in W:
            self.p[k.replace('.', '__')] = torch.nn.Parameter(T(k), requires_grad=False)

    def w(self, k):
        return self.p[k.replace('.', '__')]

    def lin(self, x, pre):
        return x @ self.w(pre + '.W') + self.w(pre + '.bias')

    def ln(self, x, pre):
        return torch.nn.functional.layer_norm(x, (D,), self.w(pre + '.weight'), self.w(pre + '.bias'), 1e-5)

    def heads(self, x):  # [B,S,D] -> [B,H,S,HD]
        return x.reshape(x.shape[0], x.shape[1], H, HD).transpose(1, 2)

    def attend(self, q, k, v):  # q [B,H,1,HD] (already scaled)
        a = torch.softmax(q @ k.transpose(-1, -2), dim=-1) @ v
        return a.transpose(1, 2).reshape(q.shape[0], 1, D)

    def forward(self, input_ids, *kv):
        cross, past = kv[:2 * L], kv[2 * L:]
        pos = past[0].shape[2] + 2  # TrOCRLearnedPositionalEmbedding offset = 2
        x = self.w(P + 'embed_tokens.weight')[input_ids] * math.sqrt(D)
        x = x + self.w(P + 'embed_positions.weight')[pos].reshape(1, 1, D)
        x = self.ln(x, P + 'layernorm_embedding')
        presents = []
        for l in range(L):
            pre = f'{P}layers.{l}.'
            q = self.heads(self.lin(x, pre + 'self_attn.q_proj') * HD ** -0.5)
            k = torch.cat([past[2 * l], self.heads(self.lin(x, pre + 'self_attn.k_proj'))], dim=2)
            v = torch.cat([past[2 * l + 1], self.heads(self.lin(x, pre + 'self_attn.v_proj'))], dim=2)
            presents += [k, v]
            x = self.ln(x + self.lin(self.attend(q, k, v), pre + 'self_attn.out_proj'), pre + 'self_attn_layer_norm')
            q = self.heads(self.lin(x, pre + 'encoder_attn.q_proj') * HD ** -0.5)
            x = self.ln(x + self.lin(self.attend(q, self.heads(cross[2 * l]), self.heads(cross[2 * l + 1])), pre + 'encoder_attn.out_proj'), pre + 'encoder_attn_layer_norm')
            h = torch.relu(self.lin(x, pre + 'fc1'))
            x = self.ln(x + self.lin(h, pre + 'fc2'), pre + 'final_layer_norm')
        logits = x @ self.w('decoder.output_projection.W')
        return (logits, *presents)


step = Step().eval()

# ── check against the original decoder on a random encoder state + a token sequence
rng = np.random.default_rng(0)
enc = rng.standard_normal((1, 578, inits[[n.input[1] for n in m.graph.node if n.name.endswith('layers.0/encoder_attn/k_proj/MatMul')][0]].shape[0])).astype(np.float32)
orig = ort.InferenceSession(f'{src}/decoder_model.onnx', providers=['CPUExecutionProvider'])
ids = [1, 5, 61, 300, 77, 1000, 20, 64, 33, 12, 13]
with torch.no_grad():
    e = torch.from_numpy(enc)
    cross = []
    for l in range(L):
        pre = f'{P}layers.{l}.encoder_attn.'
        cross += [step.lin(e, pre + 'k_proj'), step.lin(e, pre + 'v_proj')]
    past = [torch.zeros(1, H, 0, HD) for _ in range(2 * L)]
    worst = 0
    for t in range(len(ids)):
        outs = step(torch.tensor([[ids[t]]]), *cross, *past)
        past = list(outs[1:])
        ref = orig.run(None, {'input_ids': np.array([ids[:t + 1]], dtype=np.int64), 'encoder_hidden_states': enc})[0][0, -1]
        worst = max(worst, float(np.abs(outs[0][0, -1].numpy() - ref).max()))
print(f'max |logit diff| vs original decoder over {len(ids)} steps: {worst:.2e}')
assert worst < 1e-3

names_in = ['input_ids'] + [f'cross_{kv}_{l}' for l in range(L) for kv in 'kv'] + [f'past_{kv}_{l}' for l in range(L) for kv in 'kv']
names_out = ['logits'] + [f'present_{kv}_{l}' for l in range(L) for kv in 'kv']
dyn = {'input_ids': {0: 'batch'}, 'logits': {0: 'batch'}}
for l in range(L):
    for kv in 'kv':
        dyn[f'cross_{kv}_{l}'] = {0: 'batch', 1: 'encoder_sequence_length'}
        dyn[f'past_{kv}_{l}'] = {0: 'batch', 2: 'past_sequence_length'}
        dyn[f'present_{kv}_{l}'] = {0: 'batch', 2: 'past_sequence_length_plus_1'}
example = (torch.tensor([[1]]), *[c for c in cross], *[torch.zeros(1, H, 3, HD) for _ in range(2 * L)])
torch.onnx.export(step, example, f'{out}/decoder_with_past.onnx', input_names=names_in, output_names=names_out,
                  dynamic_axes=dyn, opset_version=17, dynamo=False, do_constant_folding=True)
mm = onnx.load(f'{out}/decoder_with_past.onnx')
onnx.checker.check_model(mm)
print('exported', [i.name for i in mm.graph.input][:3], '...', len(mm.graph.input), 'inputs,', len(mm.graph.output), 'outputs')
