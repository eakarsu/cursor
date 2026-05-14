"""
Fine-tune a small base model on tab-prediction examples (cursor-style).
Expects JSONL with {"messages": [{"role": ..., "content": ...}, ...]} entries.

Run:
    pip install transformers peft datasets accelerate bitsandbytes torch
    python train.py --base meta-llama/Llama-3.2-1B --data ./data/edits.jsonl --out ./out/lora
"""
import argparse
import json

import torch
from datasets import Dataset
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments


def load_jsonl(path: str) -> list[dict]:
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="meta-llama/Llama-3.2-1B")
    p.add_argument("--data", required=True)
    p.add_argument("--out", default="./out/lora")
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--bs", type=int, default=2)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-len", type=int, default=4096)
    args = p.parse_args()

    tok = AutoTokenizer.from_pretrained(args.base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    raw = load_jsonl(args.data)

    def render(ex: dict) -> dict:
        text = tok.apply_chat_template(ex["messages"], tokenize=False, add_generation_prompt=False)
        ids = tok(text, truncation=True, max_length=args.max_len, padding="max_length")
        ids["labels"] = ids["input_ids"].copy()
        return ids

    ds = Dataset.from_list(raw).map(render, remove_columns=["messages"])

    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype=torch.float16)
    lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
                      target_modules=["q_proj", "k_proj", "v_proj", "o_proj"])
    model = get_peft_model(model, lora)

    targs = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.bs,
        learning_rate=args.lr,
        logging_steps=20,
        save_strategy="epoch",
        bf16=torch.cuda.is_available(),
        report_to="none",
    )
    Trainer(model=model, args=targs, train_dataset=ds).train()
    model.save_pretrained(args.out)
    tok.save_pretrained(args.out)


if __name__ == "__main__":
    main()
