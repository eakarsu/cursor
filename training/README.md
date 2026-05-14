# Tab model fine-tuning pipeline

A LoRA fine-tuning recipe for a small code model (StarCoder2-3B) on edit-prediction data.
This produces a model that can be served via vLLM/TGI and called from the extension instead of the Claude-Haiku fallback.

## Why this exists

Cursor's "Tab" model is fine-tuned on millions of (context → next-edit) pairs collected from real users. We can't reproduce that dataset, but if you collect your own (telemetry endpoint already records `tabPrediction.shown` / `tabPrediction.accepted`), this pipeline turns it into a usable model.

## Hardware

- ~24 GB VRAM for full LoRA on StarCoder2-3B in bf16. Single H100 / A100 / 4090.
- A 7B base needs ~48 GB or QLoRA.

## Steps

```
cd training
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1. Convert telemetry events from the server's SQLite into JSONL training examples
python prepare_data.py --db ../server/data.db --out data.jsonl

# 2. Train (LoRA, ~2-4h on H100 for ~50k examples)
python train.py --data data.jsonl --base bigcode/starcoder2-3b --out checkpoints/tab-v1

# 3. Serve with vLLM (separate machine / GPU)
vllm serve checkpoints/tab-v1 --port 9000

# 4. Point the extension at it: set aiAssistant.tabModelEndpoint = http://gpu-host:9000/v1
```

## What the dataset rows look like

```jsonl
{"prompt": "<context-before>...\n<cursor>\n<context-after>...", "completion": "<exact insertion>"}
```

## Limitations

- This is a recipe, not a trained model. You need data and GPU time.
- Without enough acceptance signal, the model will overfit to a few users.
- Quality lags Cursor's by years of iteration; treat as a starting point.
