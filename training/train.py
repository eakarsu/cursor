"""LoRA fine-tune a small code model on edit-prediction pairs.

Usage:
  python train.py --data data.jsonl --base bigcode/starcoder2-3b --out ckpt
"""
import argparse
import json
from pathlib import Path

from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)


def format_example(ex: dict, tokenizer) -> dict:
    text = ex["prompt"] + ex["completion"]
    enc = tokenizer(text, truncation=True, max_length=2048)
    enc["labels"] = enc["input_ids"].copy()
    return enc


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", required=True)
    p.add_argument("--base", default="bigcode/starcoder2-3b")
    p.add_argument("--out", default="checkpoints/tab-v1")
    p.add_argument("--batch", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--epochs", type=float, default=1.0)
    args = p.parse_args()

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.base, torch_dtype="bfloat16", device_map="auto")

    lora = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora)

    ds = load_dataset("json", data_files=args.data, split="train")
    ds = ds.map(lambda ex: format_example(ex, tokenizer), remove_columns=ds.column_names)

    args_t = TrainingArguments(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        bf16=True,
        logging_steps=20,
        save_steps=500,
        save_total_limit=2,
        report_to=[],
    )
    trainer = Trainer(
        model=model,
        args=args_t,
        train_dataset=ds,
        data_collator=DataCollatorForLanguageModeling(tokenizer, mlm=False),
    )
    trainer.train()
    trainer.save_model(args.out)
    Path(args.out).joinpath("training_meta.json").write_text(
        json.dumps({"base": args.base, "examples": len(ds), "lr": args.lr}, indent=2)
    )


if __name__ == "__main__":
    main()
