"""
OpenAI-compatible serving endpoint for the fine-tuned tab prediction model.

Run:
    pip install fastapi uvicorn transformers peft torch
    python serve.py --base meta-llama/Llama-3.2-1B --lora ./out/lora --port 8088

Then in VS Code settings:
    "aiAssistant.tabModelEndpoint": "http://127.0.0.1:8088/v1"
"""
import argparse
import json
import time
import uuid
from typing import Any

import torch
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from peft import PeftModel
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer
import uvicorn


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "tab"
    messages: list[ChatMessage]
    max_tokens: int = 256
    temperature: float = 0.2
    stream: bool = False


def load_model(base: str, lora: str | None, device: str) -> tuple[Any, Any]:
    tok = AutoTokenizer.from_pretrained(base)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.float16 if device == "cuda" else torch.float32)
    if lora:
        model = PeftModel.from_pretrained(model, lora)
    model.to(device).eval()
    return tok, model


def format_prompt(tok: Any, messages: list[ChatMessage]) -> str:
    if hasattr(tok, "apply_chat_template"):
        return tok.apply_chat_template(
            [{"role": m.role, "content": m.content} for m in messages],
            tokenize=False,
            add_generation_prompt=True,
        )
    return "\n".join(f"[{m.role}]\n{m.content}" for m in messages) + "\n[assistant]\n"


def make_app(tok: Any, model: Any, device: str) -> FastAPI:
    app = FastAPI()

    @app.get("/v1/models")
    def list_models() -> dict:
        return {"data": [{"id": "tab", "object": "model"}]}

    @app.post("/v1/chat/completions")
    def chat(req: ChatRequest) -> Any:
        prompt = format_prompt(tok, req.messages)
        inputs = tok(prompt, return_tensors="pt").to(device)
        with torch.no_grad():
            out = model.generate(
                **inputs,
                max_new_tokens=req.max_tokens,
                temperature=max(req.temperature, 1e-5),
                do_sample=req.temperature > 0,
                pad_token_id=tok.pad_token_id,
            )
        text = tok.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

        rid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        if req.stream:
            def gen() -> Any:
                payload = {
                    "id": rid, "object": "chat.completion.chunk", "created": created, "model": req.model,
                    "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                }
                yield f"data: {json.dumps(payload)}\n\n"
                done = {
                    "id": rid, "object": "chat.completion.chunk", "created": created, "model": req.model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                yield f"data: {json.dumps(done)}\n\n"
                yield "data: [DONE]\n\n"
            return StreamingResponse(gen(), media_type="text/event-stream")

        return {
            "id": rid, "object": "chat.completion", "created": created, "model": req.model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        }

    return app


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="meta-llama/Llama-3.2-1B")
    p.add_argument("--lora", default=None)
    p.add_argument("--port", type=int, default=8088)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = p.parse_args()

    tok, model = load_model(args.base, args.lora, args.device)
    app = make_app(tok, model, args.device)
    uvicorn.run(app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
